import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { killTree, spawnCommon } from './proc.js';
import { StringDecoder } from 'string_decoder';
import { providerEnv } from './providers.js';
import { setBusy } from './awake.js';
import { materializeCursorAttachments } from './cursor-uploads.js';
import { hasLocalHermes, hermesBin, hermesRemote, remoteFetch, runDb } from './hermes.js';
import { ocFetch, ocFetchRaw, ocMcp, parseOcModel } from './opencode.js';

const AGENT_BIN = process.env.COCKPIT_AGENT_BIN || 'agent';

const syncBusy = () => setBusy([...chats.values()].some(e => !e.done));

// Chat turns run as DETACHED processes writing stream-json to disk. The server
// only tails those files, so restarting (or closing) the server never kills a
// turn, and a fresh server can re-discover and resume streaming live turns.
const CHAT_DIR = path.join(os.homedir(), '.claude-cockpit', 'chats');
const EXTRA_PROMPT_FILE = path.join(os.homedir(), '.claude-cockpit', 'system-prompt.md');

//每轮都是独立的 `claude -p` 进程，跑完即退出：没有任何机制会在后台任务完成时
// 重新唤起模型。不把这条讲清楚，模型会按交互式的习惯「先挂后台、回头再报」，
// 而那个「回头」永远不会到来。
const COCKPIT_RULES = `你运行在 Claude Cockpit 里：本轮是一个独立的无头进程（claude -p），\
本轮结束后不会有任何后续轮次自动发生——没有后台任务完成通知，没有人会把你重新唤醒，\
你挂到后台的进程也可能随本轮结束而失去归属。

例外：/goal 目标模式不受此限——goal 的多轮继续由 Claude Code 自身的评估器驱动，\
在同一个进程内自动发生，放心按目标推进即可。

因此：
- 绝对不要以"我先放后台跑，好了再给你"、"稍后把结果发你"之类的承诺结束本轮。那个"稍后"不存在，用户只会看到一段没有下文的话。
- 需要等待的工作（渲染、构建、下载、长命令），就在本轮内前台等它完成：直接等待命令返回，或用轮询/sleep 循环守到有结果为止，然后把结果一并交付。
- 如果确实超出单轮能承受的时长，就用现有进展收尾，并明确写出：已经做完什么、产物在哪、用户下一步该发什么消息或跑什么命令来接上。宁可交付一半并说清楚，也不要留一个空承诺。
- 用户随时可以发下一条消息，所以"请你发'继续'我就接着做"是可以的；"我自己回头告诉你"不行。`;

function buildSystemPrompt() {
  let extra = '';
  try { extra = fs.readFileSync(EXTRA_PROMPT_FILE, 'utf8').trim(); } catch { /* optional */ }
  return extra ? COCKPIT_RULES + '\n\n' + extra : COCKPIT_RULES;
}
const POLL_MS = 250;
const RETAIN_MS = 60 * 60 * 1000;

const chats = new Map(); // ch -> entry
const doneListeners = new Set();

// Transient failures (dropped stream, gateway hiccup, laptop sleep) leave the
// turn half-done. The session file already holds the context, so resuming with a
// "keep going" prompt recovers it. Permanent failures must NOT be retried.
const RETRYABLE = /connection (closed|error|reset)|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|went to sleep|overloaded|stream (ended|interrupted|closed)|internal server error|\b(502|503|504)\b|timed? ?out/i;
const NOT_RETRYABLE = /maximum request body size|rate limit|limit reached|usage limit|reached your [^.]{0,40}limit|run \/usage|invalid api key|unauthorized|forbidden|insufficient|quota|credit/i;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [4000, 12000];
const CONTINUE_PROMPT = '上一轮回复因连接中断而截断。请从中断处继续把这件事做完，'
  + '不要重复已经完成的部分，也不要重新开始；如果上一轮其实已经做完了，就简短总结结果即可。';

function shouldRetry(e, code) {
  if (e.engine === 'opencode') return false;
  const cfg = readRetryCfg();
  if (cfg.autoRetry === false) return false;
  if ((e.retries || 0) >= MAX_RETRIES) return false;
  const text = `${e.result?.text || ''} ${e.stderrTail || ''}`;
  if (NOT_RETRYABLE.test(text)) return false;
  if (RETRYABLE.test(text)) return true;
  // 4xx 是请求本身的问题(参数/权限)，重试只会原样再错一遍——glm-5.3 的 400 踩过
  if (/\b4\d{2}\b/.test(text)) return false;
  // 进程被信号打断(非用户主动停止)也算抖动
  return code !== 0 && code !== 143 && /error/i.test(text);
}

function readRetryCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-cockpit', 'config.json'), 'utf8')); }
  catch { return {}; }
}

// global hook so the server can notify on completion regardless of who is watching
export function onChatDone(fn) { doneListeners.add(fn); return () => doneListeners.delete(fn); }

const outPath = (ch) => path.join(CHAT_DIR, ch + '.out');
const errPath = (ch) => path.join(CHAT_DIR, ch + '.err');
const metaPath = (ch) => path.join(CHAT_DIR, ch + '.json');

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function writeMeta(e) {
  try {
    fs.writeFileSync(metaPath(e.ch), JSON.stringify({
      ch: e.ch, pid: e.pid, sessionId: e.sessionId, cwd: e.cwd, model: e.model,
      engine: e.engine || 'claude',
      startedAt: e.startedAt, done: e.done ? { code: e.done.code } : null,
    }));
  } catch { /* disk hiccup: state is still in memory */ }
}

function createCursorChat(cwd) {
  const id = execFileSync(AGENT_BIN, ['create-chat'], {
    cwd: cwd || os.homedir(),
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  }).trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('create-chat 返回异常: ' + id.slice(0, 80));
  return id;
}

function emit(e, msg) {
  e.buffer.push(msg);
  for (const fn of e.subs) { try { fn(msg); } catch { /* subscriber died */ } }
}

function drain(e) {
  let size;
  try { size = fs.statSync(outPath(e.ch)).size; } catch { return; }
  if (size <= e.offset) return;
  let chunk;
  try {
    const fd = fs.openSync(outPath(e.ch), 'r');
    try {
      const buf = Buffer.alloc(size - e.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, e.offset);
      // read boundaries land mid-multibyte-char 2/3 of the time on Chinese text;
      // a plain toString() would emit U+FFFD pairs at every boundary. The decoder
      // holds partial bytes until the rest arrives.
      if (!e.decoder) e.decoder = new StringDecoder('utf8');
      chunk = e.decoder.write(n === buf.length ? buf : buf.subarray(0, n));
      e.offset += n;
      e.lastGrowthAt = Date.now();
    } finally { fs.closeSync(fd); }
  } catch { return; }
  const lines = (e.rest + chunk).split('\n');
  e.rest = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.session_id && event.session_id !== e.sessionId) {
      e.sessionId = event.session_id;
      writeMeta(e);
    }
    // keep a one-line "what is it doing now" for the monitoring view
    if (event.type === 'assistant') {
      for (const b of event.message?.content || []) {
        if (b.type === 'tool_use') e.activity = { kind: 'tool', name: b.name, at: Date.now() };
        else if (b.type === 'text' && b.text?.trim()) e.activity = { kind: 'text', name: b.text.trim().slice(0, 60), at: Date.now() };
      }
    } else if (event.type === 'thinking' && event.subtype === 'delta' && event.text?.trim()) {
      e.activity = { kind: 'text', name: event.text.trim().slice(0, 60), at: Date.now() };
    }
    if (event.type === 'result') {
      e.result = {
        subtype: event.subtype, isError: !!event.is_error,
        cost: event.total_cost_usd, durationMs: event.duration_ms,
        text: typeof event.result === 'string' ? event.result.slice(0, 200) : '',
      };
    }
    emit(e, { kind: 'event', event });
  }
}

function finish(e, code) {
  if (e.done) return;
  drain(e);
  let stderr = '';
  try { stderr = fs.readFileSync(errPath(e.ch), 'utf8').slice(-4000).trim(); } catch { /* no stderr file */ }
  e.stderrTail = stderr;
  e.done = { code, stderr };
  e.finishedAt = Date.now();
  if (e.timer) { clearInterval(e.timer); e.timer = null; }
  writeMeta(e);

  // decide BEFORE announcing: a "done" would make the client tear the turn down,
  // and the retry notice arriving afterwards would have nothing to attach to
  const failedTransiently = (code !== 0 || e.result?.isError) && shouldRetry(e, code);
  if (failedTransiently) {
    const attempt = (e.retries || 0) + 1;
    const wait = RETRY_BACKOFF_MS[attempt - 1] || 12000;
    e.retryPending = true;
    for (const fn of e.subs) {
      try { fn({ kind: 'retry', attempt, max: MAX_RETRIES, waitMs: wait }); } catch { /* gone */ }
    }
    setTimeout(() => retryChat(e, attempt), wait);
    return;   // done/通知都留到真正收尾的那一轮
  }

  for (const fn of e.subs) { try { fn({ kind: 'done', code, stderr }); } catch { /* gone */ } }
  syncBusy();
  for (const fn of doneListeners) { try { fn({ ch: e.ch, sessionId: e.sessionId, cwd: e.cwd, code, stderr, result: e.result, startedAt: e.startedAt }); } catch { /* listener died */ } }
}

