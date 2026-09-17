/**
 * 个人 ASR 词典调度: 对话在驾驶舱, 热词在 Fun-ASR。
 *
 * 第一性原理: 热词是解码偏置。用户打字频率 ≠ 会说出口的专名。
 * 抽取算法在 funasr-studio/funasr_web/lexicon.py (有测试)。这里只负责:
 *   - 每完成 N 轮聊天跑一次 harvest
 *   - 用户通道 + 助手通道(仅确认过的拉丁产品名) 都在那一次 harvest 里
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(os.homedir(), '.claude-cockpit', 'asr-lexicon-state.json');
const OUT_FILE = path.join(os.homedir(), '.claude-cockpit', 'asr-lexicon.json');
const DEFAULT_EVERY = 8;

function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return fallback; }
}

function writeJson(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
}

export function funasrUrl() {
  const cfg = readJson(path.join(os.homedir(), '.claude-cockpit', 'config.json'), {});
  const u = (cfg.asrLexicon?.url || process.env.FUNASR_URL || 'http://127.0.0.1:8780').trim();
  return u.replace(/\/$/, '') || 'http://127.0.0.1:8780';
}

export function everyChats() {
  const cfg = readJson(path.join(os.homedir(), '.claude-cockpit', 'config.json'), {});
  const n = Number(cfg.asrLexicon?.everyChats);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_EVERY;
}

export function shouldHarvest(chatsSince, every = everyChats()) {
  return chatsSince >= every;
}

export function funasrDir() {
  const cands = [
    process.env.FUNASR_STUDIO,
    path.join(os.homedir(), 'projects', 'funasr-studio'),
    path.resolve(__dirname, '..', '..', 'funasr-studio'),
  ].filter(Boolean);
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'funasr_web', 'lexicon.py'))) return d;
  }
  return '';
}

function pythonBin() {
  const cfg = readJson(path.join(os.homedir(), '.claude-cockpit', 'config.json'), {});
  return cfg.asrLexicon?.python || process.env.FUNASR_PYTHON || 'python3';
}

let inflight = null;

export function noteChatFinished() {
  if (readJson(path.join(os.homedir(), '.claude-cockpit', 'config.json'), {}).asrLexicon?.enabled === false) {
    return { skipped: true, reason: 'disabled' };
  }
  const st = readJson(STATE_FILE, { chatsSince: 0 });
  st.chatsSince = (st.chatsSince || 0) + 1;
  writeJson(STATE_FILE, st);
  if (!shouldHarvest(st.chatsSince)) {
    return { skipped: true, chatsSince: st.chatsSince, every: everyChats() };
  }
  return harvest({ reset: true });
}

export function harvest({ reset = false } = {}) {
  const dir = funasrDir();
  if (!dir) return { ok: false, error: 'funasr-studio not found' };
  if (inflight) return inflight;
  inflight = new Promise((resolve) => {
    const args = [
      path.join(dir, 'funasr_web', 'lexicon.py'),
      'harvest',
      '--out', OUT_FILE,
      '--cap', '36',
    ];
    const child = spawn(pythonBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => {
      inflight = null;
      resolve({ ok: false, error: String(e) });
    });
    child.on('close', (code) => {
      inflight = null;
      if (reset && code === 0) writeJson(STATE_FILE, { chatsSince: 0, lastHarvest: Date.now() });
      resolve({
        ok: code === 0,
        code,
        out: out.trim(),
        error: code === 0 ? '' : (err.trim() || `exit ${code}`),
        file: OUT_FILE,
      });
    });
  });
  return inflight;
}

export function status() {
  const st = readJson(STATE_FILE, { chatsSince: 0 });
  const lex = readJson(OUT_FILE, null);
  return {
    every: everyChats(),
    chatsSince: st.chatsSince || 0,
    lastHarvest: st.lastHarvest || null,
    funasrDir: funasrDir() || null,
    funasrUrl: funasrUrl(),
    terms: Array.isArray(lex?.terms) ? lex.terms.length : 0,
    file: fs.existsSync(OUT_FILE) ? OUT_FILE : null,
  };
}
