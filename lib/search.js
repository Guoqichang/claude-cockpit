import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { findSessionMeta as findCursorSessionMeta } from './cursor-sessions.js';
import { searchContent as searchHermesContent } from './hermes-sessions.js';
import { searchContent as searchOpencodeContent } from './opencode-sessions.js';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CURSOR_PROJECTS = path.join(os.homedir(), '.cursor', 'projects');
const MAX_HITS = 80;
const MAX_Q = 80;
const SEARCH_MS = 8000;
const FILE_CAP = 4 * 1024 * 1024;

let cachedRg = undefined;
function whichRg() {
  if (cachedRg !== undefined) return cachedRg;
  const cands = ['rg', 'rg.exe', '/opt/homebrew/bin/rg', '/usr/local/bin/rg'];
  const versions = path.join(os.homedir(), '.local/share/cursor-agent/versions');
  try {
    for (const d of fs.readdirSync(versions).sort().reverse()) {
      cands.push(path.join(versions, d, 'rg'));
    }
  } catch { /* no Cursor agent install */ }
  for (const bin of cands) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (r.status === 0) { cachedRg = bin; return bin; }
  }
  cachedRg = null;
  return null;
}

function snippetAround(text, q, radius = 42) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const i = raw.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return raw.slice(0, 80);
  const start = Math.max(0, i - radius);
  const end = Math.min(raw.length, i + q.length + radius);
  return (start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '');
}

function textFromJsonish(line) {
  const s = String(line || '');
  try {
    const obj = JSON.parse(s);
    const c = obj.message?.content ?? obj.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((b) => (typeof b === 'string' ? b : (b?.text || b?.thinking || ''))).join(' ');
    }
    if (c && typeof c === 'object') return c.text || JSON.stringify(c);
  } catch { /* use raw line */ }
  return s
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/[{}\[\]"]/g, ' ');
}

function hitFromClaudePath(fp) {
  const id = path.basename(fp, '.jsonl');
  const slug = path.basename(path.dirname(fp));
  if (!id || id.includes('..')) return null;
  return { engine: 'claude', slug, id };
}

function hitFromCursorPath(fp) {
  const id = path.basename(fp, '.jsonl');
  if (!id || id.includes('..')) return null;
  const meta = findCursorSessionMeta(id);
  return { engine: 'cursor', slug: meta?.slug || ('cursor:' + path.basename(path.dirname(path.dirname(fp)))), id };
}

function walkJsonl(root, relDepth, acc, limit) {
  if (!fs.existsSync(root) || acc.length >= limit) return;
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const ent of names) {
    if (acc.length >= limit) return;
    const fp = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (relDepth < 4) walkJsonl(fp, relDepth + 1, acc, limit);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      acc.push(fp);
    }
  }
}

function scanFile(fp, q) {
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  let text = '';
  try {
    if (st.size <= FILE_CAP) {
      text = fs.readFileSync(fp, 'utf8');
    } else {
      const fd = fs.openSync(fp, 'r');
      try {
        const head = Buffer.alloc(2 * 1024 * 1024);
        const tail = Buffer.alloc(512 * 1024);
        const n1 = fs.readSync(fd, head, 0, head.length, 0);
        const n2 = fs.readSync(fd, tail, 0, tail.length, Math.max(0, st.size - tail.length));
        text = head.toString('utf8', 0, n1) + '\n' + tail.toString('utf8', 0, n2);
      } finally { fs.closeSync(fd); }
    }
  } catch { return null; }
  if (!text.toLowerCase().includes(q.toLowerCase())) return null;
  return snippetAround(textFromJsonish(text), q);
}

function rgMatches(root, q, deadline) {
  const rg = whichRg();
  if (!rg || !fs.existsSync(root)) return null;
  const left = Math.max(500, deadline - Date.now());
  const r = spawnSync(rg, [
    '-i', '-F',
    '--max-count', '1',
    '--glob', '*.jsonl',
    '--max-filesize', '32M',
    '--json',
    '--', q, root,
  ], {
    encoding: 'utf8',
    timeout: left,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return null;
  const hits = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'match') continue;
    const fp = ev.data?.path?.text;
    const text = ev.data?.lines?.text || ev.data?.submatches?.[0]?.match?.text || '';
    const extracted = textFromJsonish(text);
    const snippet = (extracted && extracted.toLowerCase().includes(q.toLowerCase()))
      ? snippetAround(extracted, q)
      : snippetAround(text, q);
    if (fp) hits.push({ fp, snippet });
  }
  return hits;
}

function searchJsonlTree(root, q, kind, deadline, limit) {
  const out = [];
  if (!fs.existsSync(root) || Date.now() > deadline) return out;
  const rgHits = rgMatches(root, q, deadline);
  if (rgHits) {
    for (const { fp, snippet } of rgHits) {
      if (out.length >= limit || Date.now() > deadline) break;
      if (kind === 'cursor' && !fp.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
      const meta = kind === 'cursor' ? hitFromCursorPath(fp) : hitFromClaudePath(fp);
      if (!meta) continue;
      out.push({ ...meta, snippet, where: 'content' });
    }
    return out;
  }
  const grepped = (() => {
    const left = Math.max(500, deadline - Date.now());
    const r = spawnSync('grep', ['-R', '-l', '-F', '-i', '--', q, root], {
      encoding: 'utf8', timeout: left, maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error && r.signal !== 'SIGTERM') return null;
    return (r.stdout || '').split('\n').map((s) => s.trim()).filter((f) => f.endsWith('.jsonl'));
  })();
  const files = grepped || [];
  if (!grepped) walkJsonl(root, 0, files, 800);
  for (const fp of files) {
    if (out.length >= limit || Date.now() > deadline) break;
    if (kind === 'cursor' && !fp.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
    const meta = kind === 'cursor' ? hitFromCursorPath(fp) : hitFromClaudePath(fp);
    if (!meta) continue;
    const snippet = scanFile(fp, q);
    if (!snippet) continue;
    out.push({ ...meta, snippet, where: 'content' });
  }
  return out;
}

export async function searchSessions(rawQ, { engine = '' } = {}) {
  const q = String(rawQ || '').trim().slice(0, MAX_Q);
  if (!q) return [];
  const want = String(engine || '').trim();
  const deadline = Date.now() + SEARCH_MS;
  const hits = [];
  const seen = new Set();
  const add = (row) => {
    if (!row?.id || seen.has(row.id)) return;
    if (want && row.engine !== want) return;
    seen.add(row.id);
    hits.push(row);
  };

  const per = want ? MAX_HITS : 25;
  if (!want || want === 'claude') {
    for (const h of searchJsonlTree(CLAUDE_DIR, q, 'claude', deadline, per)) add(h);
  }
  if (!want || want === 'cursor') {
    for (const h of searchJsonlTree(CURSOR_PROJECTS, q, 'cursor', deadline, per)) add(h);
  }
  if (!want || want === 'hermes') {
    try {
      const hermes = await searchHermesContent(q);
      for (const h of hermes) add({ ...h, engine: 'hermes', where: h.snippet ? 'content' : 'title' });
    } catch { /* remote/local Hermes may be down */ }
  }
  if (!want || want === 'opencode') {
    try {
      const oc = searchOpencodeContent(q);
      for (const h of oc) add({ ...h, engine: 'opencode', where: h.snippet ? 'content' : 'title' });
    } catch { /* OpenCode db may be locked */ }
  }
  return hits.slice(0, MAX_HITS);
}