// Continue a transiently-failed turn on a fresh channel; clients discover it
// through /api/chats (same sessionId) and re-attach on their own.
function retryChat(prev, attempt) {
  if (!prev.sessionId) return;   // 没有会话 id 就没法 resume，只能作罢
  const ch = `${prev.ch}-r${attempt}`;
  try {
    startChat(ch, {
      ...prev.spawnOpts,
      resume: prev.sessionId,
      prompt: CONTINUE_PROMPT,
      retries: attempt,
    });
    for (const fn of prev.subs) {
      try { fn({ kind: 'retried', ch, attempt }); } catch { /* gone */ }
    }
  } catch (err) {
    for (const fn of prev.subs) {
      try { fn({ kind: 'error', error: '自动继续失败: ' + String(err.message || err) }); } catch { /* gone */ }
      try { fn({ kind: 'done', code: -1, stderr: '' }); } catch { /* gone */ }
    }
  }
}

const STALL_MS = Number(process.env.COCKPIT_STALL_MS || 30 * 60 * 1000);

function writeEvent(e, event) {
  try { fs.appendFileSync(outPath(e.ch), JSON.stringify(event) + '\n'); }
  catch { /* disk */ }
  drain(e);
}

function makeChatEntry(ch, opts) {
  const e = {
    ch, pid: opts.pid || null, sessionId: opts.resume || null, cwd: opts.cwd || os.homedir(),
    engine: opts.engine || 'claude', model: opts.model || null, startedAt: Date.now(),
    buffer: [], subs: new Set(), offset: 0, rest: '', done: null, timer: null, exitCode: null,
    spawnOpts: { cwd: opts.cwd, model: opts.model, engine: opts.engine },
    retries: opts.retries || 0, remote: !!opts.remote, abort: opts.abort || null, fullText: '',
  };
  chats.set(ch, e);
  writeMeta(e);
  syncBusy();
  startTail(e);
  return e;
}

function startHermesChat(ch, opts) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  if (hasLocalHermes()) return startLocalHermes(ch, opts);
  if (hermesRemote()) return startRemoteHermes(ch, opts);
  throw new Error('这台机器没有 Hermes，也没有配置 hermes.remote');
}

