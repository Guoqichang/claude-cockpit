/* global marked, DOMPurify, Terminal, FitAddon */
'use strict';

const $ = (s) => document.querySelector(s);
const messagesRoot = $('#messages');
const termContainer = $('#term-container');

marked.setOptions({ gfm: true, breaks: true });

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ocSyn(kind, text) {
  return `<span class="oc-syn-${kind}">${escapeHtml(text)}</span>`;
}

const OC_KW = {
  python: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '),
  javascript: 'async await break case catch class const continue debugger default delete else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while yield true false null undefined'.split(' '),
  typescript: 'as async await break case catch class const continue declare default delete else enum export extends finally for from function if implements import in interface instanceof let new of private protected public return static super switch this throw try type typeof var void while yield true false null undefined'.split(' '),
  bash: 'if then else elif fi for do done in case esac function return export local source alias set unset while until select time coproc'.split(' '),
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'.split(' '),
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' '),
};
OC_KW.js = OC_KW.javascript;
OC_KW.ts = OC_KW.typescript;
OC_KW.py = OC_KW.python;
OC_KW.sh = OC_KW.bash;
OC_KW.shell = OC_KW.bash;
OC_KW.zsh = OC_KW.bash;
const OC_KW_SET = Object.fromEntries(Object.entries(OC_KW).map(([k, v]) => [k, new Set(v)]));
const OC_BUILTIN = new Set('self this super console process window document print len range open type int str list dict set True False None NoneType undefined NaN module exports require __name__ __init__ cd ls cat grep awk sed curl wget git npm npx node python python3 pip echo printf export source'.split(' '));
const OC_PATH_RE = /(?:\/(?:[\w.-]+\/)*[\w.-]+|\b[\w.-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|sh|zsh|bash|html|css|scss|go|rs|vue|toml|yml|yaml|sql|txt|svg|png|jpg)\b)/;

function ocTokPlain(src) {
  const s = String(src || '');
  const re = /(?:\/(?:[\w.-]+\/)*[\w.-]+|\b[\w.-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|sh|zsh|bash|html|css|scss|go|rs|vue|toml|yml|yaml|sql|txt|svg|png|jpg)\b)/g;
  let last = 0, out = '';
  for (const m of s.matchAll(re)) {
    out += escapeHtml(s.slice(last, m.index));
    out += ocSyn('variable', m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

function ocTokJson(src) {
  const s = String(src || '');
  let i = 0, out = '';
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1, esc = false;
      while (j < n) {
        const ch = s[j];
        if (esc) { esc = false; j++; continue; }
        if (ch === '\\') { esc = true; j++; continue; }
        if (ch === '"') { j++; break; }
        j++;
      }
      const tok = s.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(s[k])) k++;
      out += ocSyn(s[k] === ':' ? 'variable' : 'string', tok);
      i = j;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < n && /[\d.eE+-]/.test(s[j])) j++;
      out += ocSyn('number', s.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z]/.test(s[j])) j++;
      const w = s.slice(i, j);
      out += (w === 'true' || w === 'false' || w === 'null') ? ocSyn('keyword', w) : escapeHtml(w);
      i = j;
      continue;
    }
    out += /[{}\[\]:,]/.test(c) ? ocSyn('punct', c) : escapeHtml(c);
    i++;
  }
  return out;
}

function ocTokDiff(src) {
  return String(src || '').split('\n').map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return ocSyn('string', line);
    if (line.startsWith('-') && !line.startsWith('---')) return ocSyn('variable', line);
    if (line.startsWith('@@')) return ocSyn('function', line);
    return escapeHtml(line);
  }).join('\n');
}

function ocTokHttp(src) {
  return String(src || '').split('\n').map((line) => {
    const m = line.match(/^(\s*)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(.*)$/);
    if (!m) return ocTokPlain(line);
    return escapeHtml(m[1]) + ocSyn('keyword', m[2]) + ' ' + ocSyn('string', m[3]) + ocTokPlain(m[4]);
  }).join('\n');
}

function ocTokBash(src) {
  const s = String(src || '');
  let i = 0, out = '';
  const n = s.length;
  const kw = OC_KW_SET.bash;
  while (i < n) {
    if (s[i] === '#') {
      let j = s.indexOf('\n', i);
      if (j < 0) j = n;
      out += ocSyn('comment', s.slice(i, j));
      i = j;
      continue;
    }
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1;
      while (j < n && s[j] !== q) { if (s[j] === '\\') j++; j++; }
      j = Math.min(n, j + 1);
      out += ocSyn('string', s.slice(i, j));
      i = j;
      continue;
    }
    if (s[i] === '$') {
      let j = i + 1;
      if (s[j] === '{') { while (j < n && s[j] !== '}') j++; j++; }
      else while (j < n && /[\w-]/.test(s[j])) j++;
      out += ocSyn('variable', s.slice(i, Math.max(i + 1, j)));
      i = Math.max(i + 1, j);
      continue;
    }
    if (s[i] === '-' && i + 1 < n && /[A-Za-z-]/.test(s[i + 1])) {
      let j = i + 1;
      while (j < n && /[\w-]/.test(s[j])) j++;
      out += ocSyn('operator', s.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_./~]/.test(s[i])) {
      let j = i + 1;
      while (j < n && /[\w./:@~+-]/.test(s[j])) j++;
      const w = s.slice(i, j);
      if (OC_PATH_RE.test(w) || w.includes('/')) out += ocSyn('variable', w);
      else if (kw.has(w)) out += ocSyn('keyword', w);
      else if (OC_BUILTIN.has(w)) out += ocSyn('variable', w);
      else {
        let k = j;
        while (k < n && /\s/.test(s[k])) k++;
        out += s[k] === '=' ? ocSyn('variable', w) : ocSyn('function', w);
      }
      i = j;
      continue;
    }
    out += escapeHtml(s[i++]);
  }
  return out;
}

function ocTokCode(src, lang) {
  const s = String(src || '');
  const kw = OC_KW_SET[lang] || OC_KW_SET.javascript;
  const hashComment = lang === 'python' || lang === 'py' || lang === 'yaml' || lang === 'yml' || lang === 'toml';
  const slashComment = !hashComment;
  let i = 0, out = '';
  const n = s.length;
  while (i < n) {
    if (hashComment && s[i] === '#') {
      let j = s.indexOf('\n', i); if (j < 0) j = n;
      out += ocSyn('comment', s.slice(i, j)); i = j; continue;
    }
    if (slashComment && s.startsWith('//', i)) {
      let j = s.indexOf('\n', i); if (j < 0) j = n;
      out += ocSyn('comment', s.slice(i, j)); i = j; continue;
    }
    if (s.startsWith('/*', i)) {
      let j = s.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      out += ocSyn('comment', s.slice(i, j)); i = j; continue;
    }
    if (s[i] === '"' || s[i] === "'" || s[i] === '`') {
      const q = s[i];
      let j = i + 1, esc = false;
      while (j < n) {
        if (esc) { esc = false; j++; continue; }
        if (s[j] === '\\') { esc = true; j++; continue; }
        if (s[j] === q) { j++; break; }
        if (q !== '`' && s[j] === '\n') break;
        j++;
      }
      out += ocSyn('string', s.slice(i, j)); i = j; continue;
    }
    if (s[i] === '-' || (s[i] >= '0' && s[i] <= '9')) {
      if (s[i] === '-' && !(s[i + 1] >= '0' && s[i + 1] <= '9')) { out += ocSyn('operator', '-'); i++; continue; }
      let j = i + 1;
      while (j < n && /[\d.xa-fA-F_]/.test(s[j])) j++;
      out += ocSyn('number', s.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_/$]/.test(s[i])) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(s[j])) j++;
      const w = s.slice(i, j);
      let k = j; while (k < n && /\s/.test(s[k])) k++;
      if (kw.has(w)) out += ocSyn('keyword', w);
      else if (OC_BUILTIN.has(w)) out += ocSyn('variable', w);
      else if (s[k] === '(') out += ocSyn('function', w);
      else if (/^[A-Z]/.test(w) && w.length > 1) out += ocSyn('type', w);
      else out += escapeHtml(w);
      i = j; continue;
    }
    if (/[+\-*/%=<>!&|^~?:]/.test(s[i])) {
      let j = i + 1;
      while (j < n && /[+\-*/%=<>!&|^~?:]/.test(s[j])) j++;
      out += ocSyn('operator', s.slice(i, j)); i = j; continue;
    }
    if ('(){}[],.;'.includes(s[i])) { out += ocSyn('punct', s[i]); i++; continue; }
    out += escapeHtml(s[i++]);
  }
  return out;
}

function ocTokenize(code, lang) {
  const src = String(code || '');
  if (!src) return '';
  lang = String(lang || '').toLowerCase().replace(/^language-/, '');
  if (lang === 'json') return ocTokJson(src);
  if (lang === 'diff' || lang === 'patch') return ocTokDiff(src);
  if (lang === 'http') return ocTokHttp(src);
  if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh' || lang === 'console') return ocTokBash(src);
  if (lang === 'python' || lang === 'py' || lang === 'javascript' || lang === 'js' || lang === 'typescript' || lang === 'ts'
      || lang === 'tsx' || lang === 'jsx' || lang === 'go' || lang === 'rust' || lang === 'rs') {
    const map = { py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', rs: 'rust' };
    return ocTokCode(src, map[lang] || lang);
  }
  if (!lang) {
    const t = src.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && /[\]}]$/.test(t)) return ocTokJson(src);
    if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//m.test(src)) return ocTokHttp(src);
    if (/^[+\-]{3}\s|^@@ /m.test(src)) return ocTokDiff(src);
  }
  return ocTokPlain(src);
}

function ocColorize(el) {
  if (!el) return;
  for (const code of el.querySelectorAll('pre code')) {
    const langMatch = (code.className || '').match(/language-([\w+-]+)/);
    const lang = langMatch ? langMatch[1] : '';
    if (lang === 'mermaid') continue;
    code.innerHTML = ocTokenize(code.textContent || '', lang);
  }
  for (const code of el.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    const raw = code.textContent || '';
    if (OC_PATH_RE.test(raw) || /^(GET|POST|PUT|PATCH|DELETE)\b/.test(raw) || raw.includes('/')) {
      code.innerHTML = /^(GET|POST|PUT|PATCH|DELETE)\b/.test(raw) ? ocTokHttp(raw) : ocTokPlain(raw);
    }
  }
}

// LaTeX segments must be hidden from markdown (underscores/asterisks inside
// formulas would become <em>), then restored verbatim for KaTeX auto-render.
function md(text) {
  const store = [];
  let t = String(text ?? '');
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => (store.push(`$$${m}$$`), `%%MATH${store.length - 1}%%`));
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => (store.push(`\\[${m}\\]`), `%%MATH${store.length - 1}%%`));
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => (store.push(`\\(${m}\\)`), `%%MATH${store.length - 1}%%`));
  t = t.replace(/\$(?!\s)((?:[^$\n\\]|\\.)+?)\$(?!\d)/g, (_, m) =>
    /\s$/.test(m) ? `$${m}$` : (store.push(`$${m}$`), `%%MATH${store.length - 1}%%`));
  let html = DOMPurify.sanitize(marked.parse(t));
  html = html.replace(/%%MATH(\d+)%%/g, (_, i) => escapeHtml(store[+i] ?? ''));
  return html;
}

const MATH_OPTS = {
  delimiters: [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
    { left: '$', right: '$', display: false },
  ],
  throwOnError: false,
};

// mermaid is 3.4MB, so it is only fetched when a diagram actually shows up
let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('/vendor/mermaid/mermaid.esm.min.mjs').then(m => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        themeVariables: {
          background: '#1f1c18', primaryColor: '#26221c', primaryTextColor: '#e8e2d6',
          primaryBorderColor: '#8a7340', lineColor: '#8a7340',
          secondaryColor: '#24211b', tertiaryColor: '#1a1712',
          fontFamily: '-apple-system, "PingFang SC", sans-serif',
        },
      });
      return m.default;
    }).catch(() => null);
  }
  return mermaidPromise;
}

let mermaidSeq = 0;
async function renderMermaidBlocks(el) {
  const blocks = el.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  if (!mermaid) return;
  for (const code of blocks) {
    const src = code.textContent;
    const pre = code.parentElement;
    try {
      const { svg } = await mermaid.render('mmd' + (++mermaidSeq), src);
      const box = document.createElement('div');
      box.className = 'mermaid-box';
      box.innerHTML = svg;
      // keep the source reachable — diagrams get copied into docs
      const det = document.createElement('details');
      det.className = 'tool';
      det.innerHTML = '<summary><span class="tname">mermaid 源码</span></summary>';
      const p = document.createElement('pre');
      p.textContent = src;
      det.appendChild(p);
      pre.replaceWith(box, det);
    } catch { /* invalid diagram: leave the code block as-is */ }
  }
}

