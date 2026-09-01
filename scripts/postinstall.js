import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') process.exit(0);

const pre = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const plat of fs.readdirSync(pre)) {
    const helper = path.join(pre, plat, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch { /* optional */ }