function startLocalHermes(ch, { cwd, resume, prompt, model }) {
  const qdir = path.join(CHAT_DIR, 'hermes-in');
  fs.mkdirSync(qdir, { recursive: true });
  const qfile = path.join(qdir, ch + '.txt');
  fs.writeFileSync(qfile, prompt || '', { mode: 0o600 });
  const args = ['chat', '--yolo', '-Q', '--no-restore-cwd', '--query-file', qfile];
  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  if (cwd) args.push('--in', cwd);

  const plainPath = path.join(CHAT_DIR, ch + '.plain');
  const outFd = fs.openSync(plainPath, 'a');
  const errFd = fs.openSync(errPath(ch), 'a');
  let child;
  try {
    child = spawn(hermesBin(), args, spawnCommon({
      cwd: cwd || os.homedir(),
      detached: true,
      stdio: ['ignore', outFd, errFd],
    }));
  } finally { fs.closeSync(outFd); fs.closeSync(errFd); }

  const e = makeChatEntry(ch, { pid: child.pid, resume, cwd, model, engine: 'hermes' });
  writeEvent(e, { type: 'system', subtype: 'init', session_id: resume || undefined, model: model || 'hermes' });
  e.plainOut = true;
  e.plainPath = plainPath;
  e.plainOffset = 0;
  child.on('error', (err) => { emit(e, { kind: 'error', error: String(err) }); finish(e, -1); });
  child.on('close', (code) => {
    try { fs.unlinkSync(qfile); } catch { /* leftover */ }
    drainPlain(e);
    const text = e.fullText || '';
    if (!e.sessionId) {
      let stderr = '';
      try { stderr = fs.readFileSync(errPath(e.ch), 'utf8'); } catch { /* none */ }
      const m = stderr.match(/session_id:\s*([0-9]{8}_[0-9]{6}_[0-9a-f]+)/i);
      if (m) e.sessionId = m[1];
      else {
        try { e.sessionId = runDb(['list'])[0]?.id || resume || null; }
        catch { /* db busy */ }
      }
      writeMeta(e);
    }
    writeEvent(e, {
      type: 'assistant', session_id: e.sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    writeEvent(e, {
      type: 'result', subtype: code === 0 ? 'success' : 'error',
      session_id: e.sessionId, is_error: code !== 0, result: text.slice(0, 200),
      duration_ms: Date.now() - e.startedAt,
    });
    e.exitCode = code;
    finish(e, code ?? 0);
  });
  child.unref();
  return e;
}

function drainPlain(e) {
  const fp = e.plainPath || (e.ch && path.join(CHAT_DIR, e.ch + '.plain'));
  let size;
  try { size = fs.statSync(fp).size; } catch { return; }
  const from = e.plainOffset || 0;
  if (size <= from) return;
  let chunk = '';
  try {
    const fd = fs.openSync(fp, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      if (!e.decoder) e.decoder = new StringDecoder('utf8');
      chunk = e.decoder.write(n === buf.length ? buf : buf.subarray(0, n));
      e.plainOffset = from + n;
      e.lastGrowthAt = Date.now();
    } finally { fs.closeSync(fd); }
  } catch { return; }
  if (!chunk) return;
  e.fullText = (e.fullText || '') + chunk;
  const piece = chunk.replace(/\n/g, '');
  if (piece) {
    emit(e, {
      kind: 'event',
      event: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } },
    });
  }
}

function startRemoteHermes(ch, { cwd, resume, prompt, model }) {
  const abort = new AbortController();
  const e = makeChatEntry(ch, { resume, cwd, model, engine: 'hermes', remote: true, abort });
  writeEvent(e, { type: 'system', subtype: 'init', session_id: resume || undefined, model: model || 'hermes' });
  (async () => {
  try {
    const data = await remoteFetch('/api/open/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'hermes', wait: true, timeoutMs: 180000,
        prompt: prompt || '', resume: resume || undefined,
        cwd: cwd || undefined, model: model || undefined,
      }),
      timeoutMs: 190000,
      signal: abort.signal,
    });
    e.sessionId = data.sessionId || resume || e.sessionId;
    e.fullText = data.text || '';
    writeMeta(e);
    writeEvent(e, {
      type: 'assistant', session_id: e.sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: e.fullText }] },
    });
    writeEvent(e, {
      type: 'result', subtype: data.code === 0 || data.code == null ? 'success' : 'error',
      session_id: e.sessionId, is_error: !!(data.code && data.code !== 0),
      result: e.fullText.slice(0, 200), duration_ms: Date.now() - e.startedAt,
    });
    e.remoteDone = data.code ?? 0;
    finish(e, e.remoteDone);
  } catch (err) {
    emit(e, { kind: 'error', error: String(err.message || err) });
    e.remoteDone = -1;
    finish(e, -1);
  }
  })();
  return e;
}

function ocEventSid(ev) {
  return ev?.properties?.sessionID || ev?.properties?.info?.id || '';
}

async function* readSse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() || '';
    for (const chunk of chunks) {
      const data = chunk.split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^\s/, ''))
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); }
      catch { /* keep going */ }
    }
  }
}

function ocNoteActivity(e, part) {
  if (!part || typeof part !== 'object') return;
  if (part.type === 'tool') {
    const st = part.state || {};
    e.activity = { kind: 'tool', name: part.tool || st.title || 'tool', at: Date.now() };
  } else if (part.type === 'reasoning') {
    e.activity = { kind: 'text', name: String(part.text || 'Thought').trim().slice(0, 60), at: Date.now() };
  } else if (part.type === 'text' && part.text) {
    e.activity = { kind: 'text', name: String(part.text).trim().slice(0, 60), at: Date.now() };
  }
}

