import fs from 'fs';
import path from 'path';
import os from 'os';
import { pickTitleFromText } from './title.js';
import { persistImage } from './cursor-uploads.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_FILE_BYTES = 1024 * 1024 * 1024;  // hard cap for full parse (server memory)
const META_FULL_LIMIT = 8 * 1024 * 1024;    // above this, sidebar metadata uses head+tail sampling

function readChunk(fp, start, len) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } finally { fs.closeSync(fd); }
}

// sidebar metadata cache: filePath -> { mtimeMs, meta }
const metaCache = new Map();

function safeParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function stripReminders(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .trim();
}

function firstUserText(entry) {
  const c = entry?.message?.content;
  if (typeof c === 'string') return stripReminders(c);
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text' && b.text) {
        const t = stripReminders(b.text);
        if (t) return t;
      }
    }
  }
  return '';
}

function extractMeta(filePath) {
  const stat = fs.statSync(filePath);
  const cached = metaCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.meta;
  if (stat.size > META_FULL_LIMIT) {
    // big session: title lives near the tail (latest ai-title), cwd near the head —
    // sample both ends instead of parsing the whole file on every sidebar refresh
    const CHUNK = 512 * 1024;
    const headLines = readChunk(filePath, 0, CHUNK).split('\n').slice(0, -1);
    const tailLines = readChunk(filePath, Math.max(0, stat.size - CHUNK), CHUNK).split('\n').slice(1);
    let title = '', custom = '', cwd = '', firstText = '';
    for (const line of headLines) {
      const e = safeParse(line);
      if (!e) continue;
      if (!cwd && e.cwd) cwd = e.cwd;
      if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
      if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
      if (!firstText && e.type === 'user' && !e.isMeta && !e.isSidechain) firstText = firstUserText(e);
    }
    for (const line of tailLines) {
      const e = safeParse(line);
      if (e?.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
      if (e?.type === 'custom-title' && e.customTitle) custom = e.customTitle;
    }
    const meta = { title: custom || title || pickTitleFromText(firstText).title || '(长会话)', cwd, mtimeMs: stat.mtimeMs, msgCount: null };
    metaCache.set(filePath, { mtimeMs: stat.mtimeMs, meta });
    return meta;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let title = '', custom = '', cwd = '', msgCount = 0, firstText = '';
  for (const line of lines) {
    if (!line) continue;
    const e = safeParse(line);
    if (!e) continue;
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (e.type === 'user' || e.type === 'assistant') {
      if (!e.isMeta && !e.isSidechain) msgCount++;
      if (!firstText && e.type === 'user' && !e.isMeta && !e.isSidechain) {
        firstText = firstUserText(e);
      }
    }
  }
  if (custom) title = custom;   // 原生 custom-title 恒定优先于自动标题
  if (!title) title = pickTitleFromText(firstText).title || '(空会话)';
  const meta = { title, cwd, mtimeMs: stat.mtimeMs, msgCount };
  metaCache.set(filePath, { mtimeMs: stat.mtimeMs, meta });
  return meta;
}

// locate a session file by id across project dirs (used for notification text)
export function findSessionMeta(id) {
  if (!id || id.includes('/') || id.includes('..')) return null;
  let slugs;
  try { slugs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const slug of slugs) {
    const fp = path.join(PROJECTS_DIR, slug, id + '.jsonl');
    if (!fs.existsSync(fp)) continue;
    try { return { slug, ...extractMeta(fp) }; }
    catch { return { slug, title: id.slice(0, 8), cwd: '' }; }
  }
  return null;
}

export function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const projects = [];
  for (const slug of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, slug);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
    catch { continue; }
    if (!files.length) continue;
    const sessions = [];
    let projCwd = '';
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        const meta = extractMeta(fp);
        if (meta.msgCount === 0) continue;
        if (!projCwd && meta.cwd) projCwd = meta.cwd;
        sessions.push({ id: f.replace(/\.jsonl$/, ''), ...meta });
      } catch { /* skip unreadable */ }
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    projects.push({ slug, cwd: projCwd, sessions, mtimeMs: sessions[0].mtimeMs });
  }
  projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return projects;
}

