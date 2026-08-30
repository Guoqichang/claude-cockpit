import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractIndexedFiles } from './cursor-uploads.js';
import { pickTitleFromText } from './title.js';

const CHATS_DIR = path.join(os.homedir(), '.cursor/chats');
const PROJECTS_DIR = path.join(os.homedir(), '.cursor/projects');
const SLUG_PREFIX = 'cursor:';
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

function safeParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function stripReminders(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, '')
    .replace(/<\/?user_query>/g, '')
    .trim();
}

function fileBlocksFromIndex(text) {
  const { cleaned, images, files } = extractIndexedFiles(text);
  const blocks = [];
  for (const fp of images) {
    blocks.push({ type: 'image', url: '/api/local-file?path=' + encodeURIComponent(fp) });
  }
  for (const fp of files) {
    blocks.push({ type: 'file', name: path.basename(fp), url: '/api/local-file?path=' + encodeURIComponent(fp) });
  }
  return { cleaned, blocks };
}

function firstUserText(entry) {
  const c = entry?.message?.content;
  if (typeof c === 'string') return fileBlocksFromIndex(stripReminders(c)).cleaned;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text' && b.text) {
        const t = fileBlocksFromIndex(stripReminders(b.text)).cleaned;
        if (t) return t;
      }
    }
  }
  return '';
}

/* Cursor never writes meta.title for sessions started outside its UI, which
   left the sidebar full of hash names. Derive a title from the first real
   user message instead. The first message never changes, so cache hits are
   permanent — listProjects gets polled and must stay cheap. */
const titleCache = new Map();   // chatId -> derived title

function autoTitle(chatId) {
  const hit = titleCache.get(chatId);
  if (hit !== undefined) return hit;
  const fp = findTranscript(chatId);
  if (!fp) return '';            // no transcript yet: retry next poll, don't cache
  let head = '';
  try {
    const fd = fs.openSync(fp, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }

  let soft = '';
  let assistant = '';
  let seenUser = 0;
  for (const line of head.split('\n')) {
    const e = safeParse(line);
    if (!e) continue;
    const role = e.type === 'user' ? 'user' : (e.type === 'assistant' ? 'assistant' : e.role);
    if (role === 'assistant' && !assistant) {
      const c = e.message?.content;
      let raw = '';
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) raw = c.find(b => b.type === 'text' && b.text)?.text || '';
      const first = String(raw).split('\n').map(s => s.trim()).find(Boolean) || '';
      const greet = /^(你好[！!,，.。]?|hi[,!]?\s)|需要我帮你做什么|有什么我可以帮你/;
      if (first && first.length > 8 && !greet.test(first)) {
        assistant = first.replace(/\s+/g, ' ').slice(0, 48);
      }
      continue;
    }
    if (role !== 'user') continue;
    let raw = '';
    const c = e.message?.content;
    if (typeof c === 'string') raw = c;
    else if (Array.isArray(c)) raw = c.find(b => b.type === 'text' && b.text)?.text || '';
    if (!raw) continue;
    // the actual question lives inside <user_query>; everything around it is envelope
    const m = raw.match(/<user_query>\s*([\s\S]*?)<\/user_query>/);
    const cleaned = stripReminders(m ? m[1] : raw);
    const { title, quality } = pickTitleFromText(cleaned);
    if (quality === 'hard' && title) {
      titleCache.set(chatId, title);
      return title;
    }
    if (!soft && title) soft = title;
    if (++seenUser >= 12) break;
  }
  const picked = soft || assistant;
  if (picked) titleCache.set(chatId, picked);
  return picked;
}

