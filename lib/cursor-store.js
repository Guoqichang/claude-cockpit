/* Cursor 账号用尽额度时，会把整个 agent-transcript 覆写成一行错误
   （{"type":"turn_ended","status":"error","error":"...out of usage..."}），
   历史对话在 jsonl 侧就此蒸发。但 Cursor 自己的 store.db 是内容寻址的 blob 仓，
   消息原文还在，只是没有现成的时间线。

   store.db 结构：
     meta.value  = hex 编码的 JSON，含 latestRootBlobId
     blobs(id,data) = 两类内容
       · 消息 blob：明文 JSON {role, content:[...]}（AI SDK 格式，未加密）
       · 列表 blob：protobuf 重复字段 1，每项 0x0a 0x20 + 32 字节子 blob 哈希

   每一轮对话都会落一个新的列表 blob，记录那一刻的完整上下文顺序。
   单个列表只覆盖当时的上下文窗口（被 summarize 之后会截断），
   但把所有列表的「相邻对」当作先后边做拓扑排序，就能把全部历史重排成一条唯一时间线。 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CHATS_DIR = path.join(os.homedir(), '.cursor/chats');
const MAX_DB_BYTES = 512 * 1024 * 1024;

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 老 node 没有内置 sqlite，降级为不可用 */ }

export function findStoreDb(chatId) {
  if (!chatId || chatId.includes('/') || chatId.includes('..')) return null;
  let wsDirs;
  try { wsDirs = fs.readdirSync(CHATS_DIR); } catch { return null; }
  for (const wsHash of wsDirs) {
    const fp = path.join(CHATS_DIR, wsHash, chatId, 'store.db');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

/* 列表 blob 的宽松解析：root 里除哈希外还夹着别的字段，
   所以按 0x0a20 前缀逐个扫，扫不中就右移一字节。 */
function scanChildIds(buf, isMsg) {
  const ids = [];
  for (let i = 0; i + 34 <= buf.length; ) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x20) {
      const id = buf.subarray(i + 2, i + 34).toString('hex');
      if (isMsg(id)) ids.push(id);
      i += 34;
    } else i++;
  }
  return ids;
}

/* store.db 里的 user 消息是发给模型的完整 payload：真正的问题外面裹着
   <user_info>/<rules>/<agent_transcripts> 之类的环境块，有时长达两三万字。
   有 <user_query> 就直接取里面的；没有就把首尾成对的 XML 块层层剥掉，
   剥完为空说明这条整个都是环境注入，调用方据此丢弃。 */