// Normalize one JSONL entry into a renderable message, or null to skip.
function normalizeEntry(e) {
  if (e.type !== 'user' && e.type !== 'assistant') return null;
  if (e.isMeta || e.isSidechain) return null;
  const raw = e.message?.content;
  let blocks = [];
  if (typeof raw === 'string') {
    const t = stripReminders(raw);
    if (t) blocks.push({ type: 'text', text: t });
  } else if (Array.isArray(raw)) {
    for (const b of raw) {
      if (b.type === 'text') {
        const t = e.type === 'user' ? stripReminders(b.text || '') : (b.text || '');
        if (t) blocks.push({ type: 'text', text: t });
      } else if (b.type === 'thinking') {
        if (b.thinking && b.thinking.trim()) blocks.push({ type: 'thinking', text: b.thinking });
      } else if (b.type === 'tool_use') {
        blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        const url = persistImage(b.source.media_type, b.source.data);
        if (url) blocks.push({ type: 'image', url });
        else blocks.push({ type: 'text', text: '[图片过大或损坏，未在此处加载]' });
      } else if (b.type === 'tool_result') {
        let content = b.content;
        const images = [];
        if (Array.isArray(content)) {
          const parts = [];
          for (const x of content) {
            // tools can return images (Read on a png, screenshots) — keep them renderable
            if (x.type === 'image' && x.source?.type === 'base64') {
              const url = persistImage(x.source.media_type, x.source.data);
              if (url) images.push({ url });
              else parts.push('[图片过大或损坏，未在此处加载]');
            } else if (x.type === 'text') parts.push(x.text);
            else parts.push(`[${x.type}]`);
          }
          content = parts.join('\n');
        }
        blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id, text: String(content ?? ''), is_error: !!b.is_error, images });
      }
    }
  }
  if (!blocks.length) return null;
  return { role: e.type, blocks, timestamp: e.timestamp || null };
}

// Returns a window of messages ending at index `end` (exclusive; default = total),
// so the client can lazy-load history backwards instead of rendering thousands at once.
export function readSession(slug, id, { end, limit = 200 } = {}) {
  if (slug.includes('/') || slug.includes('..') || id.includes('/') || id.includes('..')) {
    throw new Error('bad path');
  }
  const fp = path.join(PROJECTS_DIR, slug, id + '.jsonl');
  const stat = fs.statSync(fp);
  if (stat.size > MAX_FILE_BYTES) throw new Error('session file too large (>1GB)');

  // Buffer-based line scan: a whole-file utf8 read would hit V8's string length
  // ceiling (~1GB) and retain every parsed message in memory. Two passes instead:
  // pass 1 counts messages and records byte ranges, pass 2 parses only the window.
  const buf = fs.readFileSync(fp);
  const ranges = [];
  let cwd = '', title = '', custom = '';
  let pos = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos);
    if (nl === -1) nl = buf.length;
    if (nl > pos) {
      const e = safeParse(buf.toString('utf8', pos, nl));
      if (e) {
        if (!cwd && e.cwd) cwd = e.cwd;
        if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
        if (normalizeEntry(e)) ranges.push([pos, nl]);
      }
    }
    pos = nl + 1;
  }
  const total = ranges.length;
  const to = Math.min(end ?? total, total);
  const from = Math.max(0, to - limit);
  const messages = [];
  for (let i = from; i < to; i++) {
    const m = normalizeEntry(safeParse(buf.toString('utf8', ranges[i][0], ranges[i][1])));
    if (m) messages.push(m);
  }
  return { id, slug, cwd, title: custom || title, total, start: from, messages, bytes: stat.size };
}
