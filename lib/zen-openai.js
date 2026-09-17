import os from 'os';
import { opencodeZenKey } from './zen-key.js';
import { ocFetch } from './opencode.js';

const ZEN_MESSAGES = 'https://opencode.ai/zen/v1/messages';
const DEFAULT_MODEL = 'union-alpha';
const OC_UA = 'opencode/1.18.29 ai-sdk/provider-utils/3.0.23 runtime/bun/1.3.14';

function openaiToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    const fn = t?.function || t;
    const name = fn?.name || t?.name;
    if (!name) continue;
    out.push({
      name,
      description: fn?.description || t?.description || '',
      input_schema: fn?.parameters || t?.input_schema || { type: 'object', properties: {} },
    });
  }
  return out;
}

function flattenContent(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return c == null ? '' : String(c);
  return c.map((b) => {
    if (typeof b === 'string') return b;
    if (b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text') return b.text || b.content || '';
    if (b?.type === 'tool_use') return `[tool ${b.name} ${JSON.stringify(b.input || {})}]`;
    if (b?.type === 'tool_result') return `[tool_result ${flattenContent(b.content)}]`;
    return '';
  }).join('');
}

function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  for (const m of messages || []) {
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      const t = flattenContent(m.content);
      if (t) system.push(t);
      continue;
    }
    if (role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id || m.id || '',
          content: flattenContent(m.content),
        }],
      });
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = flattenContent(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls || []) {
        let args = tc.function?.arguments || tc.arguments || '{}';
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id || ('tool_' + Math.random().toString(36).slice(2, 10)),
          name: tc.function?.name || tc.name,
          input: args,
        });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    const text = flattenContent(m.content);
    out.push({ role: 'user', content: text || ' ' });
  }
  return { system: system.join('\n\n'), messages: out };
}

function transcript(system, messages) {
  const lines = [];
  if (system) lines.push('System:\n' + system);
  for (const m of messages || []) {
    const text = typeof m.content === 'string' ? m.content : flattenContent(m.content);
    if (!text) continue;
    lines.push((m.role || 'user') + ':\n' + text);
  }
  return lines.join('\n\n') || 'hi';
}

function sseWrite(res, obj) {
  if (obj?.type) res.write('event: ' + obj.type + '\n');
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function chunkBase(id, model) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
}

function isFreeTierBlocked(text) {
  return /FreeTierError|only be used from within OpenCode/i.test(String(text || ''));
}

function ocDirQs() {
  return 'directory=' + encodeURIComponent(os.homedir());
}

async function completeViaOpencode(model, system, messages) {
  const qs = ocDirQs();
  const created = await ocFetch('/session?' + qs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 15000,
    body: JSON.stringify({
      title: '[cockpit-zen]',
      model: { id: model || DEFAULT_MODEL, providerID: 'opencode' },
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    }),
  });
  const sid = created?.id;
  if (!sid) throw new Error('OpenCode 创建 shim session 失败');
  try {
    const msg = await ocFetch('/session/' + encodeURIComponent(sid) + '/message?' + qs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 180000,
      body: JSON.stringify({
        model: { providerID: 'opencode', modelID: model || DEFAULT_MODEL },
        parts: [{ type: 'text', text: transcript(system, messages) }],
      }),
    });
    const texts = [];
    for (const p of msg?.parts || []) {
      if (p?.type === 'text' && p.text) texts.push(p.text);
    }
    return texts.join('') || '';
  } finally {
    ocFetch('/session/' + encodeURIComponent(sid) + '?' + qs, {
      method: 'DELETE',
      timeoutMs: 8000,
    }).catch(() => {});
  }
}

function zenHeaders(key) {
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    authorization: 'Bearer ' + key,
    'anthropic-version': '2023-06-01',
    'user-agent': OC_UA,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
  };
}

async function completeText(model, system, messages, tools) {
  const key = opencodeZenKey();
  const payload = {
    model,
    max_tokens: 16384,
    stream: false,
    messages: messages.length ? messages : [{ role: 'user', content: 'hi' }],
  };
  if (system) payload.system = system;
  if (tools?.length) payload.tools = tools;

  if (key) {
    try {
      const upstream = await fetch(ZEN_MESSAGES, {
        method: 'POST',
        headers: zenHeaders(key),
        body: JSON.stringify(payload),
      });
      const text = await upstream.text();
      if (upstream.ok) {
        const data = JSON.parse(text);
        return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      }
      if (!isFreeTierBlocked(text)) {
        throw new Error(text.slice(0, 800) || ('zen ' + upstream.status));
      }
    } catch (err) {
      if (!isFreeTierBlocked(err.message) && !/zen /i.test(String(err.message))) {
        // network errors fall through to OpenCode
        if (!/fetch|ECONN|ENOTFOUND|Zen 连不上/i.test(String(err.message || err))) throw err;
      }
    }
  }
  return completeViaOpencode(model, system, messages);
}

function bodyToAnthropic(body) {
  if (Array.isArray(body.messages) && body.messages.length) {
    const conv = toAnthropicMessages(body.messages);
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      conv.system = [body.instructions.trim(), conv.system].filter(Boolean).join('\n\n');
    }
    return conv;
  }
  const input = body.input;
  const msgs = [];
  if (typeof input === 'string') msgs.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') msgs.push({ role: 'user', content: item });
      else if (item?.role) msgs.push({ role: item.role, content: item.content });
      else if (item?.type === 'message') msgs.push({ role: item.role || 'user', content: item.content });
      else if (item?.type === 'input_text' || item?.text) msgs.push({ role: 'user', content: item.text || item.content });
    }
  }
  const conv = toAnthropicMessages(msgs);
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    conv.system = [body.instructions.trim(), conv.system].filter(Boolean).join('\n\n');
  }
  if (typeof body.system === 'string' && body.system.trim()) {
    conv.system = [body.system.trim(), conv.system].filter(Boolean).join('\n\n');
  }
  return conv;
}

