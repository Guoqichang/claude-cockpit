import { hasLocalHermes, hermesRemote, runDb, remoteFetch } from './hermes.js';

export const SLUG_PREFIX = 'hermes:';

export function isHermesSlug(slug) {
  return typeof slug === 'string' && (slug === 'hermes' || slug.startsWith(SLUG_PREFIX));
}

function asProjects(sessions) {
  const bySource = new Map();
  for (const s of sessions) {
    const source = s.source || 'cli';
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push({
      id: s.id,
      engine: 'hermes',
      title: s.title || s.id,
      cwd: s.cwd || '',
      mtimeMs: s.mtimeMs || 0,
      msgCount: s.msgCount ?? 0,
      model: s.model || '',
    });
  }
  const projects = [];
  for (const [source, list] of bySource) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    projects.push({
      slug: SLUG_PREFIX + source,
      engine: 'hermes',
      cwd: 'Hermes · ' + source,
      sessions: list,
      mtimeMs: list[0]?.mtimeMs || 0,
    });
  }
  return projects;
}

/* Hermes 是远程服务，一旦不通，每次刷新侧边栏都要干等满 8 秒超时，
   而且失败被静默吞成 []，调用方根本看不出是"挂了"还是"真没有"。
   三件事：失败后短路一分钟别再撞同一堵墙；保留上次成功的结果，
   免得会话凭空消失；即使要发起请求也只等 600ms，超出就先让侧边栏出来，
   结果由后台那次请求填进缓存，下一轮轮询自然带上。 */
let hermesDownUntil = 0;
let hermesLastGood = [];
let hermesInflight = null;

async function listRemoteProjects() {
  const r = hermesRemote();
  if (!r) return [];
  if (Date.now() < hermesDownUntil) return hermesLastGood;

  const wasInflight = !!hermesInflight;
  if (!hermesInflight) {
    hermesInflight = (async () => {
      try {
        const all = await remoteFetch('/api/projects', { timeoutMs: 5000 });
        if (Array.isArray(all)) {
          hermesLastGood = all.filter((p) => p.engine === 'hermes' || isHermesSlug(p.slug));
          hermesDownUntil = 0;
        } else {
          hermesDownUntil = Date.now() + 60000;
        }
      } catch {
        hermesDownUntil = Date.now() + 60000;
      } finally {
        hermesInflight = null;
      }
    })();
  }
  // 已经有人在等这次请求了，后来的调用直接拿上次结果走，别排队一起卡
  if (wasInflight) return hermesLastGood;
  await Promise.race([hermesInflight, new Promise((res) => setTimeout(res, 600))]);
  return hermesLastGood;
}

export async function listProjects() {
  if (hasLocalHermes()) {
    try { return asProjects(runDb(['list'])); }
    catch { return []; }
  }
  return listRemoteProjects();
}

export async function readSession(slug, id, { end, limit = 200 } = {}) {
  if (id.includes('/') || id.includes('..')) throw new Error('bad path');
  if (hasLocalHermes()) {
    const args = ['read', id, end == null ? '' : String(end), String(limit || 200)];
    const data = runDb(args);
    return { ...data, slug: slug || data.slug, engine: 'hermes' };
  }
  const r = hermesRemote();
  if (!r) throw new Error('Hermes 未安装，也没有配置远程主机');
  const q = new URLSearchParams();
  if (end != null) q.set('end', String(end));
  if (limit) q.set('limit', String(limit));
  const qs = q.toString() ? '?' + q.toString() : '';
  return remoteFetch(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(id)}${qs}`);
}

export async function findSessionMeta(id) {
  if (!id || id.includes('/') || id.includes('..')) return null;
  if (hasLocalHermes()) {
    try { return { ...runDb(['meta', id]), engine: 'hermes' }; }
    catch { return null; }
  }
  const projects = await listRemoteProjects();
  for (const p of projects) {
    const s = (p.sessions || []).find((x) => x.id === id);
    if (s) return { slug: p.slug, engine: 'hermes', ...s };
  }
  return null;
}

export async function searchContent(q) {
  const query = String(q || '').trim();
  if (!query) return [];
  if (hasLocalHermes()) {
    try {
      const rows = runDb(['search', query, '50']);
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }
  const r = hermesRemote();
  if (!r) return [];
  try {
    const data = await remoteFetch(
      '/api/search?engine=hermes&q=' + encodeURIComponent(query),
      { timeoutMs: 8000 },
    );
    const hits = Array.isArray(data) ? data : (data.hits || []);
    return hits.filter((h) => h && (h.engine === 'hermes' || String(h.slug || '').startsWith('hermes')));
  } catch { return []; }
}
