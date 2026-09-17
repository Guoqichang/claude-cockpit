/**
 * 驾驶舱 → Fun-ASR 口播代理。
 * 浏览器只连本机 cockpit /ws/asr, 再转到试听台 /ws/dictate。
 * 听课页的 /ws/record 不走这里, 避免占课堂 recorder。
 */
import WebSocket from 'ws';

const MAX_PENDING = 48; // ~12s of 0.256s frames before upstream is up

export function dictateWsUrl(httpUrl) {
  const u = new URL(String(httpUrl || 'http://127.0.0.1:8780'));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws/dictate';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function proxyDictate(client, httpUrl) {
  const upstream = new WebSocket(dictateWsUrl(httpUrl), { maxPayload: 16 * 1024 * 1024 });
  let pending = [];
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    pending = null;
    try { if (client.readyState === 1) client.close(); } catch { /* ignore */ }
    try {
      if (upstream.readyState === 0 || upstream.readyState === 1) upstream.close();
    } catch { /* ignore */ }
  };

  const fail = (msg) => {
    try {
      if (client.readyState === 1) client.send(JSON.stringify({ t: 'err', msg }));
    } catch { /* ignore */ }
    closeBoth();
  };

  upstream.on('open', () => {
    if (!pending) return;
    for (const [data, binary] of pending) {
      try { upstream.send(data, { binary }); } catch { /* ignore */ }
    }
    pending = [];
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === 1) client.send(data, { binary: !!isBinary });
  });
  upstream.on('close', closeBoth);
  upstream.on('error', () => fail('试听台没开或已断开'));

  client.on('message', (data, isBinary) => {
    const binary = !!isBinary;
    if (upstream.readyState === 1) {
      try { upstream.send(data, { binary }); } catch { /* ignore */ }
      return;
    }
    if (!pending) return;
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push([data, binary]);
  });
  client.on('close', closeBoth);
  client.on('error', closeBoth);
  return closeBoth;
}
