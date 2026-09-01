(function () {
  const $ = (s) => document.querySelector(s);

  function showSetup(on) {
    const idle = $('#welcome-idle');
    const panel = $('#setup-panel');
    if (!idle || !panel) return;
    idle.hidden = on;
    panel.hidden = !on;
    if (on) {
      location.hash = 'setup';
      refresh();
    } else if (location.hash === '#setup') {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function dot(ok, mid, label) {
    const cls = ok ? 'ok' : mid ? 'mid' : 'bad';
    const mark = ok ? '●' : mid ? '○' : '×';
    return `<li class="${cls}"><span>${mark}</span><span>${label}</span></li>`;
  }

  async function refresh() {
    let st;
    try {
      const res = await fetch('/api/setup/status');
      st = await res.json();
      if (!res.ok) throw new Error(st.error || res.status);
    } catch (e) {
      $('#setup-dots').innerHTML = dot(false, false, '读不了本机状态：' + (e.message || e));
      return st;
    }

    const oc = st.opencode || {};
    const en = st.engines || {};
    $('#setup-dots').innerHTML = [
      dot(true, false, 'Node ' + (st.node || '')),
      dot(!!st.python, false, st.python
        ? 'Python 已就绪（' + st.pythonBin + '），能导入已有 OpenCode 会话'
        : '没检测到 Python。先聊不受影响；以后要导入旧会话，再装 Python 3'),
      dot(!!oc.binOk, false, oc.binOk
        ? 'OpenCode 二进制：' + oc.bin
        : '还没有 OpenCode，先做第 2 步'),
      dot(!!oc.hasKey, false, oc.hasKey
        ? '已经有 Key（' + (oc.providers || []).join(', ') + '）'
        : '还没写下 API Key，先做第 3 步'),
      dot(!!en.claude, true, en.claude ? 'Claude Code 也在，可点「＋ Claude」' : 'Claude Code 未装，可以后再说'),
      dot(!!en.cursor, true, en.cursor ? 'Cursor 也在，可点「＋ Cursor」' : 'Cursor 未装，可以后再说'),
      dot(!!en.hermes, true, en.hermes ? 'Hermes 也在' : 'Hermes 未装，可以后再说'),
    ].join('');

    const binOk = !!oc.binOk;
    $('#setup-bin-msg').textContent = binOk
      ? 'OpenCode 已经在这台电脑上。'
      : '没有 OpenCode。点按钮走官方安装脚本，或自己在终端跑下面这一行。';
    const cmd = $('#setup-bin-cmd');
    cmd.hidden = binOk;
    cmd.textContent = oc.installCmd || '';
    $('#setup-install-btn').hidden = binOk;
    $('#setup-install-btn').disabled = false;

    const sel = $('#setup-provider');
    if (sel && !sel.dataset.filled) {
      sel.innerHTML = '';
      for (const p of (st.presets || [])) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.id === 'deepseek' ? '（推荐）' : '');
        opt.dataset.hint = p.keyHint || '';
        sel.appendChild(opt);
      }
      const custom = document.createElement('option');
      custom.value = 'custom';
      custom.textContent = 'OpenAI 兼容网关（自己填地址）';
      sel.appendChild(custom);
      sel.value = 'deepseek';
      sel.dataset.filled = '1';
    }

    const go = $('#setup-go-btn');
    go.disabled = !(binOk && oc.hasKey);
    if (binOk && oc.hasKey) {
      $('#setup-go-msg').textContent = '可以开聊了。点按钮会拉起 opencode serve，并新建一条 reverse 会话。';
    }
    return st;
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.status);
    return data;
  }

  $('#btn-setup')?.addEventListener('click', () => showSetup(true));
  $('#btn-open-setup')?.addEventListener('click', () => showSetup(true));
  $('#setup-skip')?.addEventListener('click', () => showSetup(false));

  $('#setup-provider')?.addEventListener('change', () => {
    $('#setup-base-wrap').hidden = $('#setup-provider').value !== 'custom';
  });

  $('#setup-install-btn')?.addEventListener('click', async () => {
    const btn = $('#setup-install-btn');
    const log = $('#setup-install-log');
    btn.disabled = true;
    log.hidden = false;
    log.className = 'setup-note';
    log.textContent = '正在跑官方安装脚本，可能要一两分钟…';
    try {
      const r = await post('/api/setup/opencode-install');
      log.className = 'setup-note ok';
      log.textContent = r.skipped ? '本来就装着，跳过。' : '装好了：' + r.bin;
      await refresh();
    } catch (e) {
      log.className = 'setup-note err';
      log.textContent = e.message || String(e);
      btn.disabled = false;
    }
  });

  $('#setup-save-key')?.addEventListener('click', async () => {
    const msg = $('#setup-key-msg');
    msg.className = 'setup-note';
    msg.textContent = '正在写入本机配置…';
    try {
      const provider = $('#setup-provider').value;
      const body = { provider, apiKey: $('#setup-key').value };
      if (provider === 'custom') body.baseURL = $('#setup-baseurl').value.trim();
      const r = await post('/api/setup/opencode-key', body);
      $('#setup-key').value = '';
      msg.className = 'setup-note ok';
      msg.textContent = '已写入 ' + r.config + '，默认模型 ' + (r.model || '');
      await refresh();
    } catch (e) {
      msg.className = 'setup-note err';
      msg.textContent = e.message || String(e);
    }
  });

  $('#setup-go-btn')?.addEventListener('click', async () => {
    const btn = $('#setup-go-btn');
    btn.disabled = true;
    $('#setup-go-msg').textContent = '正在拉起 opencode serve…';
    try {
      await post('/api/setup/opencode-serve');
      showSetup(false);
      $('#btn-new-opencode')?.click();
    } catch (e) {
      $('#setup-go-msg').textContent = 'serve 没起来：' + (e.message || e);
      btn.disabled = false;
    }
  });

  async function boot() {
    let st = null;
    try {
      const res = await fetch('/api/setup/status');
      if (res.ok) st = await res.json();
    } catch { /* 鉴权口会 403，忽略 */ }
    const want = location.hash === '#setup' || (st && st.ready === false);
    if (want) showSetup(true);
    else if (st) {
      /* keep idle welcome */
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