function startOpencodeChat(ch, opts) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  const abort = new AbortController();
  const cwd = opts.cwd || os.homedir();
  const model = opts.model || null;
  const agent = opts.agent || 'reverse';
  const parsed = parseOcModel(model);
  const e = makeChatEntry(ch, {
    resume: opts.resume, cwd, model, engine: 'opencode', remote: true, abort,
  });
  e.spawnOpts = { ...e.spawnOpts, agent, engine: 'opencode' };
  writeEvent(e, {
    type: 'system', subtype: 'init',
    session_id: opts.resume || undefined,
    model: parsed.modelID || 'opencode',
  });

  (async () => {
    try {
      let sid = opts.resume || null;
      if (!sid) {
        const created = await ocFetch('/session?directory=' + encodeURIComponent(cwd), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent,
            title: (opts.prompt || '').trim().slice(0, 60) || undefined,
            model: { id: parsed.modelID, providerID: parsed.providerID },
          }),
          timeoutMs: 15000,
          signal: abort.signal,
        });
        sid = created?.id;
        if (!sid) throw new Error('OpenCode 创建 session 失败');
      }
      e.sessionId = sid;
      writeMeta(e);

      try {
        const mcp = await ocMcp();
        writeEvent(e, { type: 'oc.mcp', mcp: mcp || {} });
      } catch { /* rail stays empty */ }

      const sse = await ocFetchRaw('/event', { signal: abort.signal });
      if (!sse.ok || !sse.body) throw new Error('OpenCode 事件流连接失败');

      const promptBody = {
        agent,
        model: { providerID: parsed.providerID, modelID: parsed.modelID },
        parts: [{ type: 'text', text: opts.prompt || '' }],
      };
      await ocFetch('/session/' + encodeURIComponent(sid) + '/prompt_async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptBody),
        timeoutMs: 15000,
        signal: abort.signal,
      });

      for await (const ev of readSse(sse)) {
        if (abort.signal.aborted) break;
        const type = String(ev?.type || '').replace(/\.\d+$/, '');
        const props = ev?.properties || ev || {};
        const sidOf = ocEventSid(ev) || props.sessionID || '';
        if (sidOf && sidOf !== sid) continue;

        if (type === 'message.part.updated' && props.part) {
          ocNoteActivity(e, props.part);
          writeEvent(e, { type: 'oc.part', part: props.part });
        } else if (type === 'message.part.delta' && props.delta) {
          writeEvent(e, {
            type: 'oc.delta',
            partID: props.partID, field: props.field, delta: props.delta,
          });
        } else if (type === 'session.updated' && props.info) {
          writeEvent(e, { type: 'oc.session', info: props.info });
        } else if (type === 'todo.updated') {
          writeEvent(e, { type: 'oc.todo', todos: props.todos || [] });
        } else if (type === 'session.error') {
          const err = props.error;
          const msg = typeof err === 'string' ? err : (err?.message || err?.data?.message || JSON.stringify(err || 'error'));
          emit(e, { kind: 'error', error: String(msg) });
          writeEvent(e, {
            type: 'result', subtype: 'error', session_id: sid, is_error: true,
            result: String(msg).slice(0, 400), duration_ms: Date.now() - e.startedAt,
          });
          e.remoteDone = 1;
          finish(e, 1);
          try { abort.abort(); } catch { /* */ }
          return;
        } else if (type === 'session.idle') {
          writeEvent(e, {
            type: 'result', subtype: 'success', session_id: sid, is_error: false,
            duration_ms: Date.now() - e.startedAt,
          });
          e.remoteDone = 0;
          finish(e, 0);
          try { abort.abort(); } catch { /* */ }
          return;
        }
      }
      if (e.done) return;
      writeEvent(e, {
        type: 'result', subtype: abort.signal.aborted ? 'error' : 'success',
        session_id: sid, is_error: abort.signal.aborted,
        duration_ms: Date.now() - e.startedAt,
      });
      e.remoteDone = abort.signal.aborted ? -1 : 0;
      finish(e, e.remoteDone);
    } catch (err) {
      if (abort.signal.aborted) {
        writeEvent(e, {
          type: 'result', subtype: 'error', session_id: e.sessionId,
          is_error: true, result: '已停止', duration_ms: Date.now() - e.startedAt,
        });
        e.remoteDone = -1;
        finish(e, -1);
        return;
      }
      emit(e, { kind: 'error', error: String(err.message || err) });
      e.remoteDone = -1;
      finish(e, -1);
    }
  })();
  return e;
}

