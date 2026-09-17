import fs from 'fs';
import path from 'path';
import { pickTitleFromText } from './title.js';
import { codexHome, hasLocalCodex } from './codex.js';

export const SLUG_PREFIX = 'codex:';

export function isCodexSlug(slug) {
  return typeof slug === 'string' && (slug === 'codex' || slug.startsWith(SLUG_PREFIX));
}

export function isCodexId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function sessionsRoot() {
  return path.join(codexHome(), 'sessions');
}

function safeParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function idFromName(name) {
  const m = String(name).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : '';
}

function walkJsonl(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(fp, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(fp);
  }
  return out;
}

function readHead(fp, bytes = 96 * 1024) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n);
  } finally { fs.closeSync(fd); }
}

function payloadOf(e) {
  return e?.payload && typeof e.payload === 'object' ? e.payload : e;
}

function userTextFromEvent(e) {
  const p = payloadOf(e);
  const role = p.role || p.message?.role;
  if (role && role !== 'user') return '';
  const content = p.content || p.message?.content || p.text;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((b) => b?.text || b?.content || (typeof b === 'string' ? b : '')).join('').trim();
  }
  return '';
}

function isJunkUser(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.startsWith('<') && t.length > 400) return true;
  if (/^You are Codex|^You are `\/root`|^<app-context>|^<recommended_plugins>/i.test(t)) return true;
  return false;
}

const indexCache = { mtimeMs: 0, map: new Map() };

function threadNames() {
  const fp = path.join(codexHome(), 'session_index.jsonl');
  let st;
  try { st = fs.statSync(fp); } catch { return indexCache.map; }
  if (indexCache.mtimeMs === st.mtimeMs) return indexCache.map;
  const map = new Map();
  try {
    for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      const o = safeParse(line);
      if (o?.id) map.set(o.id, o.thread_name || o.title || '');
    }
  } catch { /* */ }
  indexCache.mtimeMs = st.mtimeMs;
  indexCache.map = map;
  return map;
}

function extractMeta(fp) {
  const stat = fs.statSync(fp);
  const id = idFromName(path.basename(fp));
  if (!id) return null;
  const head = readHead(fp);
  let cwd = '', model = '', firstUser = '', title = threadNames().get(id) || '';
  let msgCount = 0;
  for (const line of head.split('\n')) {
    const e = safeParse(line);
    if (!e) continue;
    const p = payloadOf(e);
    const t = e.type || p.type;
    if (t === 'session_meta') {
      cwd = p.cwd || cwd;
      model = p.model || p.model_provider || model;
    }
    const ut = userTextFromEvent(e);
    if (ut && !isJunkUser(ut) && !firstUser) firstUser = ut;
    if (t === 'response_item' && (p.role === 'user' || p.role === 'assistant')) msgCount++;
  }
  if (!firstUser && !title) return null;
  if (!title && firstUser) title = pickTitleFromText(firstUser).title || firstUser.slice(0, 42);
  return {
    id,
    engine: 'codex',
    title: title || id.slice(0, 8),
    cwd: cwd || '',
    mtimeMs: stat.mtimeMs,
    msgCount: msgCount || null,
    model,
    file: fp,
  };
}

let lastProjects = [];

export function listProjects() {
  if (!hasLocalCodex()) return [];
  try {
    const files = walkJsonl(sessionsRoot());
    const sessions = [];
    for (const fp of files) {
      try {
        const meta = extractMeta(fp);
        if (meta) sessions.push(meta);
      } catch { /* unreadable */ }
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    lastProjects = [{
      slug: SLUG_PREFIX + 'cli',
      engine: 'codex',
      cwd: 'Codex · cli',
      sessions: sessions.slice(0, 400),
      mtimeMs: sessions[0]?.mtimeMs || 0,
    }];
    return lastProjects;
  } catch {
    return lastProjects;
  }
}

function fileForId(id) {
  const files = walkJsonl(sessionsRoot());
  const needle = String(id).toLowerCase();
  for (const fp of files) {
    if (path.basename(fp).toLowerCase().includes(needle)) return fp;
  }
  return null;
}

function normalizeMessage(e) {
  const p = payloadOf(e);
  const t = e.type || p.type;
  if (t === 'response_item' || p.role) {
    const role = p.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const text = userTextFromEvent(e);
    if (!text || isJunkUser(text)) return null;
    return { role, blocks: [{ type: 'text', text }], timestamp: e.timestamp || null };
  }
  if (t === 'event_msg' && p.type === 'agent_message' && p.message) {
    return { role: 'assistant', blocks: [{ type: 'text', text: String(p.message) }], timestamp: e.timestamp || null };
  }
  return null;
}

export function readSession(slug, id, { end, limit = 200 } = {}) {
  if (id.includes('/') || id.includes('..')) throw new Error('bad path');
  const fp = fileForId(id);
  if (!fp) throw new Error('找不到这条 Codex 会话');
  const buf = fs.readFileSync(fp);
  const messages = [];
  let pos = 0;
  let cwd = '';
  let title = threadNames().get(id) || '';
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos);
    if (nl === -1) nl = buf.length;
    if (nl > pos) {
      const e = safeParse(buf.toString('utf8', pos, nl));
      if (e) {
        const p = payloadOf(e);
        if ((e.type || p.type) === 'session_meta' && p.cwd) cwd = p.cwd;
        const m = normalizeMessage(e);
        if (m) messages.push(m);
      }
    }
    pos = nl + 1;
  }
  const total = messages.length;
  const to = Math.min(end ?? total, total);
  const from = Math.max(0, to - limit);
  if (!title) {
    const first = messages.find((m) => m.role === 'user');
    title = first ? (pickTitleFromText(first.blocks[0].text).title || first.blocks[0].text.slice(0, 42)) : id.slice(0, 8);
  }
  return {
    id, slug: slug || SLUG_PREFIX + 'cli', engine: 'codex', cwd, title,
    total, start: from, messages: messages.slice(from, to), bytes: buf.length,
  };
}

export function findSessionMeta(id) {
  if (!id || !isCodexId(id) || !hasLocalCodex()) return null;
  const fp = fileForId(id);
  if (!fp) return null;
  try {
    const meta = extractMeta(fp);
    return meta ? { slug: SLUG_PREFIX + 'cli', ...meta } : null;
  } catch { return null; }
}

export function searchContent(q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query || !hasLocalCodex()) return [];
  const hits = [];
  for (const fp of walkJsonl(sessionsRoot())) {
    if (hits.length >= 50) break;
    let text = '';
    try { text = readHead(fp, 48 * 1024).toLowerCase(); } catch { continue; }
    const i = text.indexOf(query);
    if (i < 0) continue;
    const id = idFromName(path.basename(fp));
    if (!id) continue;
    const snip = text.slice(Math.max(0, i - 40), i + query.length + 40).replace(/\s+/g, ' ');
    hits.push({ engine: 'codex', slug: SLUG_PREFIX + 'cli', id, snippet: snip, where: 'content' });
  }
  return hits;
}
