import { listProjects as listClaudeProjects, readSession as readClaudeSession, findSessionMeta as findClaudeSessionMeta } from './sessions.js';
import {
  listProjects as listCursorProjects,
  readSession as readCursorSession,
  findSessionMeta as findCursorSessionMeta,
  isCursorSlug,
} from './cursor-sessions.js';
import {
  listProjects as listHermesProjects,
  readSession as readHermesSession,
  findSessionMeta as findHermesSessionMeta,
  isHermesSlug,
} from './hermes-sessions.js';
import { getName } from './names.js';

// Single choke point for all engines: user-set titles are applied here, so
// every caller (sidebar, session read, push notifications) sees the same name.
function withName(s) {
  if (!s?.id) return s;
  const custom = getName(s.id);
  if (!custom) return s;
  return { ...s, title: custom, autoTitle: s.title, renamed: true };
}

export async function listProjects() {
  let hermes = [];
  try { hermes = await listHermesProjects(); }
  catch { hermes = []; }
  const all = [...listClaudeProjects(), ...listCursorProjects(), ...hermes];
  for (const p of all) p.sessions = p.sessions.map(withName);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all;
}

export async function readSession(slug, id, opts) {
  const data = isHermesSlug(slug)
    ? await readHermesSession(slug, id, opts)
    : isCursorSlug(slug)
      ? readCursorSession(slug, id, opts)
      : readClaudeSession(slug, id, opts);
  return withName(data);
}

export async function findSessionMeta(id) {
  const meta = findClaudeSessionMeta(id)
    || findCursorSessionMeta(id)
    || await findHermesSessionMeta(id);
  return meta ? withName({ id, ...meta }) : meta;
}
