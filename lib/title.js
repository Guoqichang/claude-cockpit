// Turn a pasted blob (terminal dump, TUI, resume prompt) into a sidebar title.
// Shared by Claude first-text fallback and Cursor auto-title.

const HARD_JUNK = [
  /^last login:/i,
  /^briefly inform the user\b/i,
  /^implement the plan as specified/i,
  /^continue from where you left off/i,
  /^上一轮回复因连接中断/,
  /^继续[。！!]?$/,
  /^[\w.-]+@[\w.-]+\s/,                 // looperhome@host ~ %
  /^root@[\w.-]+/,
  /'s password:\s*$/i,
  /^\[\d+\]\s+\d+$/,                    // job control: [1] 44798
  /^[━─┃│▌▣■\-·\s]+$/,
  /^\+?[a-z0-9]{6,}$/i,                 // +q4d73pppppp
  /^(build|agent|plan)\b/i,
  /interrupted\s*$/i,
  /^hello[!！.]?\s+how can i assist/i,
  /无审查\)/,
  /\b\d+(\.\d+)?s$/,                      // TUI timer: 56.3s
  /^(你好[！!,，.。]?\s*)?(需要我帮你做什么|有什么我可以帮你)/,
];

const SOFT_JUNK = /^(hi|hello|hey|ok|okay|yes|no|嗯|好|哈喽|你好)[!！.。]*$/i;

function tidyLine(line) {
  let s = String(line)
    .replace(/^[┃│▌▣■\s·]+/, '')
    .replace(/[┃│▌▣■]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "registry…does not supp 为啥报错了" → keep the human question
  const cjk = s.match(/[\u4e00-\u9fff].*$/);
  if (cjk && cjk[0].length >= 4 && cjk.index >= 16) {
    const q = cjk[0];
    if (/^[)）]/.test(q)) return s;          // leftover from "(无审查)"
    if (/·\s*\d/.test(q) || /\b\d+(\.\d+)?s$/.test(q)) return s;
    return q;
  }
  return s;
}

function isHardJunk(line) {
  if (!line || line.length < 2) return true;
  if (HARD_JUNK.some((re) => re.test(line))) return true;
  const stripped = line.replace(/[┃│▌▣■━─\s·]/g, '');
  // decorative leftovers only — keep short words like "hi" for the soft path
  return stripped.length < 3 && !/^[\w\u4e00-\u9fff]+$/i.test(stripped);
}

function scoreLine(line) {
  let s = 1;
  if (/[？?]/.test(line)) s += 3;
  if (/[\u4e00-\u9fff]/.test(line)) s += 2;
  if (/(为啥|怎么|为何|帮我|请问|为什么|如何)/.test(line)) s += 3;
  // log line that also carries a human question ("…does not supp 为啥报错了")
  if (/does not support|traceback|error:|exception/i.test(line) && /[\u4e00-\u9fff]/.test(line)) s += 2;
  // bare error dump with no user words
  if (/^[\w./:-]+ does not support/i.test(line) && !/[\u4e00-\u9fff]/.test(line)) s -= 3;
  return s;
}

/**
 * @param {string} text
 * @param {{ max?: number }} [opts]
 * @returns {{ title: string, quality: 'hard' | 'soft' | '' }}
 */
export function pickTitleFromText(text, { max = 48 } = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const hard = [];
  const soft = [];
  for (const raw of lines) {
    const line = tidyLine(raw);
    if (isHardJunk(line)) continue;
    if (SOFT_JUNK.test(line)) { soft.push(line); continue; }
    hard.push(line);
  }

  let best = '', bestScore = 0;
  for (const line of hard) {
    const s = scoreLine(line);
    if (s > bestScore) { best = line; bestScore = s; }
  }
  if (best && bestScore > 0) return { title: best.slice(0, max), quality: 'hard' };
  if (soft[0]) return { title: soft[0].slice(0, max), quality: 'soft' };
  return { title: '', quality: '' };
}
