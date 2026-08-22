import fs from 'fs';
import path from 'path';
import os from 'os';

// Claude Code can be pointed at any Anthropic-compatible gateway via env vars,
// so "use another model" is really "swap ANTHROPIC_BASE_URL + token + model id".
const CFG_DIR = path.join(os.homedir(), '.claude-cockpit');
const FILE = path.join(CFG_DIR, 'providers.json');

const BUILTIN = [
  {
    id: 'mimo-ultraspeed',
    label: 'MiMo v2.5 Pro UltraSpeed',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    model: 'mimo-v2.5-pro-ultraspeed',
    keyRef: 'MIMO_API_KEY',
    // gateway hard-rejects bodies over 1MB; Claude Code resends the whole
    // conversation each turn, so long sessions blow past it (实测 1.3MB → 500)
    maxRequestBytes: 1048576,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek v4 Pro',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-pro',
    keyRef: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek v4 Flash',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-flash',
    keyRef: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'glm-5',
    label: 'GLM-5',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5',
    keyRef: 'ZHIPU_API_KEY',
  },
  {
    id: 'glm-5.3',
    label: 'GLM-5.3（需账号开通）',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3',
    keyRef: 'ZHIPU_API_KEY',
    // glm-5.3 强制思考：不带思考参数直接 400(1210)。MAX_THINKING_TOKENS 环境变量
    // 传不到请求里，实测唯一有效的是 --effort 旗标（错误随之变为账号权限 1220）
    effort: 'high',
  },
];

function readFileCfg() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

/**
 * providers.json holds the keys; it is created on first run from the builtins.
 * Fields added to BUILTIN later (e.g. maxRequestBytes) are merged into existing
 * files without touching what the user customised.
 */
export function listProviders({ withKeys = false } = {}) {
  const file = readFileCfg();
  let providers;
  if (!file) {
    providers = BUILTIN.map(p => ({ ...p, apiKey: '' }));
    writeProviders(providers);
  } else {
    providers = file.providers.map(p => {
      const b = BUILTIN.find(x => x.id === p.id);
      return b ? { ...b, ...p } : p;   // user's values win, builtin fills the gaps
    });
    // any builtin the file predates
    for (const b of BUILTIN) if (!providers.some(p => p.id === b.id)) providers.push({ ...b, apiKey: '' });
  }
  return providers.map(p => withKeys ? p : { ...p, apiKey: undefined, hasKey: !!p.apiKey });
}

export function writeProviders(providers) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ providers }, null, 2), { mode: 0o600 });
}

export function getProvider(id) {
  if (!id) return null;
  return listProviders({ withKeys: true }).find(p => p.id === id) || null;
}

/** Env overlay for spawning claude against a third-party gateway. */
export function providerEnv(id) {
  const p = getProvider(id);
  if (!p) return null;
  const key = p.apiKey || process.env[p.keyRef] || '';
  if (!key) return { error: `供应商 ${p.label} 缺少 API key（在 ~/.claude-cockpit/providers.json 里填 apiKey，或设环境变量 ${p.keyRef}）` };
  return {
    env: {
      ...(p.extraEnv || {}),
      ANTHROPIC_BASE_URL: p.baseUrl,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: '',          // must be empty or it wins over AUTH_TOKEN
      ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: p.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    model: p.model,
    effort: p.effort || null,
  };
}