function findTranscript(chatId) {
  if (!chatId || chatId.includes('/') || chatId.includes('..')) return null;
  let slugs;
  try { slugs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const slug of slugs) {
    const fp = path.join(PROJECTS_DIR, slug, 'agent-transcripts', chatId, chatId + '.jsonl');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

function normalizeEntry(e) {
  const role = e.type === 'user' || e.type === 'assistant' ? e.type : e.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const raw = e.message?.content;
  let blocks = [];
  if (typeof raw === 'string') {
    if (role === 'user') {
      const { cleaned, blocks: extra } = fileBlocksFromIndex(stripReminders(raw));
      blocks.push(...extra);
      if (cleaned) blocks.push({ type: 'text', text: cleaned });
    } else if (raw) {
      blocks.push({ type: 'text', text: raw });
    }
  } else if (Array.isArray(raw)) {
    for (const b of raw) {
      if (b.type === 'text') {
        if (role === 'user') {
          const { cleaned, blocks: extra } = fileBlocksFromIndex(stripReminders(b.text || ''));
          blocks.push(...extra);
          if (cleaned) blocks.push({ type: 'text', text: cleaned });
        } else if (b.text) {
          blocks.push({ type: 'text', text: b.text });
        }
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        blocks.push({ type: 'thinking', text: b.thinking });
      } else if (b.type === 'tool_use') {
        blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        const data = b.source.data || '';
        if (data.length <= 2_000_000) blocks.push({ type: 'image', mediaType: b.source.media_type, data });
        else blocks.push({ type: 'text', text: '[图片过大，未在此处加载]' });
      } else if (b.type === 'tool_result') {
        let content = b.content;
        const images = [];
        if (Array.isArray(content)) {
          const parts = [];
          for (const x of content) {
            if (x.type === 'image' && x.source?.type === 'base64') {
              const data = x.source.data || '';
              if (data.length <= 2_000_000) images.push({ mediaType: x.source.media_type, data });
              else parts.push('[图片过大，未在此处加载]');
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
  return { role, blocks, timestamp: e.timestamp || null };
}

export function isCursorSlug(slug) {
  return typeof slug === 'string' && slug.startsWith(SLUG_PREFIX);
}

export function findSessionMeta(id) {
  if (!id || id.includes('/') || id.includes('..')) return null;
  let wsDirs;
  try { wsDirs = fs.readdirSync(CHATS_DIR); } catch { return null; }
  for (const wsHash of wsDirs) {
    const metaPath = path.join(CHATS_DIR, wsHash, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return {
        slug: SLUG_PREFIX + wsHash,
        engine: 'cursor',
        title: meta.title || autoTitle(id) || id.slice(0, 8),
        cwd: meta.cwd || '',
      };
    } catch {
      return { slug: SLUG_PREFIX + wsHash, engine: 'cursor', title: autoTitle(id) || id.slice(0, 8), cwd: '' };
    }
  }
  return null;
}

export function listProjects() {
  if (!fs.existsSync(CHATS_DIR)) return [];
  const projects = [];
  for (const wsHash of fs.readdirSync(CHATS_DIR)) {
    const wsDir = path.join(CHATS_DIR, wsHash);
    let chatIds;
    try { chatIds = fs.readdirSync(wsDir); } catch { continue; }
    const sessions = [];
    let projCwd = '';
    for (const chatId of chatIds) {
      const metaPath = path.join(wsDir, chatId, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
      if (meta.hasConversation === false) continue;
      const fp = findTranscript(chatId);
      let msgCount = null;
      if (fp) {
        try {
          const stat = fs.statSync(fp);
          if (stat.size <= 8 * 1024 * 1024) {
            msgCount = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean)
              .map(safeParse).filter(normalizeEntry).length;
          }
        } catch { /* skip count */ }
      }
      if (msgCount == null) {
        try {
          const hist = JSON.parse(fs.readFileSync(path.join(wsDir, chatId, 'prompt_history.json'), 'utf8'));
          if (Array.isArray(hist)) msgCount = hist.length;
        } catch { /* optional */ }
      }
      if (!projCwd && meta.cwd) projCwd = meta.cwd;
      sessions.push({
        id: chatId,
        engine: 'cursor',
        title: meta.title || autoTitle(chatId) || chatId.slice(0, 8),
        cwd: meta.cwd || '',
        mtimeMs: meta.updatedAtMs || meta.createdAtMs || 0,
        msgCount,
      });
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    projects.push({
      slug: SLUG_PREFIX + wsHash,
      engine: 'cursor',
      cwd: projCwd,
      sessions,
      mtimeMs: sessions[0].mtimeMs,
    });
  }
  projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return projects;
}

export function readSession(slug, id, { end, limit = 200 } = {}) {
  if (!isCursorSlug(slug) || id.includes('/') || id.includes('..')) throw new Error('bad path');
  const fp = findTranscript(id);
  if (!fp) throw new Error('cursor 会话 transcript 尚未落盘，请先在 Cursor 里说过至少一轮');
  const stat = fs.statSync(fp);
  if (stat.size > MAX_FILE_BYTES) throw new Error('session file too large (>1GB)');

  const metaPath = path.join(CHATS_DIR, slug.slice(SLUG_PREFIX.length), id, 'meta.json');
  let cwd = '', title = '';
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    cwd = meta.cwd || '';
    title = meta.title || '';
  } catch { /* optional */ }

  const buf = fs.readFileSync(fp);
  const ranges = [];
  let pos = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos);
    if (nl === -1) nl = buf.length;
    if (nl > pos) {
      const e = safeParse(buf.toString('utf8', pos, nl));
      if (e && normalizeEntry(e)) ranges.push([pos, nl]);
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
  if (!title) {
    title = autoTitle(id);
    if (!title) {
      for (const m of messages) {
        if (m.role !== 'user') continue;
        const t = m.blocks.find(b => b.type === 'text')?.text || '';
        const { title: picked, quality } = pickTitleFromText(t);
        if (quality === 'hard' && picked) { title = picked; break; }
        if (!title && picked) title = picked;
      }
    }
  }
  return { id, slug, engine: 'cursor', cwd, title: title || '(无标题)', total, start: from, messages, bytes: stat.size };
}

/** Cursor agent-transcript mtimes for activity dots */
export function scanMtimes(windowMs) {
  const cutoff = Date.now() - windowMs;
  const out = new Map();
  let slugs;
  try { slugs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const slug of slugs) {
    const dir = path.join(PROJECTS_DIR, slug, 'agent-transcripts');
    let chats;
    try { chats = fs.readdirSync(dir); } catch { continue; }
    for (const chatId of chats) {
      const fp = path.join(dir, chatId, chatId + '.jsonl');
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs >= cutoff) out.set(chatId, st.mtimeMs);
      } catch { /* gone */ }
    }
  }
  return out;
}
