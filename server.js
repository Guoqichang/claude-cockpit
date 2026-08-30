import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { listProjects, readSession, findSessionMeta } from './lib/session-router.js';
import { allNames, setName } from './lib/names.js';
import { buildGraph } from './lib/graph.js';
import { startChat, subscribe, stopChat, hasChat, listChats, restoreChats, onChatDone } from './lib/chat.js';
import { listCommands } from './lib/commands.js';
import { getActive } from './lib/active.js';
import { openLocalTerm, openSshTerm } from './lib/term.js';
import { getToken, rotateToken, checkToken, clientKey, isLocked, noteFailure, noteSuccess, COOKIE_NAME } from './lib/auth.js';
import QRCode from 'qrcode';
import { getKeys, addSub, removeSub, subCount, notify } from './lib/push.js';
import { listProviders } from './lib/providers.js';
import { holdAwake, releaseAwake, status as awakeStatus } from './lib/awake.js';
import { isServableMediaPath } from './lib/cursor-uploads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7799);
const AUTH_PORT = Number(process.env.AUTH_PORT || 7788);
const BIND = process.env.COCKPIT_BIND || '127.0.0.1';
const AUTH_ONLY = process.env.COCKPIT_AUTH_ONLY === '1';
const HOSTS_FILE = path.join(os.homedir(), '.claude-cockpit', 'hosts.json');
const CONFIG_FILE = path.join(os.homedir(), '.claude-cockpit', 'config.json');

const readConfig = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
};
const writeConfig = (cfg) => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
};

const app = express();
app.use(express.json({ limit: '60mb' }));   // images ride in chat.start payloads

// Requests arriving on AUTH_PORT come from the public tunnel and must carry the
// token; PORT is the local-desktop listener and stays frictionless.
const needsAuth = (req) => AUTH_ONLY || req.socket.localPort === AUTH_PORT;

