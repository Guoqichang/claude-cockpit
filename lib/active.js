import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION_FLAG = new RegExp(`--(?:resume|session-id|continue-session)[= ](${UUID})`, 'g');
const WORKING_WINDOW_MS = 20000;
const CHANGED_WINDOW_MS = 10 * 60 * 1000;   // lets other devices notice edits they missed
const PS_CACHE_MS = 2000;

let psCache = { at: 0, ids: [] };

// Session ids held by a live claude process (CLI, VSCode extension, or cockpit).
// The process may be idle waiting for input — that's "attached", not "working".
function scanAttached() {
  return new Promise((resolve) => {
    if (Date.now() - psCache.at < PS_CACHE_MS) { resolve(psCache.ids); return; }
    execFile('ps', ['-axo', 'command='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(psCache.ids); return; }
      const ids = new Set();
      for (const line of stdout.split('\n')) {
        if (!/claude/i.test(line)) continue;
        for (const m of line.matchAll(SESSION_FLAG)) ids.add(m[1]);
      }
      psCache = { at: Date.now(), ids: [...ids] };
      resolve(psCache.ids);
    });
  });
}

// Recently written session files: the short window means "a turn is in flight",
// the long one lets any client detect edits another device made.
function scanMtimes(windowMs) {
  const cutoff = Date.now() - windowMs;
  const out = new Map();
  let slugs;
  try { slugs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const slug of slugs) {
    let files;
    try { files = fs.readdirSync(path.join(PROJECTS_DIR, slug)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(path.join(PROJECTS_DIR, slug, f));
        if (st.mtimeMs >= cutoff) out.set(f.replace(/\.jsonl$/, ''), st.mtimeMs);
      } catch { /* vanished mid-scan */ }
    }
  }
  return out;
}

export async function getActive() {
  const attached = await scanAttached();
  const changed = scanMtimes(CHANGED_WINDOW_MS);
  const now = Date.now();
  const attachedSet = new Set(attached);
  // "working" needs both signals: a live process AND recent writes. Freshness alone
  // would light up a session that a just-exited process wrote to seconds ago.
  const fresh = new Set([...changed].filter(([, m]) => now - m <= WORKING_WINDOW_MS).map(([id]) => id));
  const working = [...fresh].filter(id => attachedSet.has(id));
  return {
    working, attached,
    idle: attached.filter(id => !fresh.has(id)),
    changed: Object.fromEntries(changed),
  };
}