function startTail(e) {
  if (e.timer) return;
  if (!e.lastGrowthAt) e.lastGrowthAt = Date.now();
  e.timer = setInterval(() => {
    if (e.plainOut) {
      drainPlain(e);
      return;   // hermes close handler writes the final events and calls finish
    }
    drain(e);
    if (e.remote) {
      if (e.remoteDone != null) { drain(e); finish(e, e.remoteDone); return; }
      if (Date.now() - e.lastGrowthAt > STALL_MS) {
        try { e.abort?.abort(); } catch { /* */ }
        emit(e, { kind: 'error', error: `超过 ${Math.round(STALL_MS / 60000)} 分钟无任何输出，已判定卡死并终止（可直接重发继续）` });
        finish(e, -2);
      }
      return;
    }
    // process gone and nothing left to read → the turn is over
    if (!alive(e.pid)) { drain(e); finish(e, e.exitCode ?? 0); return; }
    // "alive" but silent for ages = a hung request or a recycled pid wearing
    // our number — reap it so the UI never shows 运行中 for hours
    if (Date.now() - e.lastGrowthAt > STALL_MS) {
      try { killTree(e.pid); } catch { /* gone */ }
      emit(e, { kind: 'error', error: `超过 ${Math.round(STALL_MS / 60000)} 分钟无任何输出，已判定卡死并终止（可直接重发继续）` });
      finish(e, -2);
    }
  }, POLL_MS);
}

const ALLOWED_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
export function sanitizePermissionMode(mode) {
  return ALLOWED_PERMISSION_MODES.has(mode) ? mode : 'acceptEdits';
}

export function startChat(ch, opts) {
  if (opts.engine === 'hermes') return startHermesChat(ch, opts);
  if (opts.engine === 'opencode') return startOpencodeChat(ch, opts);
  const engine = opts.engine === 'cursor' ? 'cursor' : 'claude';
  let { cwd, resume, prompt, model, attachments, provider } = opts;
  const permissionMode = sanitizePermissionMode(opts.permissionMode);
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  const images = (attachments || []).filter(a => a && a.data && a.mediaType).slice(0, 8);

  let bin, args, env = process.env;
  if (engine === 'cursor') {
    provider = null; // third-party gateways are Claude-only; ignore stale UI state
    const index = materializeCursorAttachments(attachments);
    if (index) prompt = ((prompt || '').trim() ? prompt.trim() + '\n\n' : '') + index;
    if (!resume) resume = createCursorChat(cwd);
    args = ['-p', '--output-format', 'stream-json', '--trust'];
    if (resume) args.push('--resume', resume);
    if (model) args.push('--model', model);
    bin = AGENT_BIN;
  } else {
    // partial messages give token-level deltas + live usage, which是界面上"正在做什么"的唯一来源
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    // images ride in as content blocks, which requires the JSON input format
    if (images.length) args.push('--input-format', 'stream-json');
    if (resume) args.push('--resume', resume);
    if (permissionMode && permissionMode !== 'default') args.push('--permission-mode', permissionMode);

    // third-party gateway (MiMo / DeepSeek / …): swap base url + token + model id
    let effectiveModel = model;
    if (provider) {
      const pe = providerEnv(provider);
      if (pe?.error) throw new Error(pe.error);
      if (pe) {
        env = { ...process.env, ...pe.env };
        effectiveModel = model || pe.model;
        if (pe.effort) args.push('--effort', pe.effort);   // 强制思考类模型(如 glm-5.3)必需
      }
    }
    if (effectiveModel) args.push('--model', effectiveModel);
    args.push('--append-system-prompt', buildSystemPrompt());
    bin = 'claude';
  }

  const outFd = fs.openSync(outPath(ch), 'a');
  const errFd = fs.openSync(errPath(ch), 'a');
  let child;
  try {
    child = spawn(bin, args, spawnCommon({
      cwd: cwd || os.homedir(),
      env,
      detached: true,
      stdio: ['pipe', outFd, errFd],
    }));
  } finally { fs.closeSync(outFd); fs.closeSync(errFd); }

  const e = {
    ch, pid: child.pid, sessionId: resume || null, cwd: cwd || os.homedir(),
    engine, model: model || null, startedAt: Date.now(),
    buffer: [], subs: new Set(), offset: 0, rest: '', done: null, timer: null, exitCode: null,
    // kept so a retry can respawn the same way
    spawnOpts: { cwd, permissionMode, model, provider, engine },
    retries: opts.retries || 0,
  };
  chats.set(ch, e);
  writeMeta(e);
  syncBusy();

  if (engine === 'claude' && images.length) {
    const content = images.map(a => ({
      type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data },
    }));
    content.push({ type: 'text', text: prompt });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  } else {
    child.stdin.write(prompt);
  }
  child.stdin.end();
  child.on('error', (err) => { emit(e, { kind: 'error', error: String(err) }); finish(e, -1); });
  child.on('close', (code) => { e.exitCode = code; drain(e); finish(e, code ?? 0); });
  child.unref();

  startTail(e);
  return e;
}

