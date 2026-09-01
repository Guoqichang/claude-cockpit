import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { IS_WIN, resolveBin, runPythonFile } from './proc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PY = path.join(__dirname, 'hermes-db.py');
const CFG = path.join(os.homedir(), '.claude-cockpit', 'config.json');

export function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { return {}; }
}

export function hermesHome() {
  return process.env.HERMES_HOME
    || readCfg().hermes?.home
    || path.join(os.homedir(), '.hermes');
}

export function hermesBin() {
  const fromCfg = readCfg().hermes?.bin;
  if (fromCfg && fs.existsSync(fromCfg)) return fromCfg;
  if (process.env.HERMES_BIN && fs.existsSync(process.env.HERMES_BIN)) return process.env.HERMES_BIN;
  const names = IS_WIN ? ['hermes.exe', 'hermes.cmd', 'hermes'] : ['hermes'];
  return resolveBin(names, [path.join(os.homedir(), '.hermes', 'bin')]) || names[0];
}

export function localDbPath() {
  return path.join(hermesHome(), 'state.db');
}

export function hasLocalHermes() {
  return fs.existsSync(localDbPath());
}

export function hermesRemote() {
  const r = readCfg().hermes?.remote;
  if (!r?.url) return null;
  return { url: String(r.url).replace(/\/+$/, ''), token: r.token || '' };
}

function remoteHeaders(r) {
  const h = { Accept: 'application/json' };
  if (r.token) h.Authorization = 'Bearer ' + r.token;
  return h;
}

export function runDb(args) {
  const out = runPythonFile(DB_PY, args, {
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
    env: { HERMES_HOME: hermesHome() },
  });
  return JSON.parse(out);
}

export async function remoteFetch(pathname, opts = {}) {
  const r = hermesRemote();
  if (!r) throw new Error('hermes remote 未配置');
  const res = await fetch(r.url + pathname, {
    ...opts,
    headers: { ...remoteHeaders(r), ...(opts.headers || {}) },
    signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 20000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || data.detail || `hermes remote ${res.status}`);
  return data;
}

export function hermesStatus() {
  const remote = hermesRemote();
  return {
    local: hasLocalHermes(),
    db: hasLocalHermes() ? localDbPath() : null,
    bin: hermesBin(),
    remote: remote ? { url: remote.url, hasToken: !!remote.token } : null,
  };
}
