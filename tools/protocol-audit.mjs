#!/usr/bin/env node
/* 协议漂移审计器
 *
 * 今天修的一串 bug 全是同一个句式：「上游有数据，适配器没取对」——
 * tool_call 没接、connection/retry 没接、st.output 读错成 metadata.output、
 * 历史假设已落盘。共同点是：等用户撞上了才发现。
 *
 * 这个工具把因果倒过来：扫所有引擎落盘的原始事件流，把出现过的字段路径
 * 减去源码里用到的，剩下的就是「上游给了但我们没用」的候选缺口。
 *
 *   node tools/protocol-audit.mjs            # 全部引擎
 *   node tools/protocol-audit.mjs opencode   # 只看一个
 *   node tools/protocol-audit.mjs --all      # 连已覆盖的字段一起列
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const CHAT_DIR = path.join(os.homedir(), '.claude-cockpit/chats');
const SRC_FILES = [
  'public/app.js', 'public/graph.js',
  'lib/chat.js', 'lib/opencode.js', 'lib/opencode-sessions.js',
  'lib/cursor-sessions.js', 'lib/sessions.js', 'lib/hermes-sessions.js',
];
const MAX_DEPTH = 6;
const SAMPLE_LEN = 60;

/* 三个引擎都可能以 system 事件开头，只看第一条会全判成 claude。
   改成扫全文件按特征事件打分，取票数最高的。 */