function typeset(el) {
  if (window.renderMathInElement) {
    try { renderMathInElement(el, MATH_OPTS); } catch { /* leave source text */ }
  }
  renderMermaidBlocks(el);
  // links that aren't web URLs (file paths Claude emits) can't be navigated to —
  // mark them so they don't look like broken links
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!/^(https?:|mailto:|#)/i.test(href)) {
      a.classList.add('local-ref');
      a.title = href + '（本地路径，点击不跳转）';
    } else if (/^https?:/i.test(href)) {
      a.title = href;
    }
  }
  // Claude writes `![](/Users/…/foo.png)` — the browser would hit 127.0.0.1/Users/…
  for (const img of el.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:|blob:|\/api\/)/i.test(src)) continue;
    const fp = src.replace(/^file:\/\//i, '');
    if (!fp || fp.startsWith('//')) continue;
    img.src = '/api/local-file?path=' + encodeURIComponent(fp);
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(img.src, '_blank', 'width=1100,height=850'));
  }
}

// The cockpit is a single-page app (and runs in a frameless Edge --app window):
// following a link in place would replace the whole UI. Always pop a new window.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) return;               // in-page anchor
  e.preventDefault();
  if (!/^(https?:|mailto:)/i.test(href)) return;  // local path: never navigate away
  if (/^mailto:/i.test(href)) { window.open(href, '_blank'); return; }
  const w = Math.min(1200, Math.round(screen.availWidth * 0.8));
  const h = Math.min(900, Math.round(screen.availHeight * 0.85));
  const left = Math.round((screen.availWidth - w) / 2);
  const top = Math.round((screen.availHeight - h) / 2);
  const win = window.open(href, '_blank', `noopener,noreferrer,width=${w},height=${h},left=${left},top=${top}`);
  if (win) win.opener = null;
}, true);

// ---------------- WebSocket ----------------
let ws = null, wsReady = false;
const wsHandlers = new Map(); // ch -> fn(msg)
let chSeq = 0;

function connectWS() {
  // must follow the page scheme: an https page cannot open a ws:// socket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    wsReady = true;
    // re-attach running turns: server kept them alive and buffered missed events
    for (const [, v] of chatViews) {
      if (v.running && v.ch) {
        wsSend({ op: 'chat.attach', ch: v.ch, from: v.evCount || 0 });
        if (v.spinner) v.spinner.textContent = '● 已重连，恢复接收…';
      } else if (v.id) {
        adoptLiveTurn(v);   // server may have restarted; re-discover live turns
      }
    }
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    wsHandlers.get(m.ch)?.(m);
  };
  ws.onclose = () => {
    wsReady = false;
    for (const [, t] of terms) if (!t.dead) { t.dead = true; t.term.write('\r\n\x1b[31m[连接断开]\x1b[0m\r\n'); }
    // chats keep running server-side; just show reconnecting state
    for (const [, v] of chatViews) {
      if (v.running && v.spinner) v.spinner.textContent = '● 连接断开，重连中…（任务仍在后台运行）';
    }
    setTimeout(connectWS, 1500);
  };
}
const wsSend = (obj) => { if (wsReady) ws.send(JSON.stringify(obj)); };
connectWS();

// ---------------- message block rendering ----------------
function toolSummaryText(name, input) {
  if (!input) return name;
  if (input.command) return input.description || input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.prompt) return String(input.prompt).slice(0, 90);
  if (input.url) return input.url;
  const s = JSON.stringify(input);
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function truncate(text, n = 6000) {
  return text.length > n ? text.slice(0, n) + `\n…(截断，共 ${text.length} 字符)` : text;
}

// gateway errors are opaque; say what actually happened and what to do next
function explainError(text) {
  const s = String(text || '');
  if (/Maximum request body size/i.test(s)) {
    const m = s.match(/actual body size (\d+)/i);
    const mb = m ? (Number(m[1]) / 1048576).toFixed(2) + 'MB' : '过大';
    return `${s}\n\n说明：不是 Cockpit 的故障，也不是临时抖动——这是网关的硬限制。`
      + `Claude Code 每轮都会把整段会话历史重新发一遍，本轮请求体 ${mb}，超过了 MiMo 的 1MB 上限。\n`
      + `办法：① 发 /compact 压缩上下文后重试；② 换个新会话继续；③ 改用 DeepSeek（实测 3MB 也能过）。`;
  }
  if (/connectors are disabled because ANTHROPIC_API_KEY/i.test(s)) {
    return s + '\n\n（这行是用第三方网关时的正常提示，不影响本轮运行）';
  }
  return s;
}

// Render normalized blocks into container. toolMap pairs tool_use ↔ tool_result.
function renderBlocks(container, role, blocks, toolMap) {
  let userTexts = [];
  let userImages = [];
  let userFiles = [];
  for (const b of blocks) {
    if (b.type === 'image') {
      const src = b.url || `data:${b.mediaType || 'image/png'};base64,${b.data}`;
      if (role === 'user') { userImages.push(src); continue; }
      const wrap = document.createElement('div');
      wrap.className = 'msg-images';
      const img = document.createElement('img');
      img.src = src;
      img.addEventListener('click', () => window.open(src, '_blank', 'width=1000,height=800'));
      wrap.appendChild(img);
      container.appendChild(wrap);
      continue;
    }
    if (b.type === 'file') {
      if (role === 'user') { userFiles.push(b); continue; }
      container.appendChild(fileChip(b));
      continue;
    }
    if (b.type === 'text') {
      if (role === 'user') { userTexts.push(b.text); continue; }
      const div = document.createElement('div');
      div.className = 'md';
      div.innerHTML = md(b.text);
      typeset(div);
      container.appendChild(div);
    } else if (b.type === 'thinking') {
      const det = document.createElement('details');
      det.className = 'thinking';
      det.innerHTML = '<summary>思考过程</summary>';
      const body = document.createElement('div');
      body.className = 'think-body';
      body.textContent = truncate(b.text, 4000);
      // math only: keep the reasoning text verbatim, do not run it through markdown
      if (window.renderMathInElement) {
        try { renderMathInElement(body, MATH_OPTS); } catch { /* leave as text */ }
      }
      det.appendChild(body);
      container.appendChild(det);
    } else if (b.type === 'tool_use') {
      const det = document.createElement('details');
      det.className = 'tool';
      const sum = document.createElement('summary');
      const tn = document.createElement('span');
      tn.className = 'tname';
      tn.textContent = b.name;
      sum.appendChild(tn);
      sum.appendChild(document.createTextNode('  ' + toolSummaryText(b.name, b.input)));
      det.appendChild(sum);
      const pre = document.createElement('pre');
      pre.textContent = truncate(JSON.stringify(b.input, null, 2) ?? '', 3000);
      det.appendChild(pre);
      container.appendChild(det);
      if (b.id) toolMap.set(b.id, det);
    } else if (b.type === 'tool_result') {
      const target = toolMap.get(b.tool_use_id);
      const pre = document.createElement('pre');
      pre.textContent = truncate(b.text || (b.images?.length ? '' : '(空结果)'));
      const host = target || (() => {
        const det = document.createElement('details');
        det.className = 'tool' + (b.is_error ? ' error' : '');
        det.innerHTML = '<summary><span class="tname">结果</span></summary>';
        container.appendChild(det);
        return det;
      })();
      if (target && b.is_error) target.classList.add('error');
      if (pre.textContent) host.appendChild(pre);
      // images produced by tools (screenshots, Read on an image) render inline
      if (b.images?.length) {
        const strip = document.createElement('div');
        strip.className = 'msg-images tool-images';
        for (const im of b.images) {
          const src = im.url || `data:${im.mediaType || 'image/png'};base64,${im.data}`;
          const img = document.createElement('img');
          img.src = src;
          img.loading = 'lazy';
          img.addEventListener('click', () => window.open(src, '_blank', 'width=1100,height=850'));
          strip.appendChild(img);
        }
        host.appendChild(strip);
        if (target) target.open = true;   // a picture is worth unfolding
      }
    }
  }
  if (userTexts.length || userImages.length || userFiles.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    wrap.innerHTML = '<div class="msg-role">你</div>';
    if (userImages.length) {
      const strip = document.createElement('div');
      strip.className = 'msg-images';
      for (const src of userImages) {
        const img = document.createElement('img');
        img.src = src;
        img.addEventListener('click', () => window.open(src, '_blank', 'width=1000,height=800'));
        strip.appendChild(img);
      }
      wrap.appendChild(strip);
    }
    if (userFiles.length) {
      const strip = document.createElement('div');
      strip.className = 'msg-files';
      for (const f of userFiles) strip.appendChild(fileChip(f));
      wrap.appendChild(strip);
    }
    if (userTexts.length) {
      const bub = document.createElement('div');
      bub.className = 'bubble';
      bub.textContent = userTexts.join('\n');
      // same treatment as thinking: render formulas, leave everything else literal
      if (window.renderMathInElement) {
        try { renderMathInElement(bub, MATH_OPTS); } catch { /* leave as text */ }
      }
      wrap.appendChild(bub);
    }
    container.appendChild(wrap);
  }
}