function responsesObject(model, text) {
  const id = 'resp_' + Date.now().toString(36);
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [{
      id: 'msg_' + id.slice(5),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    }],
    output_text: text,
  };
}

function writeResponsesStream(res, model, text) {
  const obj = responsesObject(model, text);
  const item = obj.output[0];
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  sseWrite(res, { type: 'response.created', response: { ...obj, status: 'in_progress', output: [] } });
  sseWrite(res, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  sseWrite(res, {
    type: 'response.content_part.added',
    output_index: 0,
    content_index: 0,
    item_id: item.id,
    part: { type: 'output_text', text: '' },
  });
  sseWrite(res, {
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    item_id: item.id,
    delta: text,
  });
  sseWrite(res, {
    type: 'response.output_text.done',
    output_index: 0,
    content_index: 0,
    item_id: item.id,
    text,
  });
  sseWrite(res, {
    type: 'response.content_part.done',
    output_index: 0,
    content_index: 0,
    item_id: item.id,
    part: { type: 'output_text', text },
  });
  sseWrite(res, { type: 'response.output_item.done', output_index: 0, item });
  sseWrite(res, { type: 'response.completed', response: obj });
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeOpenaiStream(res, model, text) {
  const id = 'chatcmpl-' + Date.now().toString(36);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  sseWrite(res, { ...chunkBase(id, model), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  const c = chunkBase(id, model);
  c.choices[0].delta = { content: text };
  sseWrite(res, c);
  const end = chunkBase(id, model);
  end.choices[0].delta = {};
  end.choices[0].finish_reason = 'stop';
  sseWrite(res, end);
  res.write('data: [DONE]\n\n');
  res.end();
}

export function mountZenOpenAI(app) {
  const modelsPayload = {
    object: 'list',
    models: [{ id: DEFAULT_MODEL, slug: DEFAULT_MODEL, display_name: 'Union Alpha Free' }],
    data: [{ id: DEFAULT_MODEL, slug: DEFAULT_MODEL, object: 'model', created: 0, owned_by: 'opencode-zen' }],
  };
  app.get('/zen-openai/v1/models', (_req, res) => { res.json(modelsPayload); });
  app.get('/zen-anthropic/v1/models', (_req, res) => {
    res.json({ data: [{ id: DEFAULT_MODEL, object: 'model', created: 0, owned_by: 'opencode-zen' }] });
  });

  app.post('/zen-openai/v1/chat/completions', async (req, res) => {
    const body = req.body || {};
    const model = String(body.model || DEFAULT_MODEL).replace(/^opencode\//, '') || DEFAULT_MODEL;
    const { system, messages } = toAnthropicMessages(body.messages || []);
    const tools = openaiToolsToAnthropic(body.tools);
    const stream = body.stream !== false;
    try {
      const text = await completeText(model, system, messages, tools);
      if (!stream) {
        res.json({
          id: 'chatcmpl-zen',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text || null },
            finish_reason: 'stop',
          }],
        });
        return;
      }
      writeOpenaiStream(res, model, text);
    } catch (err) {
      const msg = String(err.message || err);
      if (!res.headersSent) res.status(502).json({ error: { message: msg.slice(0, 800) } });
      else res.end();
    }
  });

  app.post('/zen-openai/v1/responses', async (req, res) => {
    const body = req.body || {};
    const model = String(body.model || DEFAULT_MODEL).replace(/^opencode\//, '') || DEFAULT_MODEL;
    const { system, messages } = bodyToAnthropic(body);
    const stream = body.stream !== false;
    try {
      const text = await completeText(model, system, messages, openaiToolsToAnthropic(body.tools));
      if (!stream) { res.json(responsesObject(model, text)); return; }
      writeResponsesStream(res, model, text);
    } catch (err) {
      const msg = String(err.message || err);
      if (!res.headersSent) res.status(502).json({ error: { message: msg.slice(0, 800) } });
      else res.end();
    }
  });

  app.post('/zen-anthropic/v1/messages', async (req, res) => {
    const body = req.body || {};
    const model = String(body.model || DEFAULT_MODEL).replace(/^opencode\//, '') || DEFAULT_MODEL;
    const system = typeof body.system === 'string'
      ? body.system
      : flattenContent(body.system);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const stream = !!body.stream;
    try {
      const text = await completeText(model, system, messages, body.tools);
      const msg = {
        id: 'msg_zen_' + Date.now().toString(36),
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      if (!stream) { res.json(msg); return; }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      sseWrite(res, { type: 'message_start', message: { ...msg, content: [] } });
      sseWrite(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sseWrite(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      sseWrite(res, { type: 'content_block_stop', index: 0 });
      sseWrite(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
      sseWrite(res, { type: 'message_stop' });
      res.end();
    } catch (err) {
      const msg = String(err.message || err);
      if (!res.headersSent) res.status(502).json({ error: { type: 'api_error', message: msg.slice(0, 800) } });
      else res.end();
    }
  });
}
