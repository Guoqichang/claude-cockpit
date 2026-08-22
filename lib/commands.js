import fs from 'fs';
import path from 'path';
import os from 'os';

function fmDesc(fp) {
  try {
    const head = fs.readFileSync(fp, 'utf8').slice(0, 4000);
    const m = head.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    return m ? m[1].slice(0, 120) : '';
  } catch { return ''; }
}

function scanCommands(dir, source, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      out.push({ name: e.name.replace(/\.md$/, ''), desc: fmDesc(path.join(dir, e.name)) || '自定义命令', source });
    }
  }
}

function scanSkills(dir, source, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    // no isDirectory() check: skill dirs may be symlinks (e.g. lark-cli installs)
    const sk = path.join(dir, e.name, 'SKILL.md');
    if (fs.existsSync(sk)) out.push({ name: e.name, desc: fmDesc(sk) || 'skill', source });
  }
}

// Built-ins that make sense in headless -p mode (interactive-only ones excluded)
const BUILTINS = [
  { name: 'goal', desc: '目标模式：设定完成条件，自动多轮推进直到达成（/goal clear 取消）', source: '内置' },
  { name: 'compact', desc: '压缩当前会话上下文', source: '内置' },
  { name: 'init', desc: '为项目生成 CLAUDE.md', source: '内置' },
  { name: 'review', desc: '审查 GitHub PR', source: '内置' },
];

export function listCommands(cwd) {
  const out = [];
  const home = os.homedir();
  if (cwd && !cwd.includes('..') && fs.existsSync(cwd)) {
    scanCommands(path.join(cwd, '.claude', 'commands'), '项目命令', out);
    scanSkills(path.join(cwd, '.claude', 'skills'), '项目skill', out);
  }
  scanCommands(path.join(home, '.claude', 'commands'), '命令', out);
  scanSkills(path.join(home, '.claude', 'skills'), 'skill', out);
  out.push(...BUILTINS);
  const seen = new Set();
  return out.filter(c => !seen.has(c.name) && seen.add(c.name));
}