function ocModelLabel(model, provider) {
  const m = String(model || '');
  const p = String(provider || '');
  let name = m;
  if (/deepseek-v4-pro/i.test(m)) name = 'DeepSeek V4 Pro';
  else if (/deepseek-v4-flash/i.test(m)) name = 'DeepSeek V4 Flash';
  if (/deepseek/i.test(p) && /v4-pro/i.test(m)) name += '（官方）';
  return name || m || 'OpenCode';
}
function ocAgentLabel(agent) {
  const a = String(agent || 'reverse');
  return a ? a.charAt(0).toUpperCase() + a.slice(1) : 'Reverse';
}
function fmtOcDur(ms) {
  if (ms == null || !Number.isFinite(+ms) || +ms < 0) return '';
  return (+ms / 1000).toFixed(1) + 's';
}
function fmtTok(n) {
  const x = Number(n) || 0;
  if (x >= 1000) return (x / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(x);
}

function ocThoughtEl(text, durationMs, open) {
  const det = document.createElement('details');
  det.className = 'oc-thought';
  if (open) det.open = true;
  const sum = document.createElement('summary');
  const dur = fmtOcDur(durationMs);
  sum.textContent = dur ? `+ Thought: ${dur}` : '+ Thought';
  const body = document.createElement('div');
  body.className = 'oc-thought-body';
  body.textContent = text || '';
  det.append(sum, body);
  return det;
}

function ocToolEl(b) {
  const box = document.createElement('div');
  box.className = 'oc-term' + (b.status === 'error' || b.error ? ' error' : '');
  const head = document.createElement('div');
  head.className = 'oc-term-cmd';
  const cmd = b.command || '';
  if (b.name === 'bash' || cmd) head.innerHTML = ocTokBash('$ ' + (cmd || b.title || b.name));
  else head.innerHTML = ocTokPlain((b.name || 'tool') + (b.title && b.title !== b.name ? '  ' + b.title : ''));
  box.appendChild(head);
  const out = (typeof b.output === 'string' ? b.output : '') || b.error || '';
  if (out) {
    const pre = document.createElement('pre');
    pre.className = 'oc-term-out';
    const t = out.trim();
    const lang = (t.startsWith('{') || t.startsWith('[')) ? 'json'
      : /^(GET|POST|PUT|PATCH|DELETE)\s+\//m.test(out) ? 'http'
      : '';
    pre.innerHTML = ocTokenize(out, lang);
    box.appendChild(pre);
  } else if (b.status && b.status !== 'completed') {
    const st = document.createElement('div');
    st.className = 'oc-term-st';
    st.textContent = b.status;
    box.appendChild(st);
  }
  return box;
}

function ocFooterEl(b) {
  const line = document.createElement('div');
  line.className = 'oc-footer';
  const bits = [ocAgentLabel(b.agent), ocModelLabel(b.model, b.provider)];
  const dur = fmtOcDur(b.durationMs);
  if (dur) bits.push(dur);
  const sq = document.createElement('span');
  sq.className = 'oc-sq';
  line.append(sq, document.createTextNode(' ' + bits.join(' · ')));
  return line;
}

function renderOcBlocks(container, role, blocks) {
  if (role === 'user') {
    const texts = (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).filter(Boolean);
    if (!texts.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'oc-user';
    wrap.textContent = texts.join('\n');
    container.appendChild(wrap);
    return;
  }
  for (const b of blocks || []) {
    if (b.type === 'oc_thought') container.appendChild(ocThoughtEl(b.text, b.durationMs, false));
    else if (b.type === 'oc_tool') container.appendChild(ocToolEl(b));
    else if (b.type === 'text') {
      const div = document.createElement('div');
      div.className = 'oc-md';
      div.innerHTML = md(b.text);
      typeset(div);
      ocColorize(div);
      container.appendChild(div);
    } else if (b.type === 'oc_footer') container.appendChild(ocFooterEl(b));
    else if (b.type === 'oc_note') {
      const n = document.createElement('div');
      n.className = 'oc-note';
      n.textContent = b.text;
      container.appendChild(n);
    }
  }
}

function paintOcPart(el, part) {
  el.innerHTML = '';
  if (!part) return;
  if (part.type === 'reasoning') {
    const tm = part.time || {};
    const dur = tm.end && tm.start ? tm.end - tm.start : (tm.start ? Date.now() - tm.start : null);
    el.appendChild(ocThoughtEl(part.text || '', dur, !tm.end));
  } else if (part.type === 'tool') {
    const st = part.state || {};
    const inp = st.input && typeof st.input === 'object' ? st.input : {};
    el.appendChild(ocToolEl({
      name: part.tool, title: st.title, command: inp.command || inp.cmd || '',
      output: typeof st.output === 'string' ? st.output : '',
      status: st.status, error: typeof st.error === 'string' ? st.error : '',
    }));
  } else if (part.type === 'text') {
    const div = document.createElement('div');
    div.className = 'oc-md';
    div.innerHTML = md(part.text || '');
    typeset(div);
    ocColorize(div);
    el.appendChild(div);
  }
}

function ocPartEl(v, part, spinner) {
  if (!part?.id) return;
  if (!v.ocMap) v.ocMap = new Map();
  if (!v.ocParts) v.ocParts = new Map();
  v.ocParts.set(part.id, part);
  let el = v.ocMap.get(part.id);
  if (!el) {
    el = document.createElement('div');
    el.dataset.ocPart = part.id;
    v.ocMap.set(part.id, el);
    const host = spinner || v.spinner;
    if (host && host.parentNode === v.el) v.el.insertBefore(el, host);
    else v.el.appendChild(el);
  }
  paintOcPart(el, part);
  return el;
}

const OC_WINDOW = 128000;

function applyOcMeta(v, data) {
  if (!v) return;
  const prev = v.ocMeta || {};
  let tokens = prev.tokens || 0;
  if (data.tokens != null) tokens = data.tokens;
  else if (data.tokensInput != null || data.tokensOutput != null) {
    tokens = (data.tokensInput || 0) + (data.tokensOutput || 0);
  }
  v.ocMeta = {
    ...prev,
    title: data.title || prev.title || v.title || '',
    cost: data.cost != null ? data.cost : (prev.cost || 0),
    tokens,
    agent: data.agent || prev.agent || v.agent || 'reverse',
    model: data.model || prev.model || '',
    provider: data.provider || prev.provider || '',
    version: data.version || prev.version || '',
    cwd: data.cwd || prev.cwd || v.cwd || '',
    todos: data.todos || prev.todos || [],
    mcp: data.mcp || prev.mcp || {},
  };
  v.agent = v.ocMeta.agent;
  if (v.ocMeta.title) v.title = v.ocMeta.title;
  renderOcChrome(v);
}

function mcpStatusOf(entry) {
  if (!entry) return 'unknown';
  if (typeof entry === 'string') return entry;
  return entry.status || 'unknown';
}

function renderOcMcp(mcp) {
  const root = $('#oc-rail-mcp');
  if (!root) return;
  root.innerHTML = '';
  const names = Object.keys(mcp || {});
  if (!names.length) {
    root.innerHTML = '<div class="oc-empty">未连接</div>';
    return;
  }
  for (const name of names.sort()) {
    const st = mcpStatusOf(mcp[name]);
    const on = st === 'connected';
    const row = document.createElement('div');
    row.className = 'oc-mcp-row';
    const dot = document.createElement('span');
    dot.className = 'oc-mcp-dot' + (on ? ' on' : '');
    const lab = document.createElement('span');
    lab.textContent = name;
    const tag = document.createElement('span');
    tag.className = 'oc-mcp-st' + (on ? ' on' : '');
    tag.textContent = on ? 'Connected' : (st === 'disabled' ? 'Disabled' : st);
    row.append(dot, lab, tag);
    root.appendChild(row);
  }
}

function renderOcTodo(todos) {
  const root = $('#oc-rail-todo');
  if (!root) return;
  root.innerHTML = '';
  const list = Array.isArray(todos) ? todos : [];
  if (!list.length) {
    root.innerHTML = '<div class="oc-empty">无</div>';
    return;
  }
  for (const t of list) {
    const row = document.createElement('div');
    const st = t.status || 'pending';
    row.className = 'oc-todo-row' + (st === 'completed' || st === 'cancelled' ? ' done' : st === 'in_progress' ? ' doing' : '');
    const mark = document.createElement('span');
    mark.className = 'oc-todo-mark';
    mark.textContent = st === 'completed' ? '✓' : st === 'in_progress' ? '▸' : '○';
    const lab = document.createElement('span');
    lab.textContent = t.content || '';
    row.append(mark, lab);
    root.appendChild(row);
  }
}

function renderOcChrome(v) {
  if (!isOcTui(v) || currentChatKey !== v.key) return;
  const m = v.ocMeta || {};
  const used = m.tokens || 0;
  const pct = Math.min(99, Math.round((used / OC_WINDOW) * 100));
  const titleEl = $('#oc-rail-title');
  if (titleEl) titleEl.textContent = m.title || v.title || '';
  const ctx = $('#oc-rail-ctx');
  if (ctx) {
    ctx.innerHTML = `<div class="oc-tok">${used.toLocaleString()} tokens</div>
      <div class="oc-pct"><span class="oc-bar-track"><span style="width:${pct}%"></span></span> ${pct}% used</div>
      <div class="oc-cost">$${(m.cost || 0).toFixed(2)} spent</div>`;
  }
  renderOcMcp(m.mcp);
  renderOcTodo(m.todos);
  const bar = $('#oc-bar');
  if (bar) {
    bar.innerHTML = `<span class="oc-bar-cwd">${escapeHtml(m.cwd || v.cwd || '')}</span>
      <span class="oc-bar-mid">${escapeHtml(ocAgentLabel(m.agent))} · ${escapeHtml(ocModelLabel(m.model, m.provider))}</span>
      <span class="oc-bar-use">${fmtTok(used)} (${pct}%) $${(m.cost || 0).toFixed(2)}</span>
      <span class="oc-bar-ver"><span class="oc-dot"></span> OpenCode ${escapeHtml(m.version || '')}</span>`;
  }
}

function setOcMode(on) {
  $('#chat-view').classList.toggle('oc-mode', !!on);
  const rail = $('#oc-rail');
  const bar = $('#oc-bar');
  if (rail) rail.hidden = !on;
  if (bar) bar.hidden = !on;
}

function refreshOcMcp(v) {
  if (v?.engine !== 'opencode') return;
  fetch('/api/opencode/mcp').then((r) => r.json()).then((mcp) => {
    if (!v.ocMeta) v.ocMeta = {};
    v.ocMeta.mcp = mcp || {};
    renderOcChrome(v);
  }).catch(() => {});
}

function applyOcSessionInfo(v, info) {
  if (!info) return;
  const tokens = info.tokens
    ? (info.tokens.input || 0) + (info.tokens.output || 0)
    : undefined;
  applyOcMeta(v, {
    title: info.title,
    cost: info.cost,
    tokens,
    agent: info.agent,
    model: info.model?.id || info.modelID,
    provider: info.model?.providerID || info.providerID,
    version: info.version,
    cwd: info.directory,
  });
  if (info.title && currentChatKey === v.key) {
    $('#chat-title').textContent = info.title;
    $('#mobile-title').textContent = info.title;
  }
}

function expandIndexedText(text) {
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
  const extra = [];
  for (const fp of images) extra.push({ type: 'image', url: '/api/local-file?path=' + encodeURIComponent(fp) });
  for (const fp of files) extra.push({ type: 'file', name: fp.split(/[/\\]/).pop(), url: '/api/local-file?path=' + encodeURIComponent(fp) });
  if (cleaned) extra.push({ type: 'text', text: cleaned });
  return { extra, hadIndex: images.length + files.length > 0 };
}

// Normalize raw Anthropic message content (from stream-json events) → block list
function normalizeStreamContent(content) {
  const blocks = [];
  const pushText = (t) => {
    if (!t) return;
    const { extra, hadIndex } = expandIndexedText(t);
    if (hadIndex) blocks.push(...extra);
    else if (t.trim()) blocks.push({ type: 'text', text: t });
  };
  if (typeof content === 'string') { pushText(content); return blocks; }
  for (const b of content || []) {
    if (b.type === 'text' && b.text) pushText(b.text);
    else if (b.type === 'image' && b.source?.type === 'base64') blocks.push({ type: 'image', mediaType: b.source.media_type, data: b.source.data });
    else if (b.type === 'thinking' && b.thinking?.trim()) blocks.push({ type: 'thinking', text: b.thinking });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    else if (b.type === 'tool_result') {
      let c = b.content;
      const images = [];
      if (Array.isArray(c)) {
        const parts = [];
        for (const x of c) {
          if (x.type === 'image' && x.source?.type === 'base64') images.push({ mediaType: x.source.media_type, data: x.source.data });
          else if (x.type === 'text') parts.push(x.text);
          else parts.push(`[${x.type}]`);
        }
        c = parts.join('\n');
      }
      blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id, text: String(c ?? ''), is_error: !!b.is_error, images });
    }
  }
  return blocks;
}

// ---------------- chat views ----------------
// key -> {el, toolMap, running, ch, slug, id, cwd, title}
const chatViews = new Map();
let currentChatKey = null;

function getOrCreateChatView(key, init) {
  let v = chatViews.get(key);
  if (!v) {
    const el = document.createElement('div');
    v = { key, el, toolMap: new Map(), running: false, ch: null, queue: [], ...init };
    chatViews.set(key, v);
    messagesRoot.appendChild(el);
  }
  return v;
}

function showChatView(key) {
  currentChatKey = key;
  for (const [k, v] of chatViews) v.el.style.display = k === key ? '' : 'none';
  const v = chatViews.get(key);
  $('#chat-title').textContent = v.title || '新会话';
  $('#mobile-title').textContent = v.title || '新会话';
  const eng = engineName(v.engine);
  $('#chat-sub').textContent = `${eng}${v.cwd ? '  ·  ' + v.cwd : ''}${v.id ? '  ·  ' + v.id : ''}`;
  setOcMode(isOcTui(v));
  if (isOcTui(v)) renderOcChrome(v);
  switchView('chat');
  updateComposer(v);
  messagesRoot.scrollTop = messagesRoot.scrollHeight;
}

function updateComposer(v) {
  const isCursor = v?.engine === 'cursor';
  const isHermes = v?.engine === 'hermes';
  const isOc = isOcTui(v);
  syncModelSelector(v?.engine || 'claude');
  $('#btn-send').textContent = v.running ? '排队' : '发送';
  $('#btn-stop').hidden = !v.running;
  $('#input').placeholder = v.running
    ? '当前轮运行中——输入后 Enter 排队，本轮结束自动发送'
    : isOc
      ? '/~ 发给 Reverse Agent，Enter 发送'
      : isHermes
        ? '输入发给 Hermes Agent，Enter 发送'
        : (isCursor
          ? '输入发给 Cursor Agent，Enter 发送 · 可粘贴/拖入图片和文件'
          : '输入消息，Enter 发送，Shift+Enter 换行');
  $('#btn-attach').hidden = isHermes || isOc;
  $('#btn-attach').title = isCursor ? '添加图片或文件（落盘后按路径发给 Agent）' : '添加图片';
  $('#file-input').accept = isCursor ? '' : 'image/*';
  $('#perm-mode')?.closest('label')?.toggleAttribute('hidden', isCursor || isHermes || isOc);
}

function enqueue(v, text, atts = [], model = null) {
  const div = document.createElement('div');
  div.className = 'queued';
  const head = document.createElement('div');
  head.className = 'queued-head';
  const label = document.createElement('span');
  label.textContent = model ? `已排队 · 用 ${model} · 本轮结束自动发送` : '已排队 · 本轮结束自动发送';
  const x = document.createElement('span');
  x.className = 'queued-x';
  x.textContent = '撤回';
  head.append(label, x);
  const body = document.createElement('div');
  body.className = 'queued-body';
  body.textContent = text || (atts.length ? `（${atts.length} 个附件）` : '');
  div.append(head, body);
  if (atts.length) div.appendChild(attachPreviewStrip(atts));
  v.el.appendChild(div);
  const item = { text, atts, el: div };
  x.addEventListener('click', () => {
    const i = v.queue.indexOf(item);
    if (i >= 0) v.queue.splice(i, 1);
    div.remove();
  });
  item.model = model;
  v.queue.push(item);
  if (currentChatKey === v.key) messagesRoot.scrollTop = messagesRoot.scrollHeight;
}

function flushQueue(v) {
  if (!v.queue.length) return;
  const text = v.queue.map(q => q.text).filter(Boolean).join('\n\n');
  const atts = v.queue.flatMap(q => q.atts || []).slice(0, 8);
  const model = v.queue.find(q => q.model)?.model || null;   // first explicit pick wins
  for (const q of v.queue) q.el.remove();
  v.queue.length = 0;
  dispatch(v, text, atts, model);
}

function failRunningChat(v, reason) {
  clearInterval(v.tick);
  clearLive(v);
  if (v.spinner) { v.spinner.remove(); v.spinner = null; }
  const err = document.createElement('div');
  err.className = 'error-line';
  err.textContent = reason;
  v.el.appendChild(err);
  if (v.ch) wsHandlers.delete(v.ch);
  v.running = false; v.ch = null; v.stopRequested = false;
  releaseLocalTurn(v);
  if (currentChatKey === v.key) updateComposer(v);
  restoreQueueToInput(v);
}

