import { hasLocalOpencode, runDb } from './opencode.js';

export const SLUG_PREFIX = 'opencode:';

export function isOpencodeSlug(slug) {
  return typeof slug === 'string' && (slug === 'opencode' || slug.startsWith(SLUG_PREFIX));
}

export function isOpencodeId(id) {
  return typeof id === 'string' && id.startsWith('ses_');
}

function groupLabel(group) {
  if (group === 'reverse') return 'OpenCode · reverse';
  if (group === 'eval') return 'OpenCode · eval';
  if (group === 'build') return 'OpenCode · build';
  if (group === 'reverse-local') return 'OpenCode · reverse-local';
  return 'OpenCode · ' + (group || 'opencode');
}

function asProjects(sessions) {
  const byGroup = new Map();
  for (const s of sessions) {
    const group = s.group || s.agent || 'opencode';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({
      id: s.id,
      engine: 'opencode',
      title: s.title || s.id,
      cwd: s.cwd || '',
      mtimeMs: s.mtimeMs || 0,
      msgCount: s.msgCount ?? 0,
      model: s.model || '',
      agent: s.agent || '',
    });
  }
  const projects = [];
  for (const [group, list] of byGroup) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    projects.push({
      slug: SLUG_PREFIX + group,
      engine: 'opencode',
      cwd: groupLabel(group),
      sessions: list,
      mtimeMs: list[0]?.mtimeMs || 0,
    });
  }
  return projects;
}

export function listProjects() {
  if (!hasLocalOpencode()) return [];
  try { return asProjects(runDb(['list'])); }
  catch { return []; }
}

export function readSession(slug, id, { end, limit = 200 } = {}) {
  if (id.includes('/') || id.includes('..')) throw new Error('bad path');
  const args = ['read', id, end == null ? '' : String(end), String(limit || 200)];
  const data = runDb(args);
  return { ...data, slug: slug || data.slug, engine: 'opencode' };
}

export function findSessionMeta(id) {
  if (!id || id.includes('/') || id.includes('..') || !isOpencodeId(id)) return null;
  if (!hasLocalOpencode()) return null;
  try { return { ...runDb(['meta', id]), engine: 'opencode' }; }
  catch { return null; }
}

export function searchContent(q) {
  const query = String(q || '').trim();
  if (!query || !hasLocalOpencode()) return [];
  try {
    const rows = runDb(['search', query, '50']);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