function stripEnvelope(text) {
  let s = String(text || '');
  const q = s.match(/<user_query>\s*([\s\S]*?)<\/user_query>/);
  if (q) return q[1].trim();
  let prev;
  do {
    prev = s;
    s = s.trim()
      .replace(/^<([a-zA-Z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/, '')
      .replace(/<([a-zA-Z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>$/, '')
      .trim();
  } while (s !== prev && s);
  return s;
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : (x?.text ?? ''))).join('');
  if (typeof v === 'object') return v.text ?? JSON.stringify(v);
  return String(v);
}

function normalize(msg) {
  const role = msg.role;
  if (role === 'system') return null;

  if (role === 'tool') {
    const blocks = [];
    for (const p of Array.isArray(msg.content) ? msg.content : []) {
      if (p.type !== 'tool-result') continue;
      blocks.push({
        type: 'tool_result',
        tool_use_id: p.toolCallId,
        text: textOf(p.result),
        is_error: false,
        images: [],
      });
    }
    return blocks.length ? { role: 'user', blocks, timestamp: null } : null;
  }

  if (role === 'user') {
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    const blocks = [];
    for (const p of parts) {
      if (p.type !== 'text') continue;
      const t = stripEnvelope(p.text);
      if (!t) continue;
      // Cursor 压缩上下文时会以 user 身份塞一份摘要进来，标成用户发言会误导；
      // 收进可折叠的思考块，既不冒名又留住这段摘要本身的信息量
      if (/^Your conversation was summarized due to context constraints/.test(t)) {
        return { role: 'assistant', blocks: [{ type: 'thinking', text: '【Cursor 在此处压缩了上下文】\n\n' + t }], timestamp: null };
      }
      blocks.push({ type: 'text', text: t });
    }
    return blocks.length ? { role: 'user', blocks, timestamp: null } : null;
  }

  if (role === 'assistant') {
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    const blocks = [];
    for (const p of parts) {
      if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
      else if (p.type === 'reasoning' && String(p.text || '').trim()) blocks.push({ type: 'thinking', text: p.text });
      else if (p.type === 'tool-call') blocks.push({ type: 'tool_use', id: p.toolCallId, name: p.toolName, input: p.args });
    }
    return blocks.length ? { role: 'assistant', blocks, timestamp: null } : null;
  }
  return null;
}

const cache = new Map();   // dbPath -> { mtimeMs, size, messages }

/** 从 store.db 里重建整条时间线；失败或不可用时返回 null */
export function readStoreMessages(chatId) {
  if (!DatabaseSync) return null;
  const dbPath = findStoreDb(chatId);
  if (!dbPath) return null;

  let st;
  try { st = fs.statSync(dbPath); } catch { return null; }
  if (st.size > MAX_DB_BYTES) return null;
  const hit = cache.get(dbPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.messages;

  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
  try {
    const rows = db.prepare('select id, data from blobs').all();
    const msgs = new Map();
    const others = [];
    for (const r of rows) {
      const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data);
      // 明文消息 blob 一定以 '{' 开头；其余留给列表解析
      if (buf[0] === 0x7b) {
        try {
          const d = JSON.parse(buf.toString('utf8'));
          if (d && d.role) { msgs.set(r.id, d); continue; }
        } catch { /* 不是消息，落到 others */ }
      }
      others.push(buf);
    }
    if (!msgs.size) return null;

    const isMsg = (id) => msgs.has(id);
    const adj = new Map();      // id -> Set(后继)
    const indeg = new Map();
    const seen = new Set();
    const touch = (id) => { if (!seen.has(id)) { seen.add(id); adj.set(id, new Set()); indeg.set(id, 0); } };

    for (const buf of others) {
      const ids = scanChildIds(buf, isMsg);
      if (ids.length < 2) continue;
      for (const id of ids) touch(id);
      for (let i = 0; i + 1 < ids.length; i++) {
        const a = ids[i], b = ids[i + 1];
        if (a === b || adj.get(a).has(b)) continue;
        adj.get(a).add(b);
        indeg.set(b, indeg.get(b) + 1);
      }
    }
    if (!seen.size) return null;

    // Kahn 拓扑排序；就绪集合按 id 排序，保证同一份库每次重建出同样的顺序
    const ready = [...seen].filter(id => indeg.get(id) === 0).sort();
    const order = [];
    while (ready.length) {
      const n = ready.shift();
      order.push(n);
      const next = [];
      for (const m of adj.get(n)) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
      if (next.length) { ready.push(...next.sort()); ready.sort(); }
    }
    if (order.length < seen.size) return null;   // 有环说明结构和预期不符，宁可不显示也不给错顺序

    const messages = [];
    for (const id of order) {
      const m = normalize(msgs.get(id));
      if (m) messages.push(m);
    }
    if (!messages.length) return null;
    cache.set(dbPath, { mtimeMs: st.mtimeMs, size: st.size, messages });
    return messages;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 判断一个 transcript 是不是被 Cursor 的额度错误覆写成了空壳 */
export function transcriptIsStub(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.size > 8 * 1024) return false;
    const txt = fs.readFileSync(fp, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    if (!lines.length) return true;
    return lines.every(l => {
      try {
        const e = JSON.parse(l);
        return e.type === 'turn_ended' || (!e.message && !e.content);
      } catch { return false; }
    });
  } catch {
    return true;
  }
}
