import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { IS_WIN, resolveBin, runPythonFile, spawnCommon } from './proc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PY = path.join(__dirname, 'opencode-db.py');
const CFG = path.join(os.homedir(), '.claude-cockpit', 'config.json');
const PID_FILE = path.join(os.homedir(), '.claude-cockpit', 'opencode-serve.pid');
const LOG_FILE = path.join(os.homedir(), '.claude-cockpit', 'opencode-serve.log');
const DEFAULT_PORT = 7801;
const DEFAULT_HOST = '127.0.0.1';

export function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { return {}; }
}

export function ocBin() {
  const fromCfg = readCfg().opencode?.bin;
  if (fromCfg && fs.existsSync(fromCfg)) return fromCfg;
  const envBin = process.env.OPENCODE_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const names = IS_WIN ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'];
  return resolveBin(names) || names[0];
}

export function ocBinOk() {
  const bin = ocBin();
  return !!(bin && fs.existsSync(bin));
}

export function ocConfigDir() {
  return path.join(os.homedir(), '.config', 'opencode');
}

export function ocConfigPath() {
  const dir = ocConfigDir();
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  if (fs.existsSync(json)) return json;
  if (fs.existsSync(jsonc)) return jsonc;
  return json;
}

export function ocDbPath() {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const fromCfg = readCfg().opencode?.db;
  if (fromCfg) return fromCfg;
  const home = os.homedir();
  const cands = [
    path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db'),
    path.join(home, 'AppData', 'Local', 'opencode', 'opencode.db'),
  ].filter(Boolean);
  for (const p of cands) {
    if (fs.existsSync(p)) return p;
  }
  return cands[0];
}

export function hasLocalOpencode() {
  return fs.existsSync(ocDbPath());
}

export function ocPort() {
  const n = Number(readCfg().opencode?.port || process.env.OPENCODE_PORT || DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

export function ocBase() {
  const fromCfg = readCfg().opencode?.url;
  if (fromCfg) return String(fromCfg).replace(/\/+$/, '');
  return `http://${DEFAULT_HOST}:${ocPort()}`;
}

export function runDb(args) {
  const out = runPythonFile(DB_PY, args, {
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
    env: { OPENCODE_DB: ocDbPath() },
  });
  return JSON.parse(out);
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

async function pingBase(base, timeoutMs = 1500) {
  try {
    const res = await fetch(base + '/session', { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function writePid(pid) {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
  } catch { /* ignore */ }
}

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) || 0; }
  catch { return 0; }
}

function spawnServe() {
  const bin = ocBin();
  const port = ocPort();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  let child;
  try {
    child = spawn(bin, [
      'serve',
      '--port', String(port),
      '--hostname', DEFAULT_HOST,
      '--cors', 'http://127.0.0.1:7799',
      '--cors', 'http://127.0.0.1:7788',
      '--cors', 'http://localhost:7799',
    ], spawnCommon({
      cwd: os.homedir(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    }));
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  writePid(child.pid);
  return child.pid;
}

let ensuring = null;
let liveBase = null;

export async function ensureServe() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    if (liveBase && await pingBase(liveBase)) return { ok: true, base: liveBase, spawned: false };
    const base = ocBase();
    if (await pingBase(base)) {
      liveBase = base;
      return { ok: true, base, spawned: false };
    }

    // A leftover serve on the default TUI/web port is reusable — don't start a second one.
    if (await pingBase('http://127.0.0.1:4096')) {
      liveBase = 'http://127.0.0.1:4096';
      return { ok: true, base: liveBase, spawned: false, reused: true };
    }

    const existing = readPid();
    if (existing && alive(existing) && await pingBase(base, 2500)) {
      liveBase = base;
      return { ok: true, base, spawned: false };
    }

    spawnServe();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await pingBase(base, 800)) {
        liveBase = base;
        return { ok: true, base, spawned: true };
      }
    }
    throw new Error('OpenCode serve 启动超时（127.0.0.1:' + ocPort() + '）');
  })();
  try {
    return await ensuring;
  } finally {
    ensuring = null;
  }
}

export async function ocFetch(pathname, opts = {}) {
  const ensured = await ensureServe();
  liveBase = ensured.base;
  const res = await fetch(liveBase + pathname, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
    signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 20000),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text }; }
  if (!res.ok) {
    const err = data?.error || data?.message || data?.raw || `opencode ${res.status}`;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
  return data;
}

export async function ocFetchRaw(pathname, opts = {}) {
  const ensured = await ensureServe();
  liveBase = ensured.base;
  return fetch(liveBase + pathname, {
    ...opts,
    headers: { Accept: 'text/event-stream', ...(opts.headers || {}) },
    signal: opts.signal,
  });
}

export async function ocMcp() {
  try { return await ocFetch('/mcp', { timeoutMs: 4000 }); }
  catch { return {}; }
}

export function ocStatus() {
  return {
    local: hasLocalOpencode(),
    db: hasLocalOpencode() ? ocDbPath() : null,
    bin: ocBin(),
    binOk: ocBinOk(),
    serve: liveBase || ocBase(),
    port: ocPort(),
  };
}

export function parseOcModel(raw) {
  const s = String(raw || '').trim();
  if (!s) return { providerID: 'deepseek', modelID: 'deepseek-v4-pro' };
  if (s.includes('/')) {
    const i = s.indexOf('/');
    return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
  }
  return { providerID: 'deepseek', modelID: s };
}