// Rebuild state for turns still running after a server restart.
export function restoreChats() {
  let files;
  try { files = fs.readdirSync(CHAT_DIR); } catch { return 0; }
  let restored = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(CHAT_DIR, f), 'utf8')); } catch { continue; }
    if (!meta.ch || chats.has(meta.ch)) continue;
    const running = !meta.done && alive(meta.pid);
    if (!running) {
      // stale: drop artifacts once past the retention window
      const st = fs.statSync(path.join(CHAT_DIR, f));
      if (Date.now() - st.mtimeMs > RETAIN_MS) {
        for (const p of [outPath(meta.ch), errPath(meta.ch), metaPath(meta.ch)]) {
          try { fs.unlinkSync(p); } catch { /* already gone */ }
        }
      }
      continue;
    }
    const e = {
      ch: meta.ch, pid: meta.pid, sessionId: meta.sessionId || null, cwd: meta.cwd,
      engine: meta.engine || 'claude', model: meta.model || null, startedAt: meta.startedAt || Date.now(),
      buffer: [], subs: new Set(), offset: 0, rest: '', done: null, timer: null, exitCode: null,
      spawnOpts: { cwd: meta.cwd, engine: meta.engine || 'claude', model: meta.model || null },
    };
    chats.set(e.ch, e);
    drain(e);        // replay what the turn produced while we were down
    startTail(e);
    syncBusy();
    restored++;
  }
  return restored;
}

export function subscribe(ch, from, fn) {
  const e = chats.get(ch);
  if (!e) return null;
  const start = from === 'future' ? e.buffer.length : Math.max(0, from | 0);
  for (const msg of e.buffer.slice(start)) fn(msg);
  // a turn awaiting its retry is not finished — don't tell a re-attaching client it is
  if (e.done && !e.retryPending) fn({ kind: 'done', code: e.done.code, stderr: e.done.stderr });
  e.subs.add(fn);
  return () => e.subs.delete(fn);
}

export function stopChat(ch) {
  const e = chats.get(ch);
  if (!e || e.done) return false;
  if (e.engine === 'opencode' && e.sessionId) {
    ocFetch('/session/' + encodeURIComponent(e.sessionId) + '/abort', {
      method: 'POST', timeoutMs: 4000,
    }).catch(() => {});
  }
  if (e.abort) { try { e.abort.abort(); } catch { /* already */ } return true; }
  // detached child leads its own group; kill the group so tool subprocesses die too
  return killTree(e.pid);
}

export function waitForChat(ch, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      un?.();
      const e = chats.get(ch);
      resolve({
        timedOut: true, ch, sessionId: e?.sessionId || null,
        text: e?.fullText || e?.result?.text || '', code: null,
      });
    }, timeoutMs);
    const un = subscribe(ch, 0, (msg) => {
      if (msg.kind !== 'done') return;
      clearTimeout(t);
      un();
      const e = chats.get(ch);
      resolve({
        timedOut: false, ch, sessionId: e?.sessionId || null,
        text: e?.fullText || e?.result?.text || '', code: msg.code,
        stderr: msg.stderr || '',
      });
    });
    if (!un) {
      clearTimeout(t);
      resolve({ timedOut: false, ch, sessionId: null, text: '', code: -1, error: 'chat gone' });
    }
  });
}

export function hasChat(ch) { return chats.has(ch); }

export function listChats() {
  return [...chats.values()].map(e => ({
    ch: e.ch, sessionId: e.sessionId, cwd: e.cwd, model: e.model, engine: e.engine || 'claude',
    startedAt: e.startedAt, running: !e.done, events: e.buffer.length,
    activity: e.activity || null,
  }));
}