// After a manual stop, queued messages go back to the composer for editing
// instead of auto-firing a new turn.
function restoreQueueToInput(v) {
  if (!v.queue.length) return;
  const text = v.queue.map(q => q.text).filter(Boolean).join('\n\n');
  const atts = v.queue.flatMap(q => q.atts || []);
  for (const q of v.queue) q.el.remove();
  v.queue.length = 0;
  if (currentChatKey === v.key) {
    const inp = $('#input');
    if (text) inp.value = inp.value ? inp.value + '\n\n' + text : text;
    if (atts.length) { pendingAttachments = [...pendingAttachments, ...atts].slice(0, 8); renderAttachStrip(); }
    inp.focus();
  }
}

function isOcTui(v) {
  return v?.engine === 'opencode' && String(v.agent || 'reverse').startsWith('reverse');
}

function ocBlocksToStd(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === 'oc_thought') out.push({ type: 'thinking', text: b.text });
    else if (b.type === 'oc_tool') {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || { command: b.command } });
      if (b.output || b.error) out.push({ type: 'tool_result', tool_use_id: b.id, text: b.output || b.error, is_error: !!b.error });
    } else if (b.type === 'text') out.push(b);
  }
  return out;
}

function renderPage(v, messages) {
  const page = document.createElement('div');
  if (isOcTui(v)) page.className = 'oc-stream';
  for (const m of messages) {
    if (isOcTui(v)) renderOcBlocks(page, m.role, m.blocks);
    else if (v.engine === 'opencode') renderBlocks(page, m.role, ocBlocksToStd(m.blocks), v.toolMap);
    else renderBlocks(page, m.role, m.blocks, v.toolMap);
  }
  return page;
}

function updatePager(v) {
  if (!v.pager) return;
  v.pager.hidden = !(v.firstIndex > 0);
  if (v.firstIndex > 0) v.pager.textContent = `加载更早的消息（还有 ${v.firstIndex} 条）`;
}

async function loadEarlier(v) {
  v.pager.disabled = true;
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(v.slug)}/${encodeURIComponent(v.id0)}?end=${v.firstIndex}`);
    const data = await res.json();
    if (data.error) { alert('加载失败: ' + data.error); return; }
    const page = renderPage(v, data.messages);
    const prevH = messagesRoot.scrollHeight;
    v.el.insertBefore(page, v.pager.nextSibling);
    v.firstIndex = data.start;
    updatePager(v);
    if (currentChatKey === v.key) messagesRoot.scrollTop += messagesRoot.scrollHeight - prevH;
  } finally { v.pager.disabled = false; }
}

async function openSession(slug, id) {
  const key = slug + '/' + id;
  if (chatViews.has(key)) { showChatView(key); markActiveSession(id); return; }
  const res = await fetch(`/api/session/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (data.error) { alert('读取会话失败: ' + data.error); return; }
  const proj = projectsCache.find(p => p.slug === slug);
  const engine = data.engine || proj?.engine || 'claude';
  const v = getOrCreateChatView(key, { slug, id, cwd: data.cwd, title: data.title || '(无标题)', engine, agent: data.agent });
  v.id0 = id;                 // original file id, used for history paging even after resume forks
  v.renamed = !!data.renamed;
  v.autoTitle = data.autoTitle || '';
  v.firstIndex = data.start;
  v.total = data.total;       // watermark for cross-device sync
  v.bytes = data.bytes;
  v.pager = document.createElement('button');
  v.pager.className = 'load-earlier';
  v.pager.addEventListener('click', () => loadEarlier(v));
  v.el.appendChild(v.pager);
  updatePager(v);
  v.el.appendChild(renderPage(v, data.messages));
  if (engine === 'opencode') {
    applyOcMeta(v, data);
    refreshOcMcp(v);
  }
  showChatView(key);
  markActiveSession(id);
  adoptLiveTurn(v);
}

// Another device (phone ↔ desktop) may have appended to this session's file.
// Pull just the new messages instead of re-rendering the whole conversation.
function lastUserBubbleText(el) {
  const nodes = el.querySelectorAll('.msg-user .bubble');
  return nodes.length ? (nodes[nodes.length - 1].textContent || '').trim() : '';
}

function armLocalTurn(v) {
  v.localTurn = true;
  clearTimeout(v.localTurnTimer);
  // if the session file is slow to land, still allow other-device sync later
  v.localTurnTimer = setTimeout(() => { v.localTurn = false; }, 8000);
}

function releaseLocalTurn(v) {
  v.localTurn = false;
  clearTimeout(v.localTurnTimer);
}

function refreshWatermark(v) {
  const id = v.id0 || v.id;
  if (!v.slug || !id) return;
  fetch(`/api/session/${encodeURIComponent(v.slug)}/${encodeURIComponent(id)}?limit=1`)
    .then(r => r.json()).then(d => { if (typeof d.total === 'number') v.total = d.total; })
    .catch(() => { /* not persisted yet */ })
    .finally(() => releaseLocalTurn(v));
}