app.use((req, res, next) => {
  if (!needsAuth(req)) return next();
  const url = new URL(req.originalUrl || req.url, 'http://x');
  const key = clientKey(req);
  if (isLocked(key)) { res.status(429).send('尝试过多，请稍后再试'); return; }

  if (checkToken(req, url)) {
    noteSuccess(key);
    // a ?t= link (the QR) upgrades to a cookie so later requests are clean
    if (url.searchParams.get('t')) {
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(getToken())}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
      if (req.method === 'GET' && !req.path.startsWith('/api/')) { res.redirect(req.path); return; }
    }
    return next();
  }
  noteFailure(key);
  if (req.path.startsWith('/api/') || req.path === '/ws') { res.status(401).json({ error: 'unauthorized' }); return; }
  res.status(401).sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// vendor assets served straight from node_modules (no bundler)
const nm = (p) => path.join(__dirname, 'node_modules', p);
app.use('/vendor/xterm', express.static(nm('@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(nm('@xterm/addon-fit')));
app.use('/vendor/marked', express.static(nm('marked')));
app.use('/vendor/dompurify', express.static(nm('dompurify')));
app.use('/vendor/katex', express.static(nm('katex/dist')));
app.use('/vendor/mermaid', express.static(nm('mermaid/dist')));

app.get('/api/peers', (req, res) => {
  const peers = readConfig().peers || [];
  res.json(peers.map((p) => ({
    id: p.id, label: p.label || p.id, url: p.url || '',
    token: needsAuth(req) ? undefined : p.token,
  })));
});

app.get('/api/projects', (req, res) => {
  try { res.json(listProjects()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/session/:slug/:id', (req, res) => {
  try {
    const end = req.query.end !== undefined ? parseInt(req.query.end, 10) : undefined;
    const limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : undefined;
    res.json(readSession(req.params.slug, req.params.id, { end, limit: limit || 200 }));
  }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Cursor index-mode files: only paths under cockpit uploads or Cursor project assets
app.get('/api/local-file', (req, res) => {
  const raw = req.query.path;
  const fp = Array.isArray(raw) ? raw[0] : raw;
  if (!isServableMediaPath(fp)) { res.status(403).json({ error: 'forbidden' }); return; }
  const real = fs.realpathSync(fp);
  res.sendFile(real, { headers: { 'Cache-Control': 'private, max-age=86400' } }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// the APK embeds the access token, so it is only downloadable through the
// authenticated listener — never put this build on an anonymous file server
app.get('/cockpit.apk', (req, res) => {
  const apk = path.join(__dirname, 'android', 'build', 'cockpit.apk');
  if (!fs.existsSync(apk)) { res.status(404).send('APK 尚未构建：bash android/build.sh'); return; }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="cockpit.apk"');
  res.sendFile(apk);
});

// pairing: QR + URL for the phone. Only served on the local listener.
app.get('/api/pair', async (req, res) => {
  if (needsAuth(req)) { res.status(403).json({ error: '仅本机可查看配对信息' }); return; }
  try {
    const cfg = readConfig();
    const base = (req.query.base || cfg.publicUrl || '').trim().replace(/\/+$/, '');
    if (req.query.base) writeConfig({ ...cfg, publicUrl: base });
    const url = base ? `${base}/?t=${encodeURIComponent(getToken())}` : '';
    const apkUrl = base ? `${base}/cockpit.apk?t=${encodeURIComponent(getToken())}` : '';
    const apkExists = fs.existsSync(path.join(__dirname, 'android', 'build', 'cockpit.apk'));
    const qrOpts = { margin: 1, width: 240, color: { dark: '#e8e2d6', light: '#1f1c18' } };
    res.json({
      publicUrl: base, url, token: getToken(),
      qr: url ? await QRCode.toDataURL(url, qrOpts) : '',
      apkUrl: apkExists ? apkUrl : '',
      apkQr: apkExists && apkUrl ? await QRCode.toDataURL(apkUrl, qrOpts) : '',
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/pair/rotate', (req, res) => {
  if (needsAuth(req)) { res.status(403).json({ error: '仅本机可轮换令牌' }); return; }
  rotateToken();
  res.json({ ok: true });
});

// web push
app.get('/api/push/key', (req, res) => res.json({ key: getKeys().publicKey, subs: subCount() }));
app.post('/api/push/subscribe', (req, res) => {
  res.json({ ok: addSub(req.body) });
});
app.post('/api/push/unsubscribe', (req, res) => {
  removeSub(req.body?.endpoint || '');
  res.json({ ok: true });
});
app.post('/api/push/test', async (req, res) => {
  const sent = await notify({ title: 'Claude Cockpit', body: '推送通道正常', tag: 'test' });
  res.json({ sent });
});

app.get('/api/awake', (req, res) => res.json(awakeStatus()));
app.post('/api/awake', (req, res) => {
  const h = Number(req.body?.hours);
  res.json(h > 0 ? holdAwake(h) : releaseAwake());
});

app.get('/api/providers', (req, res) => {
  try { res.json(listProviders()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/chats', (req, res) => {
  try { res.json(listChats()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/active', async (req, res) => {
  try { res.json(await getActive()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/commands', (req, res) => {
  try { res.json(listCommands(req.query.cwd || '')); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/graph', async (req, res) => {
  try { res.json(await buildGraph()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// custom session titles (empty name = revert to the auto title)
app.get('/api/names', (req, res) => {
  try { res.json(allNames()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/names/:id', (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[\w.-]{1,128}$/.test(id)) throw new Error('bad session id');
    const name = setName(id, req.body?.name);
    res.json({ ok: true, id, name });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// pinned session ids, order = display order
const PINS_FILE = path.join(os.homedir(), '.claude-cockpit', 'pins.json');

app.get('/api/pins', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'))); }
  catch { res.json([]); }
});
app.post('/api/pins', (req, res) => {
  try {
    if (!Array.isArray(req.body)) throw new Error('expected an array of session ids');
    fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true });
    fs.writeFileSync(PINS_FILE, JSON.stringify(req.body.slice(0, 200)));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

// saved SSH hosts (password saved only if user opts in; plaintext, chmod 600)
app.get('/api/hosts', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'))); }
  catch { res.json([]); }
});
app.post('/api/hosts', (req, res) => {
  try {
    fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(req.body, null, 2), { mode: 0o600 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const server = http.createServer(app);       // local desktop listener
const authServer = http.createServer(app);   // tunnel-facing listener (token required)
const wss = new WebSocketServer({ noServer: true, maxPayload: 120 * 1024 * 1024 });

const log = (...a) => console.log(new Date().toISOString(), ...a);

function headerOrigin(req) {
  const raw = req.headers.origin;
  if (!raw || raw === 'null') return '';
  try { return new URL(raw).origin; } catch { return ''; }
}

function localWsOrigins() {
  return new Set([
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
  ]);
}

function publicWsOrigins() {
  const base = (readConfig().publicUrl || '').trim();
  if (!base) return new Set();
  try { return new Set([new URL(base).origin]); } catch { return new Set(); }
}

function originAllowed(req, mode) {
  const origin = headerOrigin(req);
  if (!origin) return true;
  if (mode === 'local') return localWsOrigins().has(origin);
  try {
    const u = new URL(origin);
    const host = String(req.headers.host || '').split(':')[0];
    if (u.hostname === host) return true;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    if (/^100\.\d+\.\d+\.\d+$/.test(u.hostname)) return true;
  } catch { /* ignore */ }
  return publicWsOrigins().has(origin);
}

function wireUpgrade(srv, { requireAuth, originMode }) {
  srv.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    if (!originAllowed(req, originMode)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log('ws rejected (origin)', req.headers.origin || '(none)');
      return;
    }
    if (requireAuth) {
      const key = clientKey(req);
      if (isLocked(key) || !checkToken(req, url)) {
        noteFailure(key);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        log('ws rejected (auth)', key);
        return;
      }
      noteSuccess(key);
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}
if (!AUTH_ONLY) wireUpgrade(server, { requireAuth: false, originMode: 'local' });
wireUpgrade(authServer, { requireAuth: true, originMode: 'public' });

wss.on('connection', (ws, req) => {
  log('ws connect', req.socket.remoteAddress);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const terms = new Map();  // ch -> {write,resize,close}
  const unsubs = new Map(); // ch -> unsubscribe fn

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  // Chat turns live in lib/chat.js as detached processes; this only streams them.
  function bind(ch, from) {
    unsubs.get(ch)?.();
    const un = subscribe(ch, from, (msg) => {
      if (msg.kind === 'event') send({ op: 'chat.event', ch, event: msg.event });
      else if (msg.kind === 'error') send({ op: 'chat.error', ch, error: msg.error });
      else if (msg.kind === 'retry') send({ op: 'chat.retry', ch, attempt: msg.attempt, max: msg.max, waitMs: msg.waitMs });
      else if (msg.kind === 'retried') send({ op: 'chat.retried', ch, next: msg.ch, attempt: msg.attempt });
      else if (msg.kind === 'done') send({ op: 'chat.done', ch, code: msg.code, stderr: msg.stderr });
    });
    if (un) unsubs.set(ch, un);
    return !!un;
  }

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    const ch = m.ch;

    if (m.op === 'chat.start') {
      if (hasChat(ch)) { bind(ch, 0); return; }
      try {
        startChat(ch, { cwd: m.cwd, resume: m.resume, permissionMode: m.permissionMode, prompt: m.prompt,
                        model: m.model, attachments: m.attachments, provider: m.provider, engine: m.engine });
      } catch (e) {
        send({ op: 'chat.error', ch, error: String(e.message || e) });
        send({ op: 'chat.done', ch, code: -1, stderr: '' });
        return;
      }
      bind(ch, 0);
      log('chat start', ch, m.provider ? `provider=${m.provider}` : (m.model || '(default model)'));

    } else if (m.op === 'chat.attach') {
      // fresh page: history already came from the session file, so stream only what's next
      const from = m.fresh ? 'future' : Math.max(0, m.from || 0);
      if (!bind(ch, from)) { send({ op: 'chat.gone', ch }); return; }
      log('chat attach', ch, 'from', from);

    } else if (m.op === 'chat.stop') {
      if (!stopChat(ch)) send({ op: 'chat.done', ch, code: -1, stderr: '' });

    } else if (m.op === 'term.open') {
      const cbs = {
        onData: (data) => send({ op: 'term.data', ch, data }),
        onExit: (code) => { terms.delete(ch); send({ op: 'term.exit', ch, code }); },
        onError: (error) => send({ op: 'term.error', ch, error }),
      };
      const t = m.kind === 'ssh'
        ? openSshTerm({ cols: m.cols, rows: m.rows, ssh: m.ssh, cmd: m.cmd }, cbs)
        : openLocalTerm({ cols: m.cols, rows: m.rows, cwd: m.cwd, cmd: m.cmd }, cbs);
      if (t) terms.set(ch, t);

    } else if (m.op === 'term.input') {
      terms.get(ch)?.write(m.data);

    } else if (m.op === 'term.resize') {
      terms.get(ch)?.resize(m.cols, m.rows);

    } else if (m.op === 'term.close') {
      terms.get(ch)?.close();
      terms.delete(ch);
    }
  });

  ws.on('close', (code) => {
    log('ws close', code);
    // unsubscribe only — the chat processes keep running detached
    for (const un of unsubs.values()) un();
    unsubs.clear();
    for (const t of terms.values()) t.close();
    terms.clear();
  });
});

// protocol-level heartbeat: keeps idle connections alive through
// browser/proxy idle timeouts, and reaps truly dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

// finished turn → phone notification
onChatDone(async ({ sessionId, code, result, startedAt, cwd }) => {
  try {
    const meta = sessionId ? findSessionMeta(sessionId) : null;
    const title = meta?.title || '新会话';
    const secs = Math.max(0, Math.round((Date.now() - (startedAt || Date.now())) / 1000));
    const dur = secs < 60 ? `${secs}秒` : `${Math.floor(secs / 60)}分${String(secs % 60).padStart(2, '0')}秒`;
    const failed = code !== 0 || result?.isError;
    const cost = result?.cost != null ? ` · $${result.cost.toFixed(3)}` : '';
    const body = failed
      ? `未正常结束（退出码 ${code}）· ${dur}`
      : `完成 · ${dur}${cost}${result?.text ? '\n' + result.text.slice(0, 80) : ''}`;
    const url = meta ? `/?session=${encodeURIComponent(meta.slug)}/${encodeURIComponent(sessionId)}` : '/';
    const sent = await notify({ title, body, url, tag: sessionId || 'cockpit', error: failed });
    if (sent) log('push sent', sent, title);
  } catch (e) { log('push failed', String(e)); }
});

// SIGHUP (terminal closed) must not take the service down with it
process.on('SIGHUP', () => log('SIGHUP ignored — service stays up'));

// Local desktop: 127.0.0.1:PORT, no token. Tailscale/tunnel: AUTH_PORT (or
// AUTH_ONLY on PORT) always demands the token.
if (!AUTH_ONLY) {
  server.listen(PORT, '127.0.0.1', () => {
    const n = restoreChats();
    console.log(`claude-cockpit: http://127.0.0.1:${PORT}${n ? ` (恢复 ${n} 个运行中的轮次)` : ''}`);
  });
  authServer.listen(AUTH_PORT, '127.0.0.1', () => {
    getToken();
    console.log(`claude-cockpit auth listener: 127.0.0.1:${AUTH_PORT} (需要令牌)`);
  });
} else {
  authServer.listen(PORT, BIND, () => {
    getToken();
    const n = restoreChats();
    console.log(`claude-cockpit: ${BIND}:${PORT} (AUTH_ONLY${n ? `, 恢复 ${n} 个运行中的轮次` : ''})`);
  });
}
