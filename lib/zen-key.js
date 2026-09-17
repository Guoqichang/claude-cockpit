import fs from 'fs';
import path from 'path';
import os from 'os';

const AUTH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

/** OpenCode Zen key: env first, then `opencode auth login` 写下的 auth.json. */
export function opencodeZenKey() {
  const env = String(process.env.OPENCODE_API_KEY || '').trim();
  if (env) return env;
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
    const k = auth?.opencode?.key || auth?.opencode?.apiKey || auth?.opencode?.token;
    return String(k || '').trim();
  } catch {
    return '';
  }
}
