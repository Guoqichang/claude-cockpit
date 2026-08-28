import fs from 'fs';
import path from 'path';
import os from 'os';

// User-chosen session titles. Kept beside our own state — never written into
// Claude/Cursor's own session files, which belong to those tools.
const FILE = path.join(os.homedir(), '.claude-cockpit', 'names.json');
const MAX_LEN = 80;

let cache = null;
let cacheMtime = 0;

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* not created yet */ }
  if (cache && mtime === cacheMtime) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { cache = {}; }
  cacheMtime = mtime;
  return cache;
}

export function allNames() { return { ...load() }; }

export function getName(id) {
  if (!id) return '';
  return load()[id] || '';
}

/** Empty name clears the override and the auto title takes over again. */
export function setName(id, name) {
  if (!id) throw new Error('missing session id');
  const map = { ...load() };
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (clean) map[id] = clean; else delete map[id];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
  cache = map;
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = 0; }
  return clean;
}
