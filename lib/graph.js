import fs from 'fs';
import path from 'path';
import os from 'os';
import { listProjects } from './session-router.js';
import { listChats } from './chat.js';
import { getActive } from './active.js';

// Node graph over sessions: size from volume+recency, state from live signals,
// clusters from title/cwd content. Everything derives from data we already have
// on disk — no extra model calls.
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 48 * 1024;
const HOUR = 3600 * 1000;

// tail scan cache: id -> { mtimeMs, info }
const tailCache = new Map();

function sessionPath(slug, id) {
  return path.join(CLAUDE_DIR, slug, id + '.jsonl');
}

function readTail(fp, bytes) {
  const stat = fs.statSync(fp);
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8', 0, n), mtimeMs: stat.mtimeMs };
  } finally { fs.closeSync(fd); }
}

const userText = (e) => {
  const c = e?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  return '';
};

/**
 * Goal/loop state is not persisted as its own entry type, so we read it back
 * from the commands the user actually sent (last one wins, `clear` cancels).
 * Also grabs the latest assistant line for the overview's live window.
 */
function scanTail(slug, id) {
  const fp = sessionPath(slug, id);
  let stat;
  try { stat = fs.statSync(fp); } catch { return null; }
  const hit = tailCache.get(id);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.info;

  let text;
  try { ({ text } = readTail(fp, TAIL_BYTES)); } catch { return null; }
  const lines = text.split('\n').slice(1);   // first line is likely truncated

  const info = { goal: null, loop: null, lastAssistant: '', lastUser: '', lastError: false, lastCost: null };
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'user' && !e.isMeta && !e.isSidechain) {
      const t = userText(e).trim();
      if (t) info.lastUser = t.slice(0, 200);
      const m = t.match(/^\/(goal|loop)\b\s*(.*)$/s);
      if (m) {
        const [, kind, rest] = m;
        const arg = rest.trim().slice(0, 120);
        if (/^(clear|stop|off)\b/i.test(arg)) info[kind] = null;
        else info[kind] = arg || '(未写条件)';
      }
    } else if (e.type === 'assistant') {
      const c = e.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b.type === 'text' && b.text?.trim()) info.lastAssistant = b.text.trim().slice(0, 300);
      }
    } else if (e.type === 'result') {
      info.lastError = !!e.is_error;
      if (e.total_cost_usd != null) info.lastCost = e.total_cost_usd;
    }
  }
  tailCache.set(id, { mtimeMs: stat.mtimeMs, info });
  return info;
}

// ---------------- clustering ----------------
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', '项目', '一个', '问题', '如何', '实现', '使用', '进行', '分析', '功能']);

function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const w of s.match(/[a-z][a-z0-9_-]{2,}/g) || []) if (!STOP.has(w)) out.push(w);
  // CJK has no spaces: bigrams approximate words well enough for grouping
  for (const run of s.match(/[一-鿿]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOP.has(bg)) out.push(bg);
    }
  }
  return out;
}

