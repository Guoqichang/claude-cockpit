import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// The tunnel-facing listener requires this token; the localhost listener does not.
// (Reverse-SSH traffic arrives as 127.0.0.1, so "trust localhost" cannot be the rule.)
const CFG_DIR = path.join(os.homedir(), '.claude-cockpit');
const AUTH_FILE = path.join(CFG_DIR, 'auth.json');
const COOKIE = 'cockpit_token';
const MAX_FAILS = 10;
const WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

let cache = null;
const fails = new Map(); // key -> {count, first, until}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (cache.token) return cache;
  } catch { /* first run */ }
  cache = { token: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now() };
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  return cache;
}

export function getToken() { return load().token; }

export function rotateToken() {
  cache = { token: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now() };
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  return cache.token;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Behind Caddy every request looks local, so rate-limit on the forwarded client ip
export function clientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket?.remoteAddress || 'unknown';
}

export function isLocked(key) {
  const f = fails.get(key);
  return !!(f?.until && Date.now() < f.until);
}

export function noteFailure(key) {
  const now = Date.now();
  const f = fails.get(key) || { count: 0, first: now, until: 0 };
  if (now - f.first > WINDOW_MS) { f.count = 0; f.first = now; }
  f.count++;
  if (f.count >= MAX_FAILS) { f.until = now + LOCKOUT_MS; f.count = 0; f.first = now; }
  fails.set(key, f);
  return f;
}

export function noteSuccess(key) { fails.delete(key); }

// Accepts token via cookie, Authorization: Bearer, or ?t= (used by the QR link)
export function extractToken(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = url?.searchParams?.get('t');
  if (q) return q;
  return parseCookies(req.headers.cookie)[COOKIE] || '';
}

export function checkToken(req, url) {
  const t = extractToken(req, url);
  return !!t && timingSafeEqual(t, getToken());
}

export const COOKIE_NAME = COOKIE;
