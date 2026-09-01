import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { IS_WIN, pythonArgv, resolveBin, spawnCommon } from './proc.js';
import {
  ocBin, ocBinOk, ocConfigPath,
  ensureServe, ocStatus,
} from './opencode.js';
import { hasLocalHermes, hermesBin } from './hermes.js';

const PRESETS = {
  deepseek: {
    id: 'deepseek',
    npm: '@ai-sdk/openai-compatible',
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    models: {
      'deepseek-v4-pro': {
        name: 'DeepSeek V4 Pro',
        tools: true,
        limit: { context: 131072, output: 8192 },
      },
      'deepseek-v4-flash': {
        name: 'DeepSeek V4 Flash',
        tools: true,
        limit: { context: 131072, output: 8192 },
      },
    },
    model: 'deepseek/deepseek-v4-pro',
    keyHint: 'https://platform.deepseek.com/api_keys',
  },
  openai: {
    id: 'openai',
    npm: '@ai-sdk/openai-compatible',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: {
      'gpt-4.1': { name: 'GPT-4.1', tools: true },
      'gpt-4o': { name: 'GPT-4o', tools: true },
    },
    model: 'openai/gpt-4.1',
    keyHint: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    id: 'anthropic',
    npm: '@ai-sdk/anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com',
    models: {
      'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5', tools: true },
    },
    model: 'anthropic/claude-sonnet-4-5',
    keyHint: 'https://console.anthropic.com/settings/keys',
  },
};

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(p, body, { encoding: 'utf8', mode: 0o600 });
}

function keyish(v) {
  return typeof v === 'string' && v.trim().length >= 8;
}

function providersFromConfig(cfg) {
  const out = [];
  const p = cfg?.provider || {};
  for (const [id, block] of Object.entries(p)) {
    const key = block?.options?.apiKey || block?.apiKey || '';
    if (keyish(key)) out.push(id);
  }
  return out;
}

function providersFromAuth() {
  const home = os.homedir();
  const cands = [
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'),
  ].filter(Boolean);
  const found = [];
  for (const p of cands) {
    const auth = readJson(p);
    if (!auth || typeof auth !== 'object') continue;
    for (const [id, block] of Object.entries(auth)) {
      if (keyish(block?.key) || keyish(block?.apiKey) || keyish(block?.token)) found.push(id);
    }
  }
  return found;
}

function hasClaude() {
  if (resolveBin(IS_WIN ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'])) return true;
  try { return fs.readdirSync(path.join(os.homedir(), '.claude', 'projects')).length > 0; }
  catch { return false; }
}

function hasCursor() {
  if (resolveBin(IS_WIN ? ['agent.exe', 'agent.cmd', 'agent'] : ['agent'])) return true;
  try { return fs.existsSync(path.join(os.homedir(), '.cursor', 'chats')); }
  catch { return false; }
}

function hasHermesEngine() {
  if (hasLocalHermes()) return true;
  const bin = hermesBin();
  return !!(bin && fs.existsSync(bin));
}

export function setupPresets() {
  return Object.values(PRESETS).map((p) => ({
    id: p.id, name: p.name, model: p.model, keyHint: p.keyHint, baseURL: p.baseURL,
  }));
}

export function setupStatus() {
  const cfgPath = ocConfigPath();
  const cfg = readJson(cfgPath) || {};
  const fromCfg = providersFromConfig(cfg);
  const fromAuth = providersFromAuth();
  const providers = [...new Set([...fromCfg, ...fromAuth])];
  const binOk = ocBinOk();
  const hasKey = providers.length > 0;
  const py = pythonArgv();
  return {
    platform: process.platform,
    node: process.version,
    python: !!py,
    pythonBin: py ? py.join(' ') : null,
    opencode: {
      ...ocStatus(),
      binOk,
      config: cfgPath,
      hasKey,
      providers,
      installCmd: IS_WIN
        ? 'irm https://opencode.ai/install | iex'
        : 'curl -fsSL https://opencode.ai/install | bash',
    },
    engines: {
      claude: hasClaude(),
      cursor: hasCursor(),
      hermes: hasHermesEngine(),
      opencode: binOk,
    },
    ready: binOk && hasKey,
  };
}

export function saveOpencodeKey({ provider = 'deepseek', apiKey, baseURL, model, name } = {}) {
  const key = String(apiKey || '').trim();
  if (key.length < 8) throw new Error('API Key 太短，请从控制台复制完整的一把');
  if (/\s/.test(key)) throw new Error('API Key 里不该有空格，请重新复制');

  const preset = PRESETS[provider] || null;
  const id = (preset?.id || String(provider || 'custom').replace(/[^\w.-]/g, '') || 'custom').slice(0, 40);
  const cfgPath = ocConfigPath();
  const cfg = readJson(cfgPath) || { $schema: 'https://opencode.ai/config.json' };
  if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
  if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};

  const block = cfg.provider[id] && typeof cfg.provider[id] === 'object' ? { ...cfg.provider[id] } : {};
  block.npm = block.npm || preset?.npm || '@ai-sdk/openai-compatible';
  block.name = name || block.name || preset?.name || id;
  block.options = { ...(block.options || {}) };
  block.options.apiKey = key;
  const url = String(baseURL || block.options.baseURL || preset?.baseURL || '').trim();
  if (url) block.options.baseURL = url.replace(/\/+$/, '');
  if (preset?.models && !block.models) block.models = preset.models;
  cfg.provider[id] = block;

  const nextModel = String(model || cfg.model || preset?.model || '').trim();
  if (nextModel) cfg.model = nextModel.includes('/') ? nextModel : `${id}/${nextModel}`;

  writeJson(cfgPath, cfg);
  return { ok: true, provider: id, model: cfg.model, config: cfgPath };
}

let installing = null;

export function installOpencode() {
  if (ocBinOk()) return Promise.resolve({ ok: true, bin: ocBin(), skipped: true });
  if (installing) return installing;
  installing = new Promise((resolve, reject) => {
    const child = IS_WIN
      ? spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-Command', 'irm https://opencode.ai/install | iex',
      ], spawnCommon({ stdio: ['ignore', 'pipe', 'pipe'] }))
      : spawn('bash', ['-lc', 'curl -fsSL https://opencode.ai/install | bash'], spawnCommon({
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

    let out = '';
    const take = (buf) => {
      out += buf.toString('utf8');
      if (out.length > 80_000) out = out.slice(-40_000);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    const t = setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      reject(new Error('安装 OpenCode 超时（8 分钟）。可在终端自己跑官方安装命令。'));
    }, 8 * 60 * 1000);

    child.on('error', (err) => {
      clearTimeout(t);
      reject(new Error('拉起安装失败：' + (err.message || err)));
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (ocBinOk()) { resolve({ ok: true, bin: ocBin(), code }); return; }
      reject(new Error(
        `官方安装脚本退出码 ${code}，本机仍找不到 opencode。\n` +
        (out.trim().slice(-1200) || '没有输出'),
      ));
    });
  }).finally(() => { installing = null; });
  return installing;
}

export async function pingServe() {
  return ensureServe();
}