function clusterNodes(nodes) {
  const docs = nodes.map(n => {
    const counts = new Map();
    for (const t of tokenize(n.title + ' ' + path.basename(n.cwd || ''))) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return counts;
  });
  const df = new Map();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length || 1;

  // idf-weighted unit vectors; terms in almost every doc carry no signal
  const vecs = docs.map(d => {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of d) {
      const freq = df.get(t) || 1;
      if (freq < 2 || freq > N * 0.4) continue;
      const w = (1 + Math.log(c)) * Math.log(N / freq);
      v.set(t, w); norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });

  const cos = (a, b) => {
    let s = 0;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    for (const [t, w] of small) { const o = big.get(t); if (o) s += w * o; }
    return s;
  };

  const order = nodes.map((n, i) => i).sort((a, b) => nodes[b].mtimeMs - nodes[a].mtimeMs);
  const clusters = [];
  for (const i of order) {
    let best = -1, bestSim = 0.22;   // below this it is its own topic
    for (let c = 0; c < clusters.length; c++) {
      const sim = cos(vecs[i], clusters[c].centroid);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best < 0) {
      clusters.push({ members: [i], centroid: new Map(vecs[i]), cwd: nodes[i].cwd });
      nodes[i].cluster = clusters.length - 1;
    } else {
      const cl = clusters[best];
      cl.members.push(i);
      for (const [t, w] of vecs[i]) cl.centroid.set(t, ((cl.centroid.get(t) || 0) * cl.members.length + w) / (cl.members.length + 1));
      nodes[i].cluster = best;
    }
  }

  // singletons are noise on a map; fold them into a per-directory bucket
  const dirBucket = new Map();
  for (const cl of clusters) {
    if (cl.members.length > 1) continue;
    const key = nodes[cl.members[0]].cwd || '~';
    if (!dirBucket.has(key)) dirBucket.set(key, []);
    dirBucket.get(key).push(cl.members[0]);
    cl.members = [];
  }
  const HOUR_MS = 3600 * 1000, now = Date.now();
  const band = (n) => {
    const h = (now - n.mtimeMs) / HOUR_MS;
    return h < 24 ? '今天' : h < 24 * 7 ? '本周' : h < 24 * 30 ? '本月' : '更早';
  };
  for (const [dir, members] of dirBucket) {
    if (!members.length) continue;
    // one giant "misc" blob swallows the map; split it by recency so it reads
    if (members.length > 16) {
      const byBand = new Map();
      for (const i of members) {
        const b = band(nodes[i]);
        if (!byBand.has(b)) byBand.set(b, []);
        byBand.get(b).push(i);
      }
      for (const [b, ms] of byBand) {
        clusters.push({ members: ms, centroid: new Map(), cwd: dir, dirOnly: true, band: b });
        for (const i of ms) nodes[i].cluster = clusters.length - 1;
      }
    } else {
      clusters.push({ members, centroid: new Map(), cwd: dir, dirOnly: true });
      for (const i of members) nodes[i].cluster = clusters.length - 1;
    }
  }

  // CJK terms come out as bigrams; stitch overlapping ones back into words
  const stitch = (terms) => {
    const out = [];
    for (const t of terms) {
      const prev = out[out.length - 1];
      if (prev && /[一-鿿]/.test(t) && prev.slice(-1) === t[0]) out[out.length - 1] = prev + t.slice(1);
      else if (prev && /[一-鿿]/.test(t) && prev.includes(t)) continue;
      else out.push(t);
    }
    return out;
  };

  const out = [];
  for (let idx = 0; idx < clusters.length; idx++) {
    const cl = clusters[idx];
    if (!cl.members.length) { out.push(null); continue; }
    let label;
    if (cl.dirOnly) {
      const base = cl.cwd && cl.cwd !== '~' ? path.basename(cl.cwd) || cl.cwd : '零散会话';
      label = cl.band ? `${base} · ${cl.band}` : base;
    } else {
      const tally = new Map();
      for (const i of cl.members) for (const [t, w] of vecs[i]) tally.set(t, (tally.get(t) || 0) + w);
      const top = stitch([...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t));
      label = top.slice(0, 2).join(' · ') || path.basename(cl.cwd || '') || '其他';
    }
    out.push({ id: idx, label, size: cl.members.length, dirOnly: !!cl.dirOnly });
  }
  // renumber so the client gets a dense list
  const remap = new Map();
  const kept = [];
  out.forEach((c, i) => { if (c) { remap.set(i, kept.length); c.id = kept.length; kept.push(c); } });
  for (const n of nodes) if (remap.has(n.cluster)) n.cluster = remap.get(n.cluster);
  return kept;
}

// ---------------- assembly ----------------
export async function buildGraph() {
  const projects = listProjects();
  const chats = listChats();
  const active = await getActive();
  const working = new Set(active.working || []);
  const attached = new Set(active.attached || []);
  const now = Date.now();

  const runningBySession = new Map();
  for (const c of chats) if (c.running && c.sessionId) runningBySession.set(c.sessionId, c);

  const nodes = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      const tail = p.engine === 'cursor' ? null : scanTail(p.slug, s.id);
      const live = runningBySession.get(s.id) || null;
      const ageH = (now - s.mtimeMs) / HOUR;
      const state = live || working.has(s.id) ? 'running'
        : attached.has(s.id) ? 'open'
        : tail?.lastError ? 'error'
        : ageH < 24 ? 'warm' : 'cold';

      nodes.push({
        id: s.id,
        slug: p.slug,
        engine: s.engine || p.engine || 'claude',
        title: s.title,
        renamed: !!s.renamed,
        cwd: s.cwd || p.cwd || '',
        msgCount: s.msgCount ?? null,
        mtimeMs: s.mtimeMs,
        ageHours: Math.round(ageH * 10) / 10,
        state,
        goal: tail?.goal || null,
        loop: tail?.loop || null,
        lastAssistant: tail?.lastAssistant || '',
        lastUser: tail?.lastUser || '',
        lastCost: tail?.lastCost ?? null,
        activity: live?.activity || null,
        runningSince: live?.startedAt || null,
        ch: live?.ch || null,
      });
    }
  }

  const clusters = clusterNodes(nodes);

  for (const n of nodes) {
    // attention = "what would I regret not looking at right now"
    const recency = Math.max(0, 1 - n.ageHours / 48);
    let score = 0;
    if (n.state === 'running') score += 55;
    if (n.state === 'error') score += 45;
    if (n.goal) score += 30;
    if (n.loop) score += 20;
    if (n.state === 'open') score += 12;
    score += recency * 25;
    score += Math.min(10, Math.log10((n.msgCount || 1) + 1) * 4);
    n.attention = Math.round(score * 10) / 10;
    n.reasons = [
      n.state === 'running' && '正在跑',
      n.state === 'error' && '上轮报错',
      n.goal && 'goal 进行中',
      n.loop && 'loop 进行中',
      n.state === 'open' && '已在别处打开',
      n.ageHours < 2 && '刚刚活动过',
    ].filter(Boolean);
  }

  nodes.sort((a, b) => b.attention - a.attention);
  return { nodes, clusters, generatedAt: now };
}
