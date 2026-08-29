import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export const UPLOAD_ROOT = path.join(os.homedir(), '.claude-cockpit', 'uploads');
const CURSOR_PROJECTS = path.join(os.homedir(), '.cursor', 'projects');
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_FILES = 8;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
};

function isImageName(name, mediaType) {
  if (typeof mediaType === 'string' && mediaType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(name || '');
}

function sanitizeName(name) {
  const base = path.basename(String(name || 'file'))
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return base || 'file';
}

function withExt(name, mediaType) {
  if (path.extname(name)) return name;
  return name + (EXT_BY_MIME[mediaType] || '');
}

function realOrNull(fp) {
  try { return fs.realpathSync(fp); } catch { return null; }
}

function underRoot(real, root) {
  const r = realOrNull(root);
  if (!real || !r) return false;
  return real === r || real.startsWith(r + path.sep);
}

/** Only Cockpit uploads and Cursor IDE assets — never arbitrary paths. */
export function isIndexedFilePath(fp) {
  if (!fp || typeof fp !== 'string' || fp.includes('\0')) return false;
  const real = realOrNull(fp);
  if (!real) return false;
  return underRoot(real, UPLOAD_ROOT) || underRoot(real, CURSOR_PROJECTS);
}

export function extractIndexedFiles(text) {
  const src = String(text || '');
  const images = [];
  const files = [];
  const take = (block, dest) => {
    if (!block) return;
    for (const m of block.matchAll(/^\s*\d+\.\s+(\S.+)$/gm)) dest.push(m[1].trim());
  };
  take(src.match(/<image_files>([\s\S]*?)<\/image_files>/)?.[1], images);
  take(src.match(/<files>([\s\S]*?)<\/files>/)?.[1], files);
  const cleaned = src
    .replace(/\[Image\]\s*/g, '')
    .replace(/<image_files>[\s\S]*?<\/image_files>\s*/g, '')
    .replace(/<files>[\s\S]*?<\/files>\s*/g, '')
    .replace(/^请查看附件。\s*/, '')
    .replace(/^（见附图）\s*/, '')
    .trim();
  return { cleaned, images, files };
}

function decodeData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data !== 'string' || !data) return null;
  try { return Buffer.from(data, 'base64'); } catch { return null; }
}

/**
 * Persist Cursor attachments to disk and return a prompt suffix the agent
 * can Read — same contract as Cursor IDE's <image_files> paste index.
 */
export function materializeCursorAttachments(attachments) {
  const list = (attachments || []).filter(a => a && a.data).slice(0, MAX_FILES);
  if (!list.length) return '';

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(UPLOAD_ROOT, day);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const images = [];
  const others = [];
  for (const a of list) {
    const buf = decodeData(a.data);
    if (!buf) continue;
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(`附件过大（>${MAX_FILE_BYTES / 1024 / 1024}MB）：${a.name || 'unnamed'}`);
    }
    const name = withExt(sanitizeName(a.name), a.mediaType);
    const dest = path.join(dir, crypto.randomBytes(4).toString('hex') + '-' + name);
    fs.writeFileSync(dest, buf, { mode: 0o600 });
    (isImageName(name, a.mediaType) ? images : others).push(dest);
  }
  if (!images.length && !others.length) return '';

  let out = '';
  if (images.length) {
    out += images.map(() => '[Image]').join('\n') + '\n';
    out += '<image_files>\nThe following images were provided by the user and saved to the workspace for future use:\n';
    images.forEach((fp, i) => { out += `${i + 1}. ${fp}\n`; });
    out += '\nThese images can be copied for use in other locations.\n</image_files>\n';
  }
  if (others.length) {
    out += '<files>\nThe following files were provided by the user and saved for future use:\n';
    others.forEach((fp, i) => { out += `${i + 1}. ${fp}\n`; });
    out += '\nRead these files from disk; they are not inlined in the prompt.\n</files>\n';
  }
  return out;
}
