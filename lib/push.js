import fs from 'fs';
import path from 'path';
import os from 'os';
import webpush from 'web-push';

// Self-hosted Web Push (VAPID). No third-party service: the browser's own push
// endpoint is the only external hop, and payloads are encrypted to the device.
const CFG_DIR = path.join(os.homedir(), '.claude-cockpit');
const KEYS_FILE = path.join(CFG_DIR, 'vapid.json');
const SUBS_FILE = path.join(CFG_DIR, 'push-subs.json');

let keys = null;

export function getKeys() {
  if (keys) return keys;
  try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); }
  catch {
    keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }
  webpush.setVapidDetails('mailto:cockpit@localhost', keys.publicKey, keys.privateKey);
  return keys;
}

function readSubs() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch { return []; }
}
function writeSubs(subs) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), { mode: 0o600 });
}

export function addSub(sub) {
  if (!sub?.endpoint) return false;
  const subs = readSubs().filter(s => s.endpoint !== sub.endpoint);
  subs.push(sub);
  writeSubs(subs.slice(-10));
  return true;
}

export function removeSub(endpoint) {
  writeSubs(readSubs().filter(s => s.endpoint !== endpoint));
}

export function subCount() { return readSubs().length; }

export async function notify({ title, body, url, tag, error }) {
  const subs = readSubs();
  if (!subs.length) return 0;
  getKeys();
  const payload = JSON.stringify({ title, body, url: url || '/', tag, error: !!error });
  let sent = 0;
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, payload); sent++; }
    catch (e) {
      // 404/410 mean the subscription is dead — drop it
      if (e.statusCode === 404 || e.statusCode === 410) removeSub(sub.endpoint);
    }
  }
  return sent;
}
