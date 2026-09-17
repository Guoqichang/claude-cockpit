import fs from 'fs';
import path from 'path';
import os from 'os';
import { IS_WIN, resolveBin } from './proc.js';
import { opencodeZenKey } from './zen-key.js';

const CFG = path.join(os.homedir(), '.claude-cockpit', 'config.json');
const CHATGPT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { return {}; }
}

export function codexHome() {
  return process.env.CODEX_HOME
    || readCfg().codex?.home
    || path.join(os.homedir(), '.codex');
}

export function codexBin() {
  const fromCfg = readCfg().codex?.bin;
  if (fromCfg && fs.existsSync(fromCfg)) return fromCfg;
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const names = IS_WIN ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  const found = resolveBin(names, [
    path.dirname(CHATGPT_CODEX),
    path.join(os.homedir(), '.local', 'bin'),
  ]);
  if (found) return found;
  if (!IS_WIN && fs.existsSync(CHATGPT_CODEX)) return CHATGPT_CODEX;
  return names[0];
}

export function codexBinOk() {
  const bin = codexBin();
  return !!(bin && fs.existsSync(bin));
}

export function hasLocalCodex() {
  try { return fs.existsSync(path.join(codexHome(), 'sessions')); }
  catch { return false; }
}

export function cockpitZenBase(req) {
  const fromCfg = readCfg().codex?.zenBase;
  if (fromCfg) return String(fromCfg).replace(/\/+$/, '');
  const port = Number(process.env.PORT || 7799);
  return `http://127.0.0.1:${port}/zen-openai/v1`;
}

export function unionAlphaModel(raw) {
  const s = String(raw || '').trim();
  if (!s || s === 'union-alpha' || s === 'opencode/union-alpha' || s.endsWith('/union-alpha')) {
    return 'union-alpha';
  }
  return s.replace(/^opencode\//, '');
}

export function codexSpawnEnv() {
  const key = opencodeZenKey();
  return {
    ...process.env,
    OPENCODE_API_KEY: key || process.env.OPENCODE_API_KEY || 'opencode-zen',
  };
}

export function codexProviderFlags(baseUrl, model) {
  const mid = unionAlphaModel(model);
  const url = String(baseUrl || '').replace(/\/+$/, '');
  const table = `{name="OpenCode Zen", base_url="${url}", env_key="OPENCODE_API_KEY", wire_api="responses"}`;
  return [
    '-c', 'model_provider="opencodezen"',
    '-c', `model="${mid}"`,
    '-c', `model_providers.opencodezen=${table}`,
  ];
}

export function codexStatus() {
  return {
    local: hasLocalCodex(),
    bin: codexBin(),
    binOk: codexBinOk(),
    home: codexHome(),
    zenKey: !!opencodeZenKey(),
  };
}
