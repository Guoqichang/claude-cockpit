(function () {
  const $ = (s) => document.querySelector(s);
  const COLS = ['you', 'cockpit', 'engine', 'disk'];

  const STEPS = [
    {
      col: null,
      you: '还没开口',
      cockpit: '空闲，没有会话',
      engine: '引擎没被叫醒',
      disk: 'className="btn-muted"',
      ses: '还没有', turn: '0', file: 'btn-muted',
      browser: '开着', keep: '尚未开改',
      caption: '起点：磁盘上登录按钮还是灰色 btn-muted。还没有会话，OpenCode 没被叫醒。',
    },
    {
      col: 'you',
      you: '把顶栏登录按钮改成金色',
      cockpit: '空闲，没有会话',
      engine: '引擎没被叫醒',
      disk: 'className="btn-muted"',
      ses: '还没有', turn: '0', file: 'btn-muted',
      browser: '开着', keep: '尚未开改',
      float: '发出一句',
      caption: '你打的是能落地的那句：文件 src/App.jsx，class 从 btn-muted 换成金色。不是「让页面高级一点」。',
    },
    {
      col: 'cockpit',
      you: '把顶栏登录按钮改成金色',
      cockpit: '新建会话，转给本机 OpenCode',
      engine: '引擎没被叫醒',
      disk: 'className="btn-muted"',
      ses: 'ses_demo', turn: '1', file: 'btn-muted',
      browser: '开着', keep: '尚未开改',
      float: 'ses_demo',
      caption: '驾驶舱 7799 只转发。账单走你贴的那把 Key，不经过某个网站的聊天框。',
    },
    {
      col: 'engine',
      you: '把顶栏登录按钮改成金色',
      cockpit: '这一轮进行中',
      engine: 'Read src/App.jsx，改 className',
      disk: 'className="btn-muted"',
      ses: 'ses_demo', turn: '1', file: 'btn-muted',
      browser: '开着', keep: '正在改',
      caption: 'OpenCode 才是引擎：读文件、改文件。驾驶舱自己不碰 App.jsx。',
    },
    {
      col: 'disk',
      you: '把顶栏登录按钮改成金色',
      cockpit: '这一轮完成',
      engine: '已写入磁盘',
      disk: 'className="btn-gold"',
      ses: 'ses_demo', turn: '1', file: 'btn-gold',
      browser: '开着', keep: '已写入 App.jsx',
      float: 'btn-gold',
      caption: '改动落在磁盘。刷新那个前端，顶栏登录按钮应该已经是金色。',
    },
    {
      col: 'you',
      you: '清空按钮也加上',
      cockpit: '同一条会话续一轮',
      engine: '带着上一轮上下文接着改',
      disk: 'className="btn-gold"',
      ses: 'ses_demo', turn: '2', file: 'btn-gold',
      browser: '开着', keep: '已写入 App.jsx',
      float: '第 2 轮',
      caption: '同一条 ses_demo 里发第二句。不必把 App.jsx 再贴一遍。两步两轮，比一句做完全站更稳。',
    },
    {
      col: 'cockpit',
      you: '关掉 7799 的标签页',
      cockpit: '画面断了，轮次还在本机',
      engine: '历史还在 OpenCode 库里',
      disk: 'className="btn-gold"',
      ses: 'ses_demo', turn: '2', file: 'btn-gold',
      browser: '关了', keep: '改动还在磁盘',
      caption: '关掉浏览器只断画面。App.jsx 仍是 btn-gold；重开 7799 还能续 ses_demo。',
    },
  ];

  let idx = 0;
  let timer = null;
  let playing = false;

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = v;
  }

  function floatAt(col, text) {
    const stage = $('#intro-stage');
    const cell = stage?.querySelector('[data-col="' + col + '"]');
    if (!stage || !cell || !text) return;
    const f = document.createElement('div');
    f.className = 'intro-float';
    f.textContent = text;
    const sr = stage.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    f.style.left = (cr.left - sr.left + cr.width / 2) + 'px';
    f.style.top = (cr.top - sr.top + 18) + 'px';
    stage.appendChild(f);
    requestAnimationFrame(() => f.classList.add('go'));
    setTimeout(() => f.remove(), 1400);
  }

  function moveToken(col) {
    const token = $('#intro-token');
    const stage = $('#intro-stage');
    const cell = col ? stage?.querySelector('[data-col="' + col + '"]') : null;
    if (!token || !stage) return;
    if (!cell) { token.hidden = true; return; }
    token.hidden = false;
    const sr = stage.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    token.style.left = (cr.left - sr.left + cr.width / 2 - 6) + 'px';
    token.style.top = (cr.bottom - sr.top - 14) + 'px';
    const ghost = document.createElement('div');
    ghost.className = 'intro-ghost';
    ghost.style.left = token.style.left;
    ghost.style.top = token.style.top;
    stage.appendChild(ghost);
    setTimeout(() => ghost.remove(), 900);
  }

  function paintTrail(upto) {
    const root = $('#intro-trail');
    if (!root) return;
    root.innerHTML = '';
    for (let i = 0; i < STEPS.length; i++) {
      const d = document.createElement('span');
      d.className = 'intro-foot' + (i <= upto ? ' on' : '') + (i === upto ? ' now' : '');
      root.appendChild(d);
    }
  }

  function apply(i, { withFloat = true } = {}) {
    idx = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[idx];
    setText('intro-you', s.you);
    setText('intro-cockpit', s.cockpit);
    setText('intro-engine', s.engine);
    setText('intro-disk', s.disk);
    setText('intro-caption', s.caption);
    setText('lg-ses', s.ses);
    setText('lg-turn', s.turn);
    setText('lg-file', s.file);
    setText('lg-browser', s.browser);
    setText('lg-keep', s.keep);
    document.querySelectorAll('.intro-col').forEach((el) => {
      el.classList.toggle('spot', el.dataset.col === s.col);
      el.classList.toggle('dim', s.col && el.dataset.col !== s.col);
    });
    moveToken(s.col);
    paintTrail(idx);
    if (withFloat && s.float && s.col) floatAt(s.col, s.float);
    const play = $('#intro-play');
    if (play && !playing) play.textContent = idx === 0 ? '▶ 自动演示' : '▶ 从这一幕继续';
  }

  function stop() {
    playing = false;
    if (timer) { clearTimeout(timer); timer = null; }
    const play = $('#intro-play');
    if (play) play.textContent = idx >= STEPS.length - 1 ? '↻ 再看一遍' : '▶ 从这一幕继续';
  }

  function playFrom(start) {
    stop();
    playing = true;
    const play = $('#intro-play');
    if (play) play.textContent = '❚❚ 停';
    let i = start;
    const tick = () => {
      if (!playing) return;
      apply(i, { withFloat: true });
      i += 1;
      if (i >= STEPS.length) {
        playing = false;
        if (play) play.textContent = '↻ 再看一遍';
        return;
      }
      timer = setTimeout(tick, 1700);
    };
    tick();
  }

  function revealWelcome() {
    const w = $('#welcome');
    if (!w) return;
    ['chat-view', 'term-view', 'running-view', 'graph-view'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    w.hidden = false;
    document.getElementById('app')?.classList.remove('drawer-open');
  }

  function panes() {
    return {
      welcome: $('#welcome'),
      idle: $('#welcome-idle'),
      intro: $('#intro-panel'),
      setup: $('#setup-panel'),
    };
  }

  function showHome() {
    stop();
    revealWelcome();
    const p = panes();
    if (p.idle) p.idle.hidden = false;
    if (p.intro) p.intro.hidden = true;
    if (p.setup) p.setup.hidden = true;
    p.welcome?.classList.remove('welcome-doc');
    if (location.hash === '#about' || location.hash === '#setup') {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function showIntro() {
    revealWelcome();
    const p = panes();
    if (p.idle) p.idle.hidden = true;
    if (p.intro) p.intro.hidden = false;
    if (p.setup) p.setup.hidden = true;
    p.welcome?.classList.add('welcome-doc');
    if (location.hash !== '#about') location.hash = 'about';
    apply(idx || 0, { withFloat: false });
  }

  window.cockpitShowIntro = showIntro;
  window.cockpitShowHome = showHome;
  window.cockpitIntroApply = apply;

  $('#intro-play')?.addEventListener('click', () => {
    if (playing) { stop(); return; }
    playFrom(idx >= STEPS.length - 1 ? 0 : idx);
  });

  document.querySelectorAll('.intro-col').forEach((el) => {
    el.addEventListener('click', () => {
      stop();
      const col = el.dataset.col;
      const found = STEPS.findIndex((s, n) => n > 0 && s.col === col);
      apply(found < 0 ? 0 : found);
    });
  });

  $('#intro-trail')?.addEventListener('click', (ev) => {
    const feet = [...($('#intro-trail')?.children || [])];
    const n = feet.indexOf(ev.target);
    if (n >= 0) { stop(); apply(n); }
  });

  $('#btn-intro')?.addEventListener('click', () => showIntro());
  document.querySelector('.brand')?.addEventListener('click', () => showHome());

  $('#btn-intro-opencode')?.addEventListener('click', () => {
    document.getElementById('btn-new-opencode')?.click();
  });

  window.addEventListener('resize', () => apply(idx, { withFloat: false }));
})();