const MARKERS = {
  opencode: (t) => String(t).startsWith('oc.'),
  cursor: (t) => ['tool_call', 'thinking', 'connection', 'retry', 'interaction_query'].includes(t),
  claude: (t) => ['stream_event', 'result'].includes(t),
};
function sniffEngine(evs) {
  const score = { opencode: 0, cursor: 0, claude: 0 };
  for (const ev of evs) {
    const t = ev?.type;
    for (const [eng, hit] of Object.entries(MARKERS)) if (hit(t)) score[eng]++;
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

/* 把嵌套对象摊平成路径。数组统一折成 []，避免下标把路径炸开。 */
function walk(obj, prefix, out, depth) {
  if (depth > MAX_DEPTH || obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (const v of obj.slice(0, 8)) walk(v, prefix + '[]', out, depth + 1);
    return;
  }
  if (typeof obj !== 'object') {
    const rec = out.get(prefix);
    if (rec) {
      rec.n++;
      if (rec.sample === undefined) rec.sample = obj;
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? prefix + '.' + k : k;
    if (!out.has(p)) out.set(p, { n: 0, sample: undefined, leaf: k });
    out.get(p).n++;
    if (v !== null && typeof v === 'object') walk(v, p, out, depth + 1);
    else if (out.get(p).sample === undefined) out.get(p).sample = v;
  }
}

/* 348 行未覆盖字段没人看得下去。按「漏了会怎样」分三级：
   失败/截断/中断这类状态信号漏了最要命 —— 今天修的 bug 全是这一类；
   带内容的次之（漏了就是界面上少东西）；剩下的 id、时间戳、内部解析状态大多无所谓。 */
const SIGNAL = /(err|fail|truncat|interrupt|abort|cancel|timeout|retry|warn|deny|denied|reject|skip|partial|missing|exceed|limit|stale|invalid|status|reason)/i;
const CONTENT = /(text|output|content|message|image|url|preview|attach|mime|summary|title|todo|diff|patch|snippet|result|display)/i;
const NOISE = /(^|\.)(id|ids|uuid|.*Id|.*ID|.*Ms|.*_ms|.*AtMs|timestamp.*|request_id|.*_call_id)$/;

function rankOf(pathStr, leaf, sample) {
  if (NOISE.test(pathStr)) return 2;
  if (SIGNAL.test(leaf)) return 0;
  if (CONTENT.test(leaf)) return 1;
  return 2;
}
const RANK_LABEL = [
  '\u001b[31m● 状态信号\u001b[0m  漏了就是"出事了但界面不说"',
  '\u001b[33m● 内容字段\u001b[0m  漏了就是界面上少东西',
  '\u001b[90m○ 大概率噪音\u001b[0m  id / 时间戳 / 内部状态',
];

function loadSource() {
  let src = '';
  for (const f of SRC_FILES) {
    try { src += '\n' + fs.readFileSync(path.join(process.cwd(), f), 'utf8'); }
    catch { /* 文件可能不存在 */ }
  }
  return src;
}

/* 保守判定：只要叶子名在源码里以属性访问或字符串出现过，就算「用了」。
   宁可漏报也不误报 —— 这个工具的价值在于「列出来的都值得看」。 */
function makeCoverageTest(src) {
  const cache = new Map();
  return (leaf) => {
    if (cache.has(leaf)) return cache.get(leaf);
    const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(\\.${esc}\\b)|(['"\`]${esc}['"\`])|(\\b${esc}\\s*:)|(\\{[^}]*\\b${esc}\\b[^}]*\\}\\s*=)`);
    const hit = re.test(src);
    cache.set(leaf, hit);
    return hit;
  };
}

function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const only = args.find(a => !a.startsWith('--'));

  let files;
  try { files = fs.readdirSync(CHAT_DIR).filter(f => f.endsWith('.out')); }
  catch { console.error('找不到 ' + CHAT_DIR); process.exit(1); }

  const byEngine = new Map();   // engine -> { paths:Map, files:Set, events:number }
  let scanned = 0, badLines = 0;

  for (const f of files) {
    const fp = path.join(CHAT_DIR, f);
    let txt;
    try { txt = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    if (!txt.trim()) continue;
    const evs = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { badLines++; continue; }
      evs.push(ev);
    }
    const engine = sniffEngine(evs);
    if (!engine) continue;
    if (only && engine !== only) continue;
    if (!byEngine.has(engine)) byEngine.set(engine, { paths: new Map(), files: new Set(), events: 0 });
    const bucket = byEngine.get(engine);
    bucket.files.add(f);
    for (const ev of evs) { walk(ev, '', bucket.paths, 0); bucket.events++; }
    scanned++;
  }

  const covered = makeCoverageTest(loadSource());

  console.log('协议漂移审计');
  console.log('='.repeat(72));
  console.log(`扫描 ${scanned} 个流文件${badLines ? `（跳过 ${badLines} 行解析失败）` : ''}\n`);

  for (const [engine, b] of [...byEngine].sort((a, b) => b[1].events - a[1].events)) {
    const rows = [...b.paths.entries()]
      .map(([p, r]) => ({ path: p, ...r, ok: covered(r.leaf), rank: rankOf(p, r.leaf, r.sample) }))
      .filter(r => showAll || !r.ok)
      .sort((a, b) => a.rank - b.rank || b.n - a.n);

    const total = b.paths.size;
    const gaps = [...b.paths.entries()].filter(([, r]) => !covered(r.leaf)).length;
    console.log(`【${engine}】 ${b.files.size} 个流 / ${b.events.toLocaleString()} 事件 / ${total} 个字段路径`);
    console.log(`  未被源码引用: ${gaps} 个` + (gaps ? '' : '  ✅ 全覆盖'));
    if (!rows.length) { console.log(); continue; }
    console.log('');
    for (let lv = 0; lv <= 2; lv++) {
      const grp = rows.filter(r => r.rank === lv);
      if (!grp.length) continue;
      const cap = lv === 2 ? 5 : 14;
      console.log('  ' + RANK_LABEL[lv] + `   (${grp.length})`);
      for (const r of grp.slice(0, cap)) {
        let s = r.sample === undefined ? '' : String(r.sample).replace(/\s+/g, ' ');
        if (s.length > SAMPLE_LEN) s = s.slice(0, SAMPLE_LEN) + '…';
        console.log('     ' + String(r.n).padStart(6) + '  ' + r.path.padEnd(44) + s);
      }
      if (grp.length > cap) console.log(`     … 另有 ${grp.length - cap} 个`);
      console.log('');
    }
  }
  console.log('说明: "!" = 该字段在事件流里出现过，但源码里找不到对应的读取。');
  console.log('      叶子名匹配是保守的（属性访问/字符串/解构都算用了），所以列出来的基本都值得看一眼。');
}
main();
