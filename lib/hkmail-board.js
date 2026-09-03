import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CFG = path.join(os.homedir(), '.claude-cockpit', 'config.json');

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { return {}; }
}

/** Local board process, or the pcy-02 cockpit /mail/ behind AUTH_ONLY. */
export function resolveBoardTarget() {
  const env = process.env.HKMAIL_BOARD_URL || '';
  if (env) {
    try { return { kind: 'local', url: new URL(env), prefix: '', token: '' }; }
    catch { /* fall through */ }
  }
  const cfg = readCfg();
  const peers = Array.isArray(cfg.peers) ? cfg.peers : [];
  const peer = peers.find((p) => p && p.id === 'pcy-02')
    || peers.find((p) => /100\.74\.77\.90/.test(String(p?.url || '')));
  const remote = cfg.hermes?.remote;
  const src = (peer?.url && peer) || (remote?.url && remote) || null;
  if (!src?.url) return null;
  try {
    return {
      kind: 'remote',
      url: new URL(String(src.url).replace(/\/+$/, '')),
      prefix: '/mail',
      token: src.token || '',
    };
  } catch {
    return null;
  }
}

export function mountHkmailBoard(app) {
  app.use('/mail', (req, res) => {
    const raw = String(req.originalUrl || '').split('?')[0];
    if (raw === '/mail') {
      res.redirect(302, '/mail/');
      return;
    }
    const t = resolveBoardTarget();
    if (!t) {
      res.status(503).type('html').send(
        '<!DOCTYPE html><meta charset="utf-8"><p>校邮看板在宿舍小主机上。本机还没配 pcy-02 的驾驶舱地址。</p>'
      );
      return;
    }
    const rest = req.url && req.url !== '' ? req.url : '/';
    const fwd = (t.prefix || '') + (rest.startsWith('/') ? rest : `/${rest}`);
    const headers = { ...req.headers, host: t.url.host };
    delete headers.cookie;
    delete headers['if-none-match'];
    if (t.token) headers.authorization = 'Bearer ' + t.token;
    const up = http.request({
      hostname: t.url.hostname,
      port: t.url.port || (t.url.protocol === 'https:' ? 443 : 80),
      path: fwd,
      method: req.method,
      headers,
    }, (incoming) => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) {
        res.status(502).type('html').send(
          '<!DOCTYPE html><meta charset="utf-8"><p>校邮看板暂时连不上宿舍小主机。确认 Tailscale 和 pcy-02 上的 hkmail-board / 驾驶舱在跑。</p>'
        );
      }
    });
    req.pipe(up);
  });
}