async function syncSession(v) {
  if (!v.slug || !v.id0 || v.running || v.syncing || v.localTurn) return;
  v.syncing = true;
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(v.slug)}/${encodeURIComponent(v.id0)}?limit=60`);
    const data = await res.json();
    if (data.error || typeof data.total !== 'number') return;
    if (v.total == null) { v.total = data.total; return; }
    if (data.total <= v.total) return;

    if (v.engine === 'opencode' && v.ocDidStream) {
      v.total = data.total;
      v.ocDidStream = false;
      applyOcMeta(v, data);
      return;
    }

    const added = data.total - v.total;
    let fresh = data.messages.slice(Math.max(0, data.messages.length - added));
    // dispatch() already painted the local user bubble; a stale watermark
    // would replay it as a second 「你」. Drop a leading duplicate.
    const lastUser = lastUserBubbleText(v.el);
    const firstUser = (fresh[0]?.blocks || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (fresh[0]?.role === 'user' && lastUser && firstUser === lastUser) fresh = fresh.slice(1);
    if (!fresh.length) { v.total = data.total; return; }
    const atBottom = messagesRoot.scrollHeight - messagesRoot.scrollTop - messagesRoot.clientHeight < 80;
    v.el.appendChild(renderPage(v, fresh));
    v.total = data.total;
    if (data.title && data.title !== v.title) {
      // the server already resolved a custom name if one exists, so this cannot
      // clobber a rename — it only picks up a newly generated auto title
      v.title = data.title;
      v.renamed = !!data.renamed;
      if (data.autoTitle) v.autoTitle = data.autoTitle;
      if (currentChatKey === v.key) { $('#chat-title').textContent = data.title; $('#mobile-title').textContent = data.title; }
    }
    if (atBottom && currentChatKey === v.key) messagesRoot.scrollTop = messagesRoot.scrollHeight;
  } catch { /* offline; retried next tick */ }
  finally { v.syncing = false; }
}

// A turn started before this page loaded (other tab, or before a refresh/restart)
// is still running server-side — take over its stream instead of showing nothing.
async function adoptLiveTurn(v) {
  if (v.running || !v.id) return;
  let live;
  try { live = (await (await fetch('/api/chats')).json()).find(c => c.running && c.sessionId === v.id); }
  catch { return; }
  if (!live || v.running) return;
  // the prompt that started this turn was typed elsewhere and is only in the file;
  // pull it in first, then stream the rest live
  await syncSession(v);
  if (v.running) return;
  attachChat(v, live.ch, { fresh: true });
}

function newChat(cwd, engine = 'claude') {
  const key = 'new-' + (++chSeq);
  const titles = {
    cursor: '新 Cursor 会话', hermes: '新 Hermes 会话',
    opencode: '新 OpenCode 会话',
  };
  getOrCreateChatView(key, {
    slug: null, id: null, cwd: cwd || '', engine,
    title: titles[engine] || '新 Claude 会话',
    agent: engine === 'opencode' ? 'reverse' : undefined,
  });
  showChatView(key);
  markActiveSession(null);
  $('#input').focus();
}

function engineName(engine) {
  return engine === 'cursor' ? 'Cursor' : engine === 'hermes' ? 'Hermes' : engine === 'opencode' ? 'OpenCode' : 'Claude';
}
function engineBadge(engine) {
  return engine === 'cursor' ? 'CR' : engine === 'hermes' ? 'HM' : engine === 'opencode' ? 'OC' : 'CC';
}
function engineLabel(v) {
  if (v?.engine === 'opencode') return v.agent || 'reverse';
  return v?.engine === 'cursor' ? 'agent' : v?.engine === 'hermes' ? 'hermes' : 'claude';
}

function appendSpinner(v) {
  const s = document.createElement('div');
  s.className = 'spinner';
  s.textContent = `● ${engineLabel(v)} 运行中…`;
  v.el.appendChild(s);
  return s;
}

// ---------------- live streaming preview ----------------
// Complete messages only arrive when a block finishes; during a long think or a
// long answer the UI would otherwise sit still. Partial events drive a preview
// that gets discarded once the authoritative message lands.
function liveState(v) {
  if (!v.live) v.live = { el: null, kind: null, text: '', tokens: 0, tool: null, startedAt: Date.now() };
  return v.live;
}

function ensureLiveEl(v, spinner, kind) {
  const st = liveState(v);
  if (st.el && st.kind === kind) return st.el;
  const el = document.createElement('div');
  el.className = kind === 'thinking' ? 'live-think' : 'live-text';
  v.el.insertBefore(el, spinner);
  st.el = el; st.kind = kind; st.text = '';
  return el;
}

function clearLive(v) {
  const st = v.live;
  if (!st) return;
  if (st.el) st.el.remove();
  v.live = null;
}

function spinnerLabel(v, spinner) {
  const st = liveState(v);
  const secs = Math.round((Date.now() - st.startedAt) / 1000);
  const model = v.runningModel || engineLabel(v);
  const parts = [`● ${model}`];
  if (st.tool) parts.push(`正在用 ${st.tool}`);
  else parts.push('运行中');
  parts.push(`${secs}s`);
  if (st.tokens) parts.push(`${st.tokens.toLocaleString()} tok`);
  spinner.textContent = parts.join(' · ') + '…';
}

function handleStreamEvent(v, spinner, ev) {
  const st = liveState(v);
  const t = ev?.type;
  if (t === 'content_block_start') {
    const cb = ev.content_block || {};
    // the tool label must survive message_stop: execution happens *after* it,
    // and that wait is exactly when the user needs to know what is running
    if (cb.type === 'tool_use') { st.tool = cb.name; clearLiveBody(v); }
    else if (cb.type === 'text' || cb.type === 'thinking') st.tool = null;
  } else if (t === 'content_block_delta') {
    const d = ev.delta || {};
    if (d.type === 'text_delta' && d.text) {
      st.text += d.text;
      ensureLiveEl(v, spinner, 'text').textContent = st.text;
    } else if (d.type === 'thinking_delta' && d.thinking) {
      st.text += d.thinking;
      ensureLiveEl(v, spinner, 'thinking').textContent = st.text;
    }
  } else if (t === 'message_delta') {
    const u = ev.usage || {};
    if (u.output_tokens) st.tokens = u.output_tokens;
  }
  spinnerLabel(v, spinner);
}

// drop just the streamed body, keep counters (a tool call follows the text)
function clearLiveBody(v) {
  const st = v.live;
  if (!st) return;
  if (st.el) { st.el.remove(); st.el = null; }
  st.kind = null; st.text = '';
}

// ---------------- attachments ----------------
const MAX_EDGE = 1568;          // Claude downsizes above this anyway; save the tokens
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CURSOR_FILE_BYTES = 12 * 1024 * 1024;
const MAX_ATTS = 8;
let pendingAttachments = [];

function currentEngine() {
  return chatViews.get(currentChatKey)?.engine || 'claude';
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fileChip(f) {
  const a = document.createElement(f.url ? 'a' : 'span');
  a.className = 'file-chip';
  a.textContent = f.name || '文件';
  if (f.url) {
    a.href = f.url;
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return a;
}

function attachPreviewStrip(atts) {
  const strip = document.createElement('div');
  strip.className = 'msg-images';
  for (const a of atts) {
    if (a.kind === 'image' && a.url) {
      const img = document.createElement('img');
      img.src = a.url;
      strip.appendChild(img);
    } else {
      strip.appendChild(fileChip({ name: a.name, url: a.url }));
    }
  }
  return strip;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function shrink(dataUrl, mediaType) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const long = Math.max(img.width, img.height);
      if (long <= MAX_EDGE) { resolve({ dataUrl, mediaType }); return; }
      const scale = MAX_EDGE / long;
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const out = mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      resolve({ dataUrl: c.toDataURL(out, 0.9), mediaType: out });
    };
    img.onerror = () => resolve({ dataUrl, mediaType });
    img.src = dataUrl;
  });
}

async function addAttachment(file) {
  if (!file || looksLikeDir(file)) return;
  const engine = currentEngine();
  const isImage = (file.type || '').startsWith('image/')
    || /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(file.name || '');
  if (engine !== 'cursor' && !isImage) return;
  if (pendingAttachments.length >= MAX_ATTS) { alert(`单条消息最多 ${MAX_ATTS} 个附件`); return; }

  let dataUrl = await readAsDataURL(file);
  let mediaType = file.type || (isImage ? 'image/png' : 'application/octet-stream');
  if (engine !== 'cursor' && isImage) {
    ({ dataUrl, mediaType } = await shrink(dataUrl, mediaType));
  }
  const data = String(dataUrl).split(',')[1] || '';
  const bytes = data.length * 0.75;
  const cap = engine === 'cursor' ? MAX_CURSOR_FILE_BYTES : MAX_IMAGE_BYTES;
  if (bytes > cap) {
    alert(`${file.name || '附件'}过大（>${Math.round(cap / 1024 / 1024)}MB），已跳过`);
    return;
  }
  pendingAttachments.push({
    id: 'a' + Math.random().toString(36).slice(2, 8),
    name: file.name || (isImage ? 'image.png' : 'file'),
    mediaType, data, url: isImage ? dataUrl : null,
    kind: isImage ? 'image' : 'file', size: file.size,
  });
  renderAttachStrip();
}

function looksLikeDir(file) {
  return file.size === 0 && !file.type && !/\.\w+$/.test(file.name || '');
}

function renderAttachStrip() {
  const strip = $('#attach-strip');
  strip.innerHTML = '';
  strip.hidden = !pendingAttachments.length;
  for (const a of pendingAttachments) {
    const box = document.createElement('div');
    box.className = a.kind === 'image' ? 'attach-thumb' : 'attach-file';
    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.url;
      box.appendChild(img);
    } else {
      const name = document.createElement('span');
      name.className = 'attach-file-name';
      name.textContent = a.name;
      const meta = document.createElement('span');
      meta.className = 'attach-file-meta';
      meta.textContent = fmtSize(a.size || 0);
      box.append(name, meta);
    }
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter(p => p.id !== a.id);
      renderAttachStrip();
    });
    box.appendChild(x);
    strip.appendChild(box);
  }
}

function clipboardFiles(e) {
  const fromItems = [...(e.clipboardData?.items || [])]
    .filter(i => i.kind === 'file')
    .map(i => i.getAsFile())
    .filter(Boolean);
  if (fromItems.length) return fromItems;
  return [...(e.clipboardData?.files || [])];
}

$('#input').addEventListener('paste', async (e) => {
  const files = clipboardFiles(e);
  if (!files.length) return;
  const engine = currentEngine();
  const usable = engine === 'cursor' ? files : files.filter(f => (f.type || '').startsWith('image/'));
  if (!usable.length) return;
  e.preventDefault();
  for (const f of usable) await addAttachment(f);
});

const composerEl = $('#composer');
composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('drag-over'); });
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('drag-over'));
composerEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  composerEl.classList.remove('drag-over');
  for (const f of e.dataTransfer?.files || []) await addAttachment(f);
});
$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  for (const f of e.target.files) await addAttachment(f);
  e.target.value = '';
});

// "@model 正文" applies that model to this message only; the dropdown is untouched
function splitModelPrefix(text) {
  const m = text.match(/^@([\w.:-]+)(?:\s+|$)([\s\S]*)$/);
  if (!m) return { model: null, text };
  const token = m[1].toLowerCase();
  const choices = modelChoices();
  const hit = choices.find(c => c.name.toLowerCase() === token)
           || choices.find(c => c.alias && c.alias.toLowerCase() === token);   // "@deepseek-v4-pro"
  if (!hit && !/^claude-/i.test(m[1])) return { model: null, text };
  return { model: hit ? hit.name : m[1], text: m[2].trim() };
}

function sendMessage() {
  const v = chatViews.get(currentChatKey);
  if (!v) return;
  const raw = $('#input').value.trim();
  const atts = pendingAttachments;
  if (!raw && !atts.length) return;
  const { model, text } = splitModelPrefix(raw);
  if (model && !text && !atts.length) return;   // "@opus" alone is not a message
  $('#input').value = '';
  pendingAttachments = [];
  renderAttachStrip();
  if (v.running) { enqueue(v, text, atts, model); return; }
  dispatch(v, text, atts, model);
}

function dispatch(v, text, atts = [], oneShotModel = null) {
  const blocks = atts.map(a => a.kind === 'file'
    ? { type: 'file', name: a.name }
    : { type: 'image', url: a.url, mediaType: a.mediaType, data: a.data });
  if (text) blocks.push({ type: 'text', text });
  if (isOcTui(v)) renderOcBlocks(v.el, 'user', blocks);
  else renderBlocks(v.el, 'user', blocks, v.toolMap);
  armLocalTurn(v);
  if (oneShotModel) {
    const tag = document.createElement('div');
    tag.className = 'model-tag';
    tag.textContent = `本轮使用 ${oneShotModel}`;
    v.el.appendChild(tag);
  }
  if (v.engine !== 'cursor' && v.engine !== 'opencode') warnIfContextTooBig(v, oneShotModel || $('#model-sel').value);
  const ch = 'c' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const payloadAtts = v.engine === 'cursor'
    ? atts.map(a => ({ name: a.name, mediaType: a.mediaType, data: a.data }))
    : atts.filter(a => a.kind === 'image').map(a => ({ mediaType: a.mediaType, data: a.data }));
  attachChat(v, ch, {
    start: { cwd: v.cwd || undefined, resume: v.id || undefined, engine: v.engine || 'claude',
             prompt: text || '',
             attachments: payloadAtts,
             permissionMode: $('#perm-mode').value,
             agent: v.engine === 'opencode' ? (v.agent || 'reverse') : undefined,
             ...resolveModelChoice(oneShotModel || $('#model-sel').value, v.engine) },
  });
}

function attachChat(v, ch, { start, fresh } = {}) {
  const spinner = appendSpinner(v);
  spinner.textContent = fresh ? '● 接管后台运行中的轮次…' : `● ${engineLabel(v)} 运行中…`;
  v.spinner = spinner;
  if (currentChatKey === v.key) messagesRoot.scrollTop = messagesRoot.scrollHeight;

  v.running = true; v.ch = ch; v.evCount = 0;
  v.live = null;
  liveState(v).startedAt = Date.now();
  // keep the elapsed counter moving even while the model is silent;
  // once a minute, verify against the server — a missed done message must not
  // leave a spinner running for hours (踩过 16056s 的僵尸)
  let lastVerify = Date.now();
  v.tick = setInterval(async () => {
    if (!v.running) { clearInterval(v.tick); return; }
    spinnerLabel(v, spinner);
    if (Date.now() - lastVerify < 60000) return;
    lastVerify = Date.now();
    try {
      const chats = await (await fetch('/api/chats')).json();
      const mine = chats.find(c => c.ch === v.ch);
      if (v.running && (!mine || !mine.running)) {
        // server says it's over — reconcile from the session file and unlock
        failRunningChat(v, '该轮已在服务端结束（界面错过了结束消息），正在拉取结果…');
        v.seenMtime = 0;
        syncSession(v);
      }
    } catch { /* server briefly down; next minute retries */ }
  }, 1000);
  if (currentChatKey === v.key) updateComposer(v);
  applyActiveDots();

  wsHandlers.set(ch, (m) => {
    const atBottom = messagesRoot.scrollHeight - messagesRoot.scrollTop - messagesRoot.clientHeight < 60;
    if (m.op === 'chat.event') {
      v.evCount++;
      const e = m.event;
      if (e.type === 'system' && e.subtype === 'init') {
        v.runningModel = e.model || engineLabel(v);
        liveState(v).startedAt = Date.now();
        spinnerLabel(v, spinner);
      } else if (e.type === 'oc.part' && e.part) {
        v.ocDidStream = true;
        liveState(v).tool = e.part.type === 'tool' ? (e.part.tool || 'tool') : null;
        ocPartEl(v, e.part, spinner);
        spinnerLabel(v, spinner);
      } else if (e.type === 'oc.delta') {
        v.ocDidStream = true;
        const part = (v.ocParts && v.ocParts.get(e.partID)) || { id: e.partID, type: 'text', text: '' };
        if (e.field === 'text' || !e.field) part.text = (part.text || '') + (e.delta || '');
        ocPartEl(v, part, spinner);
      } else if (e.type === 'oc.session') {
        applyOcSessionInfo(v, e.info);
        if (e.info?.id) v.id = e.info.id;
      } else if (e.type === 'oc.todo') {
        if (!v.ocMeta) v.ocMeta = {};
        v.ocMeta.todos = e.todos || [];
        renderOcChrome(v);
      } else if (e.type === 'oc.mcp') {
        if (!v.ocMeta) v.ocMeta = {};
        v.ocMeta.mcp = e.mcp || {};
        renderOcChrome(v);
      } else if (e.type === 'thinking' && e.subtype === 'delta' && e.text) {
        handleStreamEvent(v, spinner, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: e.text } });
      } else if (e.type === 'stream_event') {
        handleStreamEvent(v, spinner, e.event);
      } else if (e.type === 'user') {
        liveState(v).tool = null;
        const blocks = normalizeStreamContent(e.message?.content);
        const hasToolBits = blocks.some(b => b.type === 'tool_result' || b.type === 'tool_use');
        // Cursor echoes the full prompt (including <image_files> index). dispatch()
        // already drew the user bubble; skip the dump unless this is a tool result.
        if (hasToolBits) {
          clearLiveBody(v);
          v.el.insertBefore(blockGroup(v, 'user', blocks), spinner);
        }
      } else if (e.type === 'assistant') {
        if (isOcTui(v)) { /* live parts already painted */ }
        else {
          clearLiveBody(v);
          const blocks = normalizeStreamContent(e.message?.content);
          v.el.insertBefore(blockGroup(v, 'assistant', blocks), spinner);
        }
      } else if (e.type === 'result') {
        if (e.session_id) {
          v.id = e.session_id;
          if (currentChatKey === v.key) {
            const eng = engineName(v.engine);
            $('#chat-sub').textContent = `${eng}${v.cwd ? '  ·  ' + v.cwd : ''}  ·  ${v.id}`;
          }
        }
        if (isOcTui(v)) {
          if (v.ocDidStream) {
            v.el.insertBefore(ocFooterEl({
              agent: v.agent || 'reverse',
              model: (v.ocMeta && v.ocMeta.model) || v.runningModel,
              provider: v.ocMeta && v.ocMeta.provider,
              durationMs: e.duration_ms,
            }), spinner);
          }
          if (e.is_error && e.result) {
            const err = document.createElement('div');
            err.className = 'error-line';
            err.textContent = explainError(e.result);
            v.el.insertBefore(err, spinner);
          }
        } else {
          const line = document.createElement('div');
          line.className = 'result-line';
          const cost = e.total_cost_usd != null ? ` · $${e.total_cost_usd.toFixed(4)}` : '';
          const dur = e.duration_ms != null ? ` · ${(e.duration_ms / 1000).toFixed(1)}s` : '';
          const u = e.usage || {};
          const tok = u.output_tokens != null
            ? ` · 出${u.output_tokens.toLocaleString()}/入${(u.input_tokens || 0).toLocaleString()} tok` : '';
          line.textContent = (e.subtype === 'success' ? '完成' : '结束: ' + e.subtype) + dur + tok + cost;
          v.el.insertBefore(line, spinner);
          if (e.is_error && e.result) {
            const err = document.createElement('div');
            err.className = 'error-line';
            err.textContent = explainError(e.result);
            v.el.insertBefore(err, spinner);
          }
        }
      }
    } else if (m.op === 'chat.error') {
      v.evCount++;
      const err = document.createElement('div');
      err.className = 'error-line';
      err.textContent = '错误: ' + m.error;
      v.el.insertBefore(err, spinner);
    } else if (m.op === 'chat.retry') {
      clearLiveBody(v);
      const line = document.createElement('div');
      line.className = 'retry-line';
      line.textContent = `⟳ 连接中断，${Math.round(m.waitMs / 1000)} 秒后自动继续（第 ${m.attempt}/${m.max} 次）`;
      v.el.insertBefore(line, spinner);
      spinner.textContent = `● 等待重连…`;
    } else if (m.op === 'chat.retried') {
      // the continuation runs on a new channel — follow it
      wsHandlers.delete(ch);
      clearInterval(v.tick);
      spinner.remove();
      v.spinner = null;
      v.running = false; v.ch = null;
      attachChat(v, m.next, {});
    } else if (m.op === 'chat.gone') {
      failRunningChat(v, '本轮在服务端已不存在（服务重启过），请重发');
    } else if (m.op === 'chat.done') {
      clearInterval(v.tick);
      clearLive(v);
      spinner.remove();
      v.spinner = null;
      const stopped = v.stopRequested;
      v.stopRequested = false;
      if (stopped) {
        const line = document.createElement('div');
        line.className = 'result-line';
        line.textContent = '已停止';
        v.el.appendChild(line);
      } else if (m.code !== 0 && m.stderr) {
        const err = document.createElement('div');
        err.className = 'error-line';
        err.textContent = `${engineLabel(v)} 退出码 ${m.code}\n` + explainError(m.stderr.slice(-2000));
        v.el.appendChild(err);
      }
      v.running = false; v.ch = null;
      wsHandlers.delete(ch);
      if (currentChatKey === v.key) updateComposer(v);
      loadProjects();
      // hold cross-device sync until the watermark catches up, otherwise the
      // bubble dispatch() already drew is replayed from the session file
      if (v.slug && (v.id0 || v.id)) refreshWatermark(v);
      else releaseLocalTurn(v);
      if (stopped) restoreQueueToInput(v);
      else flushQueue(v);
    }
    if (atBottom && currentChatKey === v.key) messagesRoot.scrollTop = messagesRoot.scrollHeight;
    else if (currentChatKey === v.key) updateJumpBtn();
  });

  if (start) wsSend({ op: 'chat.start', ch, ...start });
  else wsSend({ op: 'chat.attach', ch, fresh: !!fresh, from: 0 });
}

function blockGroup(v, role, blocks) {
  const frag = document.createElement('div');
  renderBlocks(frag, role === 'user' ? 'tool-carrier' : role, blocks, v.toolMap);
  return frag;
}

$('#btn-send').addEventListener('click', sendMessage);
$('#btn-stop').addEventListener('click', () => {
  const v = chatViews.get(currentChatKey);
  if (v?.running && v.ch && !v.stopRequested) {
    v.stopRequested = true;
    if (v.spinner) v.spinner.textContent = '● 停止中…';
    wsSend({ op: 'chat.stop', ch: v.ch });
  }
});
// ---------------- slash command menu ----------------
const cmdCache = new Map(); // cwd -> command list
const menuEl = document.createElement('div');
menuEl.id = 'slash-menu';
menuEl.hidden = true;
$('#composer').appendChild(menuEl);
let menuItems = [], menuIdx = 0, menuOpen = false;

async function getCommands(cwd) {
  const k = cwd || '';
  if (!cmdCache.has(k)) {
    try { cmdCache.set(k, await (await fetch('/api/commands?cwd=' + encodeURIComponent(k))).json()); }
    catch { cmdCache.set(k, []); }
  }
  return cmdCache.get(k);
}

// models offered for a one-off switch: dropdown entries plus the CLI aliases
const MODEL_ALIASES = [
  { name: 'opus', desc: '别名 · 最强，贵' },
  { name: 'sonnet', desc: '别名 · 均衡' },
  { name: 'haiku', desc: '别名 · 最快最省' },
  { name: 'fable', desc: '别名' },
];

function modelChoices() {
  const eng = chatViews.get(currentChatKey)?.engine || 'claude';
  const fromSel = [...$('#model-sel').querySelectorAll('option')]
    .filter(o => o.value && o.value !== '__custom__' && !o.hidden)
    .map(o => ({ name: o.value, desc: o.textContent }));
  const skipExtras = eng === 'cursor' || eng === 'hermes' || eng === 'opencode';
  const provAliases = skipExtras ? [] : providers.map(p => ({ name: 'provider:' + p.id, desc: p.label, alias: p.id }));
  const aliases = skipExtras ? [] : MODEL_ALIASES;
  const seen = new Set(fromSel.map(m => m.name));
  return [...fromSel, ...provAliases.filter(p => !seen.has(p.name)), ...aliases.filter(m => !seen.has(m.name))];
}

let menuMode = 'slash';

async function updateSlashMenu() {
  const val = $('#input').value;

  // "@xxx" at the start switches the model for this one message only
  const at = val.match(/^@([\w.:-]*)$/);
  if (at) {
    menuMode = 'model';
    menuItems = modelChoices().filter(m => m.name.toLowerCase().includes(at[1].toLowerCase())).slice(0, 12);
    if (!menuItems.length) { closeSlashMenu(); return; }
    menuIdx = 0; menuOpen = true;
    renderSlashMenu();
    return;
  }

  const m = val.match(/^\/([\w:-]*)$/);
  if (!m) { closeSlashMenu(); return; }
  menuMode = 'slash';
  const all = await getCommands(chatViews.get(currentChatKey)?.cwd || '');
  menuItems = all.filter(c => c.name.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 12);
  if (!menuItems.length) { closeSlashMenu(); return; }
  menuIdx = 0; menuOpen = true;
  renderSlashMenu();
}

function renderSlashMenu() {
  menuEl.hidden = false;
  menuEl.innerHTML = '';
  menuItems.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'slash-item' + (i === menuIdx ? ' active' : '');
    const n = document.createElement('span');
    n.className = 'slash-name';
    n.textContent = (menuMode === 'model' ? '@' : '/') + c.name;
    const d = document.createElement('span');
    d.className = 'slash-desc';
    d.textContent = menuMode === 'model' ? c.desc : (c.source ? `[${c.source}] ` : '') + c.desc;
    row.append(n, d);
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pickSlash(i); });
    menuEl.appendChild(row);
  });
  menuEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function closeSlashMenu() { menuOpen = false; menuEl.hidden = true; }

function pickSlash(i) {
  $('#input').value = (menuMode === 'model' ? '@' : '/') + menuItems[i].name + ' ';
  closeSlashMenu();
  $('#input').focus();
}

$('#input').addEventListener('input', updateSlashMenu);
$('#input').addEventListener('blur', () => setTimeout(closeSlashMenu, 150));
$('#input').addEventListener('keydown', (e) => {
  if (menuOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); menuIdx = (menuIdx + 1) % menuItems.length; renderSlashMenu(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); menuIdx = (menuIdx - 1 + menuItems.length) % menuItems.length; renderSlashMenu(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(menuIdx); return; }
    if (e.key === 'Escape') { closeSlashMenu(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
$('#perm-mode').addEventListener('change', () => localStorage.setItem('permMode', $('#perm-mode').value));
if (localStorage.getItem('permMode')) $('#perm-mode').value = localStorage.getItem('permMode');
function modelStorageKey(engine) {
  return 'model:' + (engine === 'cursor' ? 'cursor' : engine === 'hermes' ? 'hermes' : engine === 'opencode' ? 'opencode' : 'claude');
}

function syncModelSelector(engine) {
  const eng = engine === 'cursor' ? 'cursor' : engine === 'hermes' ? 'hermes' : engine === 'opencode' ? 'opencode' : 'claude';
  const sel = $('#model-sel');
  for (const el of sel.querySelectorAll('.model-claude, .model-cursor, .model-hermes, .model-opencode')) {
    el.hidden = !el.classList.contains('model-' + eng);
  }
  for (const opt of sel.querySelectorAll('option[data-engine]')) {
    opt.hidden = opt.dataset.engine !== eng;
  }
  let saved = localStorage.getItem(modelStorageKey(eng));
  if (!saved && eng === 'claude') saved = localStorage.getItem('model'); // migrate legacy key
  const pick = (v) => v && [...sel.options].some(o => o.value === v && !o.hidden);
  if (pick(saved)) sel.value = saved;
  else if (eng === 'opencode' && pick('deepseek/deepseek-v4-pro')) sel.value = 'deepseek/deepseek-v4-pro';
  else if (!pick(sel.value) || sel.value.startsWith('provider:')) sel.value = '';
}

// Keeps an ad-hoc model id selectable without a code change
function addModelOption(id, label, engine) {
  const eng = engine || chatViews.get(currentChatKey)?.engine || 'claude';
  const sel = $('#model-sel');
  if ([...sel.options].some(o => o.value === id)) return;
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = label || id;
  opt.dataset.engine = eng === 'cursor' ? 'cursor' : eng === 'hermes' ? 'hermes' : eng === 'opencode' ? 'opencode' : 'claude';
  sel.insertBefore(opt, sel.querySelector('option[value="__custom__"]'));
}

// third-party gateways (MiMo / DeepSeek / …) appear as "provider:<id>" entries — Claude only
let providers = [];

async function loadProviders() {
  try { providers = await (await fetch('/api/providers')).json(); }
  catch { return; }
  const sel = $('#model-sel');
  const group = document.createElement('optgroup');
  group.id = 'og-providers';
  group.className = 'model-claude';
  group.label = '其他模型（第三方网关）';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = 'provider:' + p.id;
    opt.textContent = p.label
      + (p.maxRequestBytes ? `（单请求≤${(p.maxRequestBytes / 1048576).toFixed(0)}MB）` : '')
      + (p.hasKey ? '' : ' ⚠ 未配 key');
    group.appendChild(opt);
  }
  if (providers.length) sel.insertBefore(group, sel.querySelector('option[value="__custom__"]'));
  syncModelSelector(chatViews.get(currentChatKey)?.engine || 'claude');
}
loadProviders();

// split dropdown value into what chat.start needs; providers never apply to Cursor
function resolveModelChoice(value, engine) {
  if (!value) return {};
  if (engine === 'cursor' || engine === 'hermes' || engine === 'opencode') {
    if (value.startsWith('provider:')) return {};
    return { model: value };
  }
  if (value.startsWith('provider:')) return { provider: value.slice(9) };
  return { model: value };
}

// Claude Code resends the whole conversation each turn, so a gateway with a body
// cap (MiMo: 1MB) fails once the session file grows past it. Warn before it does.
function warnIfContextTooBig(v, choice) {
  if (!choice || !choice.startsWith('provider:') || !v.bytes) return;
  const p = providers.find(x => x.id === choice.slice(9));
  if (!p?.maxRequestBytes || v.bytes < p.maxRequestBytes * 0.75) return;
  const line = document.createElement('div');
  line.className = 'error-line';
  line.textContent = `⚠ 当前会话约 ${(v.bytes / 1048576).toFixed(1)}MB，${p.label} 单次请求上限 `
    + `${(p.maxRequestBytes / 1048576).toFixed(0)}MB，本轮很可能被网关拒绝。`
    + `建议先 /compact 压缩上下文、新开会话，或改用 DeepSeek（无此限制）。`;
  v.el.appendChild(line);
}

$('#model-sel').addEventListener('change', () => {
  const sel = $('#model-sel');
  const eng = chatViews.get(currentChatKey)?.engine || 'claude';
  const key = modelStorageKey(eng);
  if (sel.value === '__custom__') {
    const hint = eng === 'cursor'
      ? 'Cursor 模型 ID（如 composer-2.5 / claude-opus-5-thinking-high）:'
      : '模型 ID 或别名（如 claude-opus-5 / opus / fable）:';
    const id = (prompt(hint, '') || '').trim();
    if (!id) { sel.value = localStorage.getItem(key) || localStorage.getItem('model') || ''; return; }
    addModelOption(id, null, eng);
    sel.value = id;
  }
  localStorage.setItem(key, sel.value);
});

const savedClaude = localStorage.getItem('model:claude') || localStorage.getItem('model');
if (savedClaude) { addModelOption(savedClaude, null, 'claude'); }
const savedCursor = localStorage.getItem('model:cursor');
if (savedCursor) { addModelOption(savedCursor, null, 'cursor'); }

// ---------------- jump to bottom ----------------
const jumpBtn = document.createElement('button');
jumpBtn.id = 'jump-bottom';
jumpBtn.textContent = '↓ 最新';
jumpBtn.hidden = true;
jumpBtn.addEventListener('click', () => {
  messagesRoot.scrollTop = messagesRoot.scrollHeight;
  jumpBtn.hidden = true;
});
$('#chat-view').appendChild(jumpBtn);

function updateJumpBtn() {
  const gap = messagesRoot.scrollHeight - messagesRoot.scrollTop - messagesRoot.clientHeight;
  const running = [...chatViews.values()].some(v => v.key === currentChatKey && v.running);
  jumpBtn.hidden = !(gap > 220 && running);
}
messagesRoot.addEventListener('scroll', updateJumpBtn);

// ---------------- sidebar: sessions ----------------
let projectsCache = [];
let activeState = { working: new Set(), idle: new Set() };
let contentHits = new Map();
let searchGen = 0;
let searchTimer = 0;
let searchPending = false;

async function loadProjects() {
  const res = await fetch('/api/projects');
  projectsCache = await res.json();
  renderSessionList();
}

// ---------------- pins ----------------
let pins = [];

async function loadPins() {
  try { pins = await (await fetch('/api/pins')).json(); }
  catch { pins = []; }
}

function savePins() {
  fetch('/api/pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pins) })
    .catch(() => { /* retried on next toggle */ });
}

// ---------------- rename ----------------
async function renameSession(s) {
  const current = s.renamed ? s.title : '';
  const auto = s.renamed ? (s.autoTitle || '') : s.title;
  const input = prompt(`会话新名字（留空恢复自动标题）\n自动标题：${auto}`, current || s.title || '');
  if (input === null) return;
  const name = input.trim() === (s.title || '').trim() && !s.renamed ? '' : input.trim();
  try {
    const res = await fetch('/api/names/' + encodeURIComponent(s.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) { alert('重命名失败：' + data.error); return; }
    applyRename(s.id, data.name);
  } catch (e) { alert('重命名失败：' + e); }
}

// patch caches in place so the new name shows without a full reload
function applyRename(id, name) {
  for (const p of projectsCache) {
    for (const sess of p.sessions) {
      if (sess.id !== id) continue;
      if (name) {
        if (!sess.renamed) sess.autoTitle = sess.title;
        sess.title = name; sess.renamed = true;
      } else {
        sess.title = sess.autoTitle || sess.title;
        sess.renamed = false; delete sess.autoTitle;
      }
    }
  }
  for (const [, v] of chatViews) {
    if (v.id !== id && v.id0 !== id) continue;
    if (name) { if (!v.renamed) v.autoTitle = v.title; v.title = name; v.renamed = true; }
    else { v.title = v.autoTitle || v.title; v.renamed = false; }
    if (currentChatKey === v.key) {
      $('#chat-title').textContent = v.title;
      $('#mobile-title').textContent = v.title;
    }
  }
  renderSessionList();
}

// double-click the header title (or the mobile top bar) to rename the open session
function renameCurrentSession() {
  const v = chatViews.get(currentChatKey);
  if (!v?.id) { alert('这个会话还没有 id（首轮跑完才会有），暂时不能改名'); return; }
  renameSession({ id: v.id0 || v.id, title: v.title, renamed: !!v.renamed, autoTitle: v.autoTitle });
}
$('#chat-title').addEventListener('dblclick', renameCurrentSession);
$('#mobile-title').addEventListener('dblclick', renameCurrentSession);

function togglePin(id) {
  const i = pins.indexOf(id);
  if (i >= 0) pins.splice(i, 1); else pins.unshift(id);
  savePins();
  renderSessionList();
}

const PENCIL_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">'
  + '<path d="M11.6 1.8l2.6 2.6-1.5 1.5-2.6-2.6 1.5-1.5zM9.2 4.2l2.6 2.6-6.3 6.3-3.3.7.7-3.3 6.3-6.3z" '
  + 'fill="currentColor"/></svg>';

const PIN_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">'
  + '<path d="M6.2 1.5h3.6l-.5 1.1v3l2.6 2.4v1.1H8.7L8 14.5l-.7-5.4H4.1V8l2.6-2.4v-3z" '
  + 'fill="currentColor"/></svg>';

// per-session color + icon comes from /api/graph (same identity as the map view)
let graphMeta = new Map();

window.applyGraphMeta = (nodes) => {
  let changed = nodes.length !== graphMeta.size;
  const m = new Map();
  for (const n of nodes) {
    m.set(n.id, { color: n.color, icon: n.icon });
    const old = graphMeta.get(n.id);
    if (!old || old.color !== n.color || old.icon !== n.icon) changed = true;
  }
  graphMeta = m;
  if (changed) renderSessionList();
};

async function loadGraphMeta() {
  try {
    const d = await (await fetch('/api/graph')).json();
    if (d.nodes) window.applyGraphMeta(d.nodes);
  } catch { /* sidebar just stays neutral until the next refresh */ }
}

function makeSessionItem(p, s) {
  const item = document.createElement('div');
  item.className = 'sess-item';
  item.dataset.sessId = s.id;
  if (pins.includes(s.id)) item.classList.add('pinned');

  const gm = graphMeta.get(s.id);
  if (gm) item.style.setProperty('--sess-color', gm.color);
  const chip = document.createElement('span');
  chip.className = 'sess-chip';
  if (window.CockpitIcons) chip.innerHTML = CockpitIcons.html(gm?.icon, 18, gm?.color);

  const t = document.createElement('div');
  t.className = 'sess-title';
  const dot = document.createElement('span');
  dot.className = 'live-dot';
  const badge = document.createElement('span');
  const eng = s.engine || p.engine || 'claude';
  badge.className = 'engine-badge ' + eng;
  badge.textContent = engineBadge(eng);
  t.appendChild(dot);
  t.appendChild(badge);
  t.appendChild(document.createTextNode(s.title));
  t.title = s.title;

  const meta = document.createElement('div');
  meta.className = 'sess-meta';
  meta.textContent = `${new Date(s.mtimeMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${s.msgCount == null ? '长会话' : s.msgCount + ' 条'}`;

  const hit = contentHits.get(s.id);
  let snip = null;
  if (hit?.snippet) {
    snip = document.createElement('div');
    snip.className = 'sess-snip';
    snip.textContent = hit.snippet;
    snip.title = hit.snippet;
  }

  const pin = document.createElement('button');
  pin.className = 'pin-btn';
  pin.innerHTML = PIN_SVG;
  pin.title = pins.includes(s.id) ? '取消置顶' : '置顶';
  pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(s.id); });

  const ren = document.createElement('button');
  ren.className = 'pin-btn ren-btn';
  ren.innerHTML = PENCIL_SVG;
  ren.title = s.renamed ? `重命名（自动标题：${s.autoTitle || ''}）` : '重命名';
  if (s.renamed) item.classList.add('renamed');
  ren.addEventListener('click', (e) => { e.stopPropagation(); renameSession(s); });

  const body = document.createElement('div');
  body.className = 'sess-body';
  body.append(t, meta);
  if (snip) body.append(snip);
  item.append(chip, body, ren, pin);
  item.addEventListener('click', () => openSession(p.slug, s.id));
  return item;
}

function scheduleContentSearch() {
  const q = $('#filter').value.trim();
  clearTimeout(searchTimer);
  if (!q) {
    searchGen++;
    searchPending = false;
    if (contentHits.size) {
      contentHits = new Map();
      renderSessionList();
    }
    return;
  }
  const ql = q.toLowerCase();
  for (const [id, h] of [...contentHits]) {
    if (!(h.snippet || '').toLowerCase().includes(ql)) contentHits.delete(id);
  }
  const gen = ++searchGen;
  searchPending = true;
  searchTimer = setTimeout(async () => {
    try {
      const data = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
      if (gen !== searchGen) return;
      const next = new Map();
      for (const h of data.hits || []) {
        if (h?.id) next.set(h.id, h);
      }
      contentHits = next;
    } catch {
      if (gen !== searchGen) return;
    } finally {
      if (gen === searchGen) searchPending = false;
      if (gen === searchGen) renderSessionList();
    }
  }, 280);
}

function renderSessionList() {
  const raw = $('#filter').value.trim();
  const q = raw.toLowerCase();
  const root = $('#session-list');
  root.innerHTML = '';
  const match = (s) => {
    if (!q) return true;
    return (s.title || '').toLowerCase().includes(q)
      || (s.id || '').toLowerCase().includes(q)
      || (s.cwd || '').toLowerCase().includes(q)
      || contentHits.has(s.id);
  };

  // pinned first, in pin order; a pinned session is not repeated in its project group
  const pinned = [];
  for (const id of pins) {
    for (const p of projectsCache) {
      const s = p.sessions.find(x => x.id === id);
      if (s) { if (match(s)) pinned.push([p, s]); break; }
    }
  }
  if (pinned.length) {
    const g = document.createElement('div');
    g.className = 'proj-group pinned-group';
    const name = document.createElement('div');
    name.className = 'proj-name';
    name.textContent = '置顶';
    g.appendChild(name);
    for (const [p, s] of pinned) g.appendChild(makeSessionItem(p, s));
    root.appendChild(g);
  }

  const pinSet = new Set(pins);
  for (const p of projectsCache) {
    const sessions = p.sessions.filter(s => match(s) && !pinSet.has(s.id));
    if (!sessions.length) continue;
    const g = document.createElement('div');
    g.className = 'proj-group';
    const name = document.createElement('div');
    name.className = 'proj-name';
    const prefix = p.engine === 'cursor' ? 'Cursor · ' : p.engine === 'hermes' ? '' : p.engine === 'opencode' ? '' : '';
    name.textContent = prefix + (p.cwd || p.slug);
    name.title = p.cwd || p.slug;
    g.appendChild(name);
    for (const s of sessions) g.appendChild(makeSessionItem(p, s));
    root.appendChild(g);
  }
  if (!root.children.length && q) {
    const empty = document.createElement('div');
    empty.className = 'side-empty';
    empty.textContent = searchPending ? `正在检索「${raw}」…` : `没有匹配「${raw}」`;
    root.appendChild(empty);
  }
  applyActiveDots();
}

function markActiveSession(id) {
  document.querySelectorAll('.sess-item').forEach(el =>
    el.classList.toggle('active', !!id && el.dataset.sessId === id));
  document.querySelectorAll('.term-item').forEach(el => el.classList.remove('active'));
}

$('#filter').addEventListener('input', () => {
  renderSessionList();
  scheduleContentSearch();
});
$('#btn-refresh').addEventListener('click', () => { loadProjects(); loadGraphMeta(); });
loadPins().then(loadProjects).then(() => {
  loadGraphMeta();
  // deep link from a push notification: /?session=<slug>/<id>
  const q = new URLSearchParams(location.search).get('session');
  if (q && q.includes('/')) {
    const i = q.lastIndexOf('/');
    openSession(q.slice(0, i), q.slice(i + 1));
    history.replaceState(null, '', location.pathname);
  } else if (isMobile()) {
    showRunning();
  }
});

// ---------------- PWA + push ----------------
async function initPWA() {
  if (!('serviceWorker' in navigator)) return;
  let reg;
  try { reg = await navigator.serviceWorker.register('/sw.js'); }
  catch { return; }
  // a plain WebView (the APK shell) has no Notification/Push API — it watches natively instead
  if (typeof Notification === 'undefined' || !('PushManager' in window)) {
    $('#btn-push').hidden = true;
    return;
  }
  if (Notification.permission === 'granted') subscribePush(reg);
  window.__enablePush = async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('通知权限被拒绝'); return; }
    await subscribePush(reg);
    await fetch('/api/push/test', { method: 'POST' });
  };
}

async function subscribePush(reg) {
  try {
    const { key } = await (await fetch('/api/push/key')).json();
    const existing = await reg.pushManager.getSubscription();
    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub),
    });
  } catch { /* push unsupported or blocked */ }
}
initPWA();

// ---------------- live activity dots ----------------
function applyActiveDots() {
  // cockpit's own in-flight turns count as working even before the file lands
  const working = new Set(activeState.working);
  for (const [, v] of chatViews) if (v.running && v.id) working.add(v.id);
  document.querySelectorAll('.sess-item').forEach(el => {
    const id = el.dataset.sessId;
    el.classList.toggle('live-working', working.has(id));
    el.classList.toggle('live-idle', !working.has(id) && activeState.idle.has(id));
  });
}

let lastChanged = {};

async function pollActive() {
  try {
    const a = await (await fetch('/api/active')).json();
    activeState = { working: new Set(a.working || []), idle: new Set(a.idle || []) };
    const changed = a.changed || {};

    // a session that is live but absent from the sidebar means it was just created
    const known = new Set(projectsCache.flatMap(p => p.sessions.map(s => s.id)));
    const unknown = [...activeState.working, ...activeState.idle, ...Object.keys(changed)]
      .some(id => !known.has(id));
    const bumped = Object.keys(changed).some(id => changed[id] !== lastChanged[id]);
    if (unknown || bumped) await loadProjects();   // keeps titles/时间/条数 current
    lastChanged = changed;

    // pull in whatever another device wrote, and adopt turns it started
    for (const [, v] of chatViews) {
      if (!v.id) continue;
      if (!v.slug) {
        // a brand-new chat only learns its slug once the file lands in the sidebar
        for (const p of projectsCache) {
          if (p.sessions.some(s => s.id === v.id)) {
            v.slug = p.slug;
            v.id0 = v.id;
            v.engine = p.engine || v.engine || 'claude';
            if (v.localTurn) refreshWatermark(v);
            break;
          }
        }
      }
      if (!v.running && activeState.working.has(v.id)) { adoptLiveTurn(v); continue; }
      if (!v.running && changed[v.id] && changed[v.id] !== v.seenMtime) {
        v.seenMtime = changed[v.id];
        syncSession(v);
      }
    }
    applyActiveDots();
  } catch { /* server restarting; next tick retries */ }
}
pollActive();
setInterval(pollActive, 4000);

// ---------------- terminals ----------------
const terms = new Map(); // ch -> {term, fit, el, item, title, dead}
let activeTermCh = null;

function switchView(which) {
  $('#welcome').hidden = which !== 'welcome';
  $('#chat-view').hidden = which !== 'chat';
  $('#term-view').hidden = which !== 'term';
  $('#running-view').hidden = which !== 'running';
  $('#graph-view').hidden = which !== 'graph';
  closeDrawer();
}

// ---------------- mobile drawer ----------------
const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
function openDrawer() { $('#app').classList.add('drawer-open'); }
function closeDrawer() { $('#app').classList.remove('drawer-open'); }
$('#btn-drawer').addEventListener('click', () => {
  $('#app').classList.toggle('drawer-open');
});
$('#drawer-backdrop').addEventListener('click', closeDrawer);

// ---------------- running view ----------------
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

async function renderRunning() {
  const root = $('#running-list');
  let chats = [], active = { working: [], idle: [] };
  try {
    [chats, active] = await Promise.all([
      fetch('/api/chats').then(r => r.json()),
      fetch('/api/active').then(r => r.json()),
    ]);
  } catch { /* offline */ }

  const titleOf = (id) => {
    for (const p of projectsCache) {
      const s = p.sessions.find(x => x.id === id);
      if (s) return { title: s.title, slug: p.slug, cwd: p.cwd };
    }
    return null;
  };

  const rows = [];
  for (const c of chats.filter(c => c.running)) {
    const meta = c.sessionId ? titleOf(c.sessionId) : null;
    rows.push({ kind: 'cockpit', id: c.sessionId, slug: meta?.slug, ch: c.ch,
                title: meta?.title || '新会话', cwd: c.cwd, since: c.startedAt, model: c.model,
                engine: c.engine, activity: c.activity });
  }
  const own = new Set(rows.map(r => r.id));
  for (const id of active.working || []) {
    if (own.has(id)) continue;
    const meta = titleOf(id);
    rows.push({ kind: 'external', id, slug: meta?.slug, title: meta?.title || id.slice(0, 8), cwd: meta?.cwd });
  }

  root.innerHTML = '';
  if (!rows.length) {
    const d = document.createElement('div');
    d.className = 'run-empty';
    d.textContent = '当前没有正在运行的轮次';
    root.appendChild(d);
    return;
  }
  for (const r of rows) {
    const card = document.createElement('div');
    card.className = 'run-card';
    const top = document.createElement('div');
    top.className = 'run-card-top';
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    dot.style.display = 'inline-block';
    dot.style.background = '#39ff88';
    dot.style.boxShadow = '0 0 6px #39ff88';
    const t = document.createElement('span');
    t.className = 'run-card-title';
    t.textContent = r.title;
    top.append(dot, t);
    if (r.kind === 'cockpit') {
      const stop = document.createElement('button');
      stop.className = 'run-stop';
      stop.textContent = '停止';
      stop.addEventListener('click', (e) => { e.stopPropagation(); wsSend({ op: 'chat.stop', ch: r.ch }); setTimeout(renderRunning, 800); });
      top.appendChild(stop);
    }
    const meta = document.createElement('div');
    meta.className = 'run-card-meta';
    meta.textContent = r.kind === 'cockpit'
      ? `${fmtDur(Date.now() - r.since)} · ${r.model || '默认模型'} · ${engineName(r.engine)}`
      : '在 VSCode / 终端中运行';
    card.append(top, meta);
    if (r.activity) {
      const act = document.createElement('div');
      act.className = 'run-card-act';
      act.textContent = r.activity.kind === 'tool' ? `▸ ${r.activity.name}` : `“${r.activity.name}”`;
      card.appendChild(act);
    }
    const cwd = document.createElement('div');
    cwd.className = 'run-card-cwd';
    cwd.textContent = r.cwd || '';
    card.appendChild(cwd);
    card.addEventListener('click', () => { if (r.slug && r.id) openSession(r.slug, r.id); });
    root.appendChild(card);
  }
}

let runningTimer = null;
function showRunning() {
  switchView('running');
  $('#mobile-title').textContent = '运行中';
  renderRunning();
  clearInterval(runningTimer);
  runningTimer = setInterval(() => { if (!$('#running-view').hidden) renderRunning(); else clearInterval(runningTimer); }, 5000);
}
$('#btn-running').addEventListener('click', showRunning);
$('#btn-running-refresh').addEventListener('click', renderRunning);
// ---------------- keep-awake ----------------
async function refreshAwake() {
  let st;
  try { st = await (await fetch('/api/awake')).json(); } catch { return; }
  const b = $('#btn-awake');
  const on = st.manual || st.auto;
  b.textContent = on ? '☀' : '☾';
  b.style.color = on ? 'var(--gold)' : '';
  b.title = st.manual ? `保持唤醒中，剩 ${st.minutesLeft} 分钟（点击关闭）`
    : st.auto ? '有轮次运行中，已自动阻止睡眠' : '阻止电脑睡眠（点击选择时长）';
}

$('#btn-awake').addEventListener('click', async () => {
  const st = await (await fetch('/api/awake')).json();
  let hours = 0;
  if (!st.manual) {
    const v = prompt('保持唤醒多少小时？（0 = 关闭，最多 12）', '4');
    if (v === null) return;
    hours = Number(v);
  }
  await fetch('/api/awake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours }) });
  refreshAwake();
});
refreshAwake();
setInterval(refreshAwake, 30000);

$('#btn-push').addEventListener('click', () => {
  if (window.__enablePush) window.__enablePush();
  else alert('当前环境不支持通知（需要 HTTPS 或 localhost）');
});

function openTerminal(kind, opts, title) {
  const ch = 't' + (++chSeq);
  const el = document.createElement('div');
  el.style.height = '100%';
  termContainer.appendChild(el);

  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"SF Mono", Menlo, monospace',
    theme: { background: '#100e0c', foreground: '#e8e2d6', cursor: '#c9a45c' },
    scrollback: 8000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  term.onData((data) => wsSend({ op: 'term.input', ch, data }));
  term.onResize(({ cols, rows }) => wsSend({ op: 'term.resize', ch, cols, rows }));

  const item = document.createElement('div');
  item.className = 'term-item';
  item.dataset.termCh = ch;
  const label = document.createElement('span');
  label.className = 'sess-title';
  label.textContent = (kind === 'ssh' ? '⇅ ' : '❯ ') + title;
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = '×';
  x.addEventListener('click', (e) => { e.stopPropagation(); closeTerminal(ch); });
  item.append(label, x);
  item.addEventListener('click', () => showTerm(ch));
  $('#term-list').appendChild(item);

  const t = { term, fit, el, item, title, dead: false };
  terms.set(ch, t);

  wsHandlers.set(ch, (m) => {
    if (m.op === 'term.data') term.write(m.data);
    else if (m.op === 'term.exit') { t.dead = true; term.write('\r\n\x1b[33m[会话已结束]\x1b[0m\r\n'); }
    else if (m.op === 'term.error') { t.dead = true; term.write(`\r\n\x1b[31m[错误] ${m.error}\x1b[0m\r\n`); }
  });

  showTerm(ch);
  wsSend({ op: 'term.open', ch, kind, cols: term.cols, rows: term.rows, ...opts });
  return ch;
}

function showTerm(ch) {
  activeTermCh = ch;
  for (const [k, t] of terms) t.el.style.display = k === ch ? '' : 'none';
  const t = terms.get(ch);
  $('#term-title').textContent = t.title;
  switchView('term');
  markActiveSession(null);
  document.querySelectorAll('.term-item').forEach(el =>
    el.classList.toggle('active', el.dataset.termCh === ch));
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
}

function closeTerminal(ch) {
  const t = terms.get(ch);
  if (!t) return;
  wsSend({ op: 'term.close', ch });
  wsHandlers.delete(ch);
  t.term.dispose();
  t.el.remove();
  t.item.remove();
  terms.delete(ch);
  if (activeTermCh === ch) {
    const next = terms.keys().next();
    if (!next.done) showTerm(next.value);
    else { activeTermCh = null; switchView('welcome'); }
  }
}

window.addEventListener('resize', () => {
  if (activeTermCh) terms.get(activeTermCh)?.fit.fit();
});

// ---------------- host switcher (本机 ↔ 其他 Cockpit) ----------------
function peerHost(url) {
  try { return new URL(url, location.origin).host; } catch { return ''; }
}
async function initPeers() {
  const sel = $('#peer-sel');
  if (!sel) return;
  let peers = [];
  try { peers = await (await fetch('/api/peers')).json(); } catch { peers = []; }
  if (!Array.isArray(peers) || peers.length < 2) return;
  sel.hidden = false;
  sel.innerHTML = '';
  const here = location.host;
  for (const p of peers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label || p.id;
    opt.dataset.url = p.url || '';
    if (p.token) opt.dataset.token = p.token;
    if (peerHost(p.url || location.origin) === here) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const opt = sel.selectedOptions[0];
    if (!opt) return;
    const url = (opt.dataset.url || '').replace(/\/+$/, '');
    if (!url || peerHost(url) === location.host) return;
    const token = opt.dataset.token || '';
    location.href = token ? `${url}/?t=${encodeURIComponent(token)}` : url + '/';
  });
}
initPeers();

$('#btn-new-term').addEventListener('click', () => {
  openTerminal('local', { cwd: chatViews.get(currentChatKey)?.cwd }, '本地终端');
});
$('#btn-close-term').addEventListener('click', () => { if (activeTermCh) closeTerminal(activeTermCh); });

// ---------------- new chat dialog ----------------
function openNewChatDialog(engine) {
  const f = $('#newchat-form');
  f.cwd.value = chatViews.get(currentChatKey)?.cwd || projectsCache[0]?.cwd || '';
  f.engine.value = engine;
  $('#newchat-dialog').showModal();
}
$('#btn-new-chat').addEventListener('click', () => openNewChatDialog('claude'));
$('#btn-new-cursor').addEventListener('click', () => openNewChatDialog('cursor'));
$('#btn-new-hermes')?.addEventListener('click', () => {
  newChat('', 'hermes');
});
$('#btn-new-opencode')?.addEventListener('click', () => {
  newChat('', 'opencode');
});
$('#newchat-dialog').addEventListener('close', () => {
  if ($('#newchat-dialog').returnValue === 'ok') {
    const f = $('#newchat-form');
    newChat(f.cwd.value.trim(), f.engine.value || 'claude');
  }
});

// ---------------- ssh dialog ----------------
let savedHosts = [];

async function loadHosts() {
  try { savedHosts = await (await fetch('/api/hosts')).json(); } catch { savedHosts = []; }
}
function saveHosts() {
  fetch('/api/hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(savedHosts) });
}
function renderSavedHosts() {
  const root = $('#saved-hosts');
  root.innerHTML = '';
  for (let i = 0; i < savedHosts.length; i++) {
    const h = savedHosts[i];
    const div = document.createElement('div');
    div.className = 'saved';
    const label = document.createElement('span');
    label.textContent = `${h.username}@${h.host}:${h.port || 22}`;
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '删除';
    del.addEventListener('click', (e) => { e.stopPropagation(); savedHosts.splice(i, 1); saveHosts(); renderSavedHosts(); });
    div.append(label, del);
    div.addEventListener('click', () => {
      const f = $('#ssh-form');
      f.host.value = h.host; f.port.value = h.port || 22;
      f.username.value = h.username; f.password.value = h.password || '';
    });
    root.appendChild(div);
  }
}

// ---------------- phone pairing QR ----------------
$('#btn-phone').addEventListener('click', async () => {
  const d = $('#phone-dialog');
  try {
    const info = await (await fetch('/api/pair')).json();
    $('#phone-form').base.value = info.publicUrl || '';
    renderPairQR(info);
  } catch { /* server offline */ }
  d.showModal();
});

function renderPairQR(info) {
  const box = $('#phone-qr');
  box.innerHTML = '';
  if (!info.qr) {
    box.textContent = '填入公网地址后生成二维码';
    return;
  }
  const card = (title, hint, src, link) => {
    const wrap = document.createElement('div');
    wrap.className = 'qr-card';
    const h = document.createElement('div');
    h.className = 'qr-title';
    h.textContent = title;
    const img = document.createElement('img');
    img.src = src;
    const p = document.createElement('div');
    p.className = 'tok';
    p.textContent = hint;
    wrap.append(h, img, p);
    if (link) wrap.title = link;
    return wrap;
  };
  box.appendChild(card('① 网页 / 装到主屏', '扫码即自动登录', info.qr, info.url));
  if (info.apkQr) {
    box.appendChild(card('② 下载安卓 App', '扫码直接下载 APK，装完即已登录', info.apkQr, info.apkUrl));
  } else {
    const tip = document.createElement('div');
    tip.className = 'tok';
    tip.textContent = 'APK 尚未构建：在项目里跑 bash android/build.sh';
    box.appendChild(tip);
  }
}

$('#phone-dialog').addEventListener('close', async () => {
  if ($('#phone-dialog').returnValue !== 'ok') return;
  const base = $('#phone-form').base.value.trim();
  try {
    const info = await (await fetch('/api/pair?base=' + encodeURIComponent(base))).json();
    renderPairQR(info);
    $('#phone-dialog').showModal();
  } catch { /* ignore */ }
});

$('#btn-new-ssh').addEventListener('click', async () => {
  await loadHosts();
  renderSavedHosts();
  $('#ssh-dialog').showModal();
});
$('#ssh-dialog').addEventListener('close', () => {
  if ($('#ssh-dialog').returnValue !== 'ok') return;
  const f = $('#ssh-form');
  const conn = {
    host: f.host.value.trim(),
    port: parseInt(f.port.value, 10) || 22,
    username: f.username.value.trim(),
    password: f.password.value,
  };
  if (f.save.checked) {
    const idx = savedHosts.findIndex(h => h.host === conn.host && h.username === conn.username);
    if (idx >= 0) savedHosts[idx] = conn; else savedHosts.push(conn);
    saveHosts();
  }
  openTerminal('ssh', { ssh: conn }, `${conn.username}@${conn.host}`);
});

// graph.js 是独立脚本，需要这两个入口
window.openSession = openSession;
window.switchView = switchView;
