import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

export const IS_WIN = process.platform === 'win32';

export function pathSep() {
  return IS_WIN ? ';' : ':';
}

export function extraBinDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    IS_WIN ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode') : '',
  ].filter(Boolean);
}

export function withHomeEnv(extra = {}) {
  const home = os.homedir();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: process.env.USERPROFILE || home,
    ...extra,
  };
  const dirs = extraBinDirs().filter((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });
  if (dirs.length) {
    const cur = env.PATH || env.Path || '';
    env.PATH = [...dirs, cur].join(pathSep());
    if (IS_WIN) env.Path = env.PATH;
  }
  return env;
}

export function spawnCommon(extra = {}) {
  return {
    windowsHide: true,
    ...extra,
    env: withHomeEnv(extra.env || {}),
  };
}

export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return false;
  if (IS_WIN) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 8000, stdio: 'ignore', windowsHide: true,
      });
      return true;
    } catch { return false; }
  }
  try { process.kill(-pid, signal); return true; }
  catch { try { process.kill(pid, signal); return true; } catch { return false; } }
}

function looksExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (IS_WIN) return /\.(exe|cmd|bat)$/i.test(p) || !path.extname(p);
    return !!(st.mode & 0o111);
  } catch { return false; }
}

export function resolveBin(names, extraDirs = []) {
  const list = Array.isArray(names) ? names : [names];
  const dirs = [...extraDirs, ...extraBinDirs()];
  for (const name of list) {
    if (!name) continue;
    if (path.isAbsolute(name) && looksExecutable(name)) return name;
    for (const dir of dirs) {
      const cands = [path.join(dir, name)];
      if (IS_WIN && !path.extname(name)) {
        cands.push(path.join(dir, name + '.exe'), path.join(dir, name + '.cmd'));
      }
      for (const p of cands) {
        if (looksExecutable(p)) return p;
      }
    }
  }
  const finder = IS_WIN ? 'where' : 'which';
  for (const name of list) {
    try {
      const out = execFileSync(finder, [name], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        env: withHomeEnv(),
      }).trim().split(/\r?\n/)[0];
      if (out && looksExecutable(out)) return out;
    } catch { /* not on PATH */ }
  }
  return null;
}

let cachedPy = undefined;

/** @returns {string[] | null} argv prefix, e.g. ['python3'] or ['py','-3'] */
export function pythonArgv() {
  if (cachedPy !== undefined) return cachedPy;
  const tries = IS_WIN
    ? [['py', '-3'], ['python'], ['python3']]
    : [['python3'], ['python']];
  for (const argv of tries) {
    try {
      const r = spawnSync(argv[0], [...argv.slice(1), '-c', 'import sqlite3, json, sys; sys.exit(0)'], {
        timeout: 4000, stdio: 'ignore', windowsHide: true, env: withHomeEnv(),
      });
      if (r.status === 0) { cachedPy = argv; return argv; }
    } catch { /* next */ }
  }
  cachedPy = null;
  return null;
}

export function runPythonFile(script, args, opts = {}) {
  const py = pythonArgv();
  if (!py) {
    throw new Error(IS_WIN
      ? '找不到 Python 3。可先 winget install Python.Python.3.12 ，装完重开终端。'
      : '找不到 python3。');
  }
  return execFileSync(py[0], [...py.slice(1), script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
    env: { ...withHomeEnv(opts.env || {}) },
  });
}

export function localShell() {
  if (!IS_WIN) return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] };
  const ps = resolveBin(['pwsh', 'powershell']) || process.env.ComSpec || 'powershell.exe';
  if (/powershell|pwsh/i.test(ps)) return { file: ps, args: ['-NoLogo', '-NoExit'] };
  return { file: ps, args: [] };
}
