import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

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
  if (fromCfg) return fromCfg;
  const homeBin = path.join(os.homedir(), '.local', 'bin', 'hermes');
  if (fs.existsSync(homeBin)) return homeBin;
  return process.env.HERMES_BIN || 'hermes';
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
  const out = execFileSync('python3', [DB_PY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: hermesHome() },
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
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
