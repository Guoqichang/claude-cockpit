/* Session graph: a live map of every session.
   Size = volume × recency, color = cluster (server-computed), icon = topic,
   ring = state. The camera (wheel / drag / pinch) works on a world that grows
   with content, and cluster anchors are relaxed apart so groups never pile up.
   Force sim is hand-rolled — 150 nodes does not justify a dependency. */
'use strict';

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('graph-svg');
  const stage = document.getElementById('graph-stage');
  const card = document.getElementById('graph-card');
  const legend = document.getElementById('graph-legend');

  let data = { nodes: [], clusters: [] };
  let sim = [];           // simulation bodies, parallel to data.nodes
  let raf = null, ticks = 0;
  let selected = null, hovered = null;
  let pollTimer = null;

  // camera: screen = world · k + (tx, ty)
  const view = { k: 1, tx: 0, ty: 0 };
  let userMoved = false;  // once the user drives the camera, stop auto-fitting
  let world = { w: 900, h: 600 };

  const el = (name, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const hashInt = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Math.abs(h);
  };

  const nodeColor = (n) => n.color || 'hsl(40 35% 55%)';

  function radius(n) {
    const vol = Math.log2((n.msgCount || 4) + 2);          // 轮数
    const fresh = 1 + 1.15 * Math.max(0, 1 - n.ageHours / 72);  // 越新越大
    const base = 5 + vol * 2.1 * fresh;
    return Math.max(6, Math.min(34, base));
  }

  const stateOf = (n) => n.state;

  // ---------- camera ----------
  const clampK = (k) => Math.max(0.15, Math.min(6, k));

  function zoomAt(mx, my, f) {
    const k2 = clampK(view.k * f);
    const g = k2 / view.k;
    view.tx = mx - (mx - view.tx) * g;
    view.ty = my - (my - view.ty) * g;
    view.k = k2;
    paint();
  }

  function fitView() {
    if (!sim.length) return;
    const sw = stage.clientWidth || 900, sh = stage.clientHeight || 600;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const b of sim) {
      x1 = Math.min(x1, b.x - b.r); y1 = Math.min(y1, b.y - b.r);
      x2 = Math.max(x2, b.x + b.r); y2 = Math.max(y2, b.y + b.r);
    }
    const m = 48;
    const k = clampK(Math.min((sw - m * 2) / Math.max(80, x2 - x1), (sh - m * 2) / Math.max(80, y2 - y1), 1.5));
    view.k = k;
    view.tx = (sw - (x1 + x2) * k) / 2;
    view.ty = (sh - (y1 + y2) * k) / 2;
    paint();
  }

  function paint() { if (!raf) render(); }

  // wheel = zoom at the cursor (pinch on a trackpad arrives as wheel+ctrlKey)
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    userMoved = true;
    const rect = svg.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top,
      Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018)));
  }, { passive: false });

  // drag = pan, two pointers = pinch zoom
  const pointers = new Map();
  let pinch = null, drag = null, squelchClick = false;

  svg.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      drag = null;
      return;
    }
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    // capturing over a node would steal its click, so only capture on background
    if (!(e.target.closest && e.target.closest('.gnode'))) {
      try { svg.setPointerCapture(e.pointerId); } catch { /* fine */ }
    }
  });

  svg.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = svg.getBoundingClientRect();
      userMoved = true;
      const k2 = clampK(pinch.k * d / Math.max(20, pinch.d));
      zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, k2 / view.k);
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; userMoved = true; }
      if (drag.moved) { view.tx = drag.tx + dx; view.ty = drag.ty + dy; paint(); }
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && drag.moved) squelchClick = true;
    drag = null;
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  svg.addEventListener('dblclick', (e) => {
    if (e.target.closest && e.target.closest('.gnode')) return;
    userMoved = true;
    const rect = svg.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.6);
  });

  function centerZoom(f) {
    userMoved = true;
    zoomAt((stage.clientWidth || 900) / 2, (stage.clientHeight || 600) / 2, f);
  }
  document.getElementById('gz-in').addEventListener('click', () => centerZoom(1.35));
  document.getElementById('gz-out').addEventListener('click', () => centerZoom(1 / 1.35));
  document.getElementById('gz-fit').addEventListener('click', () => { userMoved = false; fitView(); });

  // ---------- layout ----------
  function seedSim() {
    const sw = stage.clientWidth || 900, sh = stage.clientHeight || 600;

    // the world grows with content — the camera makes up the difference, so
    // nothing has to be crushed into one screen anymore
    const radii = data.nodes.map(radius);
    let area = 0;
    for (const r of radii) area += (2 * r + 34) ** 2;
    const spread = Math.max(1, Math.min(3.2, Math.sqrt(area * 1.9 / (sw * sh))));
    world = { w: sw * spread, h: sh * spread };

    // sunflower placement spreads clusters over the world; big ones near centre
    const order = data.clusters.map((c, i) => i).sort((a, b) => data.clusters[b].size - data.clusters[a].size);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const clR = data.clusters.map((c, ci) => {
      let s2 = 0;
      data.nodes.forEach((n, i) => { if (n.cluster === ci) s2 += (radii[i] + 10) ** 2; });
      return Math.sqrt(s2) * 1.6 + 30;
    });
    const anchors = new Map();
    const mx = 90, my = 80;
    order.forEach((ci, rank) => {
      const t = (rank + 0.5) / Math.max(1, order.length);
      const rad = Math.sqrt(t);
      const ang = rank * golden;
      anchors.set(ci, {
        x: world.w / 2 + Math.cos(ang) * rad * (world.w / 2 - mx),
        y: world.h / 2 + Math.sin(ang) * rad * (world.h / 2 - my),
        r: clR[ci],
      });
    });

    // relax overlapping cluster footprints apart — this is what stops the
    // "everything piled in one heap" failure mode
    const as = [...anchors.values()];
    for (let it = 0; it < 260; it++) {
      let moved = false;
      for (let i = 0; i < as.length; i++) {
        for (let j = i + 1; j < as.length; j++) {
          const a = as[i], b = as[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.01;
          const min = (a.r + b.r) * 0.8;      // footprints may touch, not stack
          if (d < min) {
            const push = (min - d) / 2 / d;
            a.x -= dx * push; a.y -= dy * push;
            b.x += dx * push; b.y += dy * push;
            moved = true;
          }
        }
      }
      for (const a of as) {
        a.x = Math.max(a.r * 0.45 + 40, Math.min(world.w - a.r * 0.45 - 40, a.x));
        a.y = Math.max(a.r * 0.45 + 40, Math.min(world.h - a.r * 0.45 - 40, a.y));
      }
      if (!moved) break;
    }

    sim = data.nodes.map((n, i) => {
      const anchor = anchors.get(n.cluster) || { x: world.w / 2, y: world.h / 2, r: 60 };
      const prev = sim[i] && sim[i].id === n.id ? sim[i] : null;
      const jit = Math.max(40, anchor.r * 0.7);
      return {
        id: n.id, n,
        x: prev ? prev.x : anchor.x + ((hashInt(n.id) % 1000) / 1000 - 0.5) * jit * 2,
        y: prev ? prev.y : anchor.y + ((hashInt(n.id + 'y') % 1000) / 1000 - 0.5) * jit * 2,
        vx: 0, vy: 0, r: radii[i], anchor,
      };
    });
    ticks = 0;
  }

  function step() {
    const attention = document.getElementById('graph-attention').checked;
    const grouped = document.getElementById('graph-clusters').checked;
    const cx = world.w / 2, cy = world.h / 2;

    for (const b of sim) {
      let tx, ty;
      if (attention) {
        // rank (not raw score) sets the distance: scores bunch up at the low end,
        // which would pack almost everything into one ring
        const t = (b.rank + 0.5) / sim.length;
        const ang = b.rank * 2.399963;               // golden angle keeps rings from forming
        const rad = Math.sqrt(t) * Math.min(world.w, world.h) * 0.47 + 26;
        tx = cx + Math.cos(ang) * rad * 1.25;
        ty = cy + Math.sin(ang) * rad;
      } else if (grouped) {
        tx = b.anchor.x; ty = b.anchor.y;
      } else {
        tx = cx; ty = cy;
      }
      b.vx += (tx - b.x) * 0.012;
      b.vy += (ty - b.y) * 0.012;
    }

    // repulsion (O(n²) is fine at this scale) + collision
    for (let i = 0; i < sim.length; i++) {
      const a = sim[i];
      for (let j = i + 1; j < sim.length; j++) {
        const b = sim[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 === 0) { dx = 0.5; dy = 0.5; d2 = 0.5; }
        const min = a.r + b.r + 8;
        const d = Math.sqrt(d2);
        if (d < min) {
          const push = (min - d) / d * 0.5;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        } else if (d < 260) {
          const f = 140 / d2;
          a.vx -= dx / d * f; a.vy -= dy / d * f;
          b.vx += dx / d * f; b.vy += dy / d * f;
        }
      }
    }

    for (const b of sim) {
      b.vx *= 0.86; b.vy *= 0.86;
      b.x += b.vx; b.y += b.vy;
      b.x = Math.max(b.r + 6, Math.min(world.w - b.r - 6, b.x));
      b.y = Math.max(b.r + 6, Math.min(world.h - b.r - 6, b.y));
    }
  }

  // ---------- render ----------
  function render() {
    const q = document.getElementById('graph-filter').value.trim().toLowerCase();
    const sw = stage.clientWidth || 900, sh = stage.clientHeight || 600;
    svg.setAttribute('viewBox', `0 0 ${sw} ${sh}`);
    svg.innerHTML = '';

    const gRoot = el('g', {
      transform: `translate(${view.tx.toFixed(1)},${view.ty.toFixed(1)}) scale(${view.k.toFixed(4)})`,
    });
    svg.appendChild(gRoot);

    // cluster labels sit behind everything
    if (document.getElementById('graph-clusters').checked && !document.getElementById('graph-attention').checked) {
      const seen = new Map();
      for (const b of sim) {
        const c = b.n.cluster;
        if (!seen.has(c)) seen.set(c, { x: 0, y: 0, n: 0 });
        const s = seen.get(c); s.x += b.x; s.y += b.y; s.n++;
      }
      for (const [ci, s] of seen) {
        const cl = data.clusters[ci];
        if (!cl || cl.size < 2) continue;
        const t = el('text', {
          x: s.x / s.n, y: s.y / s.n, class: 'cluster-label',
          'text-anchor': 'middle',
        });
        t.textContent = cl.label;
        gRoot.appendChild(t);
      }
    }

    // label decluttering: important nodes win, and anything whose box would
    // collide with an already-placed label stays silent (hover still shows it)
    const wantsLabel = new Set();
    const boxes = [];
    const maxLabels = Math.round(26 * Math.max(1, view.k * 1.3));
    const ranked = [...sim].sort((a, b) => (b.n.attention + b.r * 2) - (a.n.attention + a.r * 2));
    for (const b of ranked) {
      if (wantsLabel.size >= maxLabels && selected !== b.n.id) continue;
      const w = Math.min(14, b.n.title.length) * 5.6, h = 12;
      const box = { x1: b.x - w / 2, x2: b.x + w / 2, y1: b.y + b.r + 2, y2: b.y + b.r + 2 + h };
      const clash = boxes.some(o => !(box.x2 < o.x1 || box.x1 > o.x2 || box.y2 < o.y1 || box.y1 > o.y2));
      if (clash && selected !== b.n.id && hovered !== b.n.id) continue;
      boxes.push(box);
      wantsLabel.add(b.n.id);
    }

    for (const b of sim) {
      const n = b.n;
      const dim = q && !(n.title.toLowerCase().includes(q) || (n.cwd || '').toLowerCase().includes(q));
      const g = el('g', {
        class: 'gnode ' + stateOf(n) + (dim ? ' dim' : '') + (selected === n.id ? ' sel' : ''),
        transform: `translate(${b.x.toFixed(1)},${b.y.toFixed(1)})`,
      });

      if (n.pinned) g.appendChild(el('circle', { r: b.r + 6, class: 'ring-pin' }));
      if (n.state === 'running') g.appendChild(el('circle', { r: b.r + 7, class: 'ring-run' }));
      if (n.goal) g.appendChild(el('circle', { r: b.r + 4, class: 'ring-goal' }));
      if (n.loop) g.appendChild(el('circle', { r: b.r + 4, class: 'ring-loop' }));
      if (n.state === 'error') g.appendChild(el('circle', { r: b.r + 4, class: 'ring-err' }));
      if (n.state === 'open') g.appendChild(el('circle', { r: b.r + 3, class: 'ring-open' }));

      g.appendChild(el('circle', { r: b.r, fill: nodeColor(n), class: 'body' }));
      if (b.r >= 9 && window.CockpitIcons) window.CockpitIcons.appendTo(g, n.icon, b.r);

      if (wantsLabel.has(n.id)) {
        const label = el('text', { y: b.r + 12, 'text-anchor': 'middle', class: 'nlabel' });
        label.textContent = n.title.length > 14 ? n.title.slice(0, 13) + '…' : n.title;
        g.appendChild(label);
      }

      // running nodes narrate themselves without needing a hover — that is the
      // whole point of an overview
      if (n.state === 'running' && n.activity) {
        const chip = el('text', { y: -b.r - 8, 'text-anchor': 'middle', class: 'nactivity' });
        chip.textContent = n.activity.kind === 'tool' ? '▸ ' + n.activity.name : n.activity.name.slice(0, 16);
        g.appendChild(chip);
      }

      g.addEventListener('mouseenter', () => { hovered = n.id; showCard(n, b); });
      g.addEventListener('mouseleave', () => { if (hovered === n.id) hideCard(); });
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (squelchClick) { squelchClick = false; return; }
        selected = n.id;
        showCard(n, b, true);
      });
      g.addEventListener('dblclick', () => openNode(n));
      gRoot.appendChild(g);
    }

    document.getElementById('graph-stat').textContent =
      `${data.nodes.length} 会话 · ${data.clusters.length} 组 · ${data.nodes.filter(n => n.state === 'running').length} 运行中`;
  }

  function loop() {
    if (document.getElementById('graph-view').hidden) { raf = null; return; }
    if (ticks < 600) {
      step(); ticks++;
      // keep the whole map in frame while it settles, until the user takes over
      if (!userMoved && (ticks === 2 || ticks === 60 || ticks === 180 || ticks === 420)) fitView();
    }
    render();
    raf = requestAnimationFrame(loop);
  }

  function kick() {
    ticks = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // ---------- detail card (the "live window" per node) ----------
  function showCard(n, b, pin = false) {
    const secs = n.runningSince ? Math.round((Date.now() - n.runningSince) / 1000) : 0;
    const dur = secs ? (secs < 60 ? `${secs}秒` : `${Math.floor(secs / 60)}分${secs % 60}秒`) : '';
    const rows = [];
    if (n.state === 'running') rows.push(`<div class="gc-live">● ${n.activity ? (n.activity.kind === 'tool' ? '正在用 ' + n.activity.name : n.activity.name) : '运行中'}${dur ? ' · ' + dur : ''}</div>`);
    if (n.goal) rows.push(`<div class="gc-tag goal">◎ goal：${escapeHtml(n.goal)}</div>`);
    if (n.loop) rows.push(`<div class="gc-tag loop">↻ loop：${escapeHtml(n.loop)}</div>`);
    if (n.state === 'error') rows.push('<div class="gc-tag err">上一轮以错误结束</div>');
    if (n.lastUser) rows.push(`<div class="gc-quote">你：${escapeHtml(n.lastUser.slice(0, 90))}</div>`);
    if (n.lastAssistant) rows.push(`<div class="gc-quote assistant">${escapeHtml(n.lastAssistant.slice(0, 160))}</div>`);

    card.innerHTML = `
      <div class="gc-head"><span class="gc-dot" style="background:${nodeColor(n)}"></span>
        <span class="gc-title">${escapeHtml(n.title)}</span>
        <span class="gc-engine ${n.engine}">${n.engine === 'cursor' ? 'CR' : n.engine === 'hermes' ? 'HM' : 'CC'}</span></div>
      <div class="gc-meta">${n.msgCount == null ? '长会话' : n.msgCount + ' 条'} ·
        ${fmtAge(n.ageHours)} · 注意力 ${n.attention}${n.lastCost != null ? ' · $' + n.lastCost.toFixed(3) : ''}</div>
      <div class="gc-cwd">${escapeHtml(n.cwd || '')}</div>
      ${rows.join('')}
      <div class="gc-actions"><button class="gc-open">进入对话</button>${pin ? '<button class="gc-close">关闭</button>' : ''}</div>`;
    card.hidden = false;
    const W = stage.clientWidth, H = stage.clientHeight;
    // node lives in world coords; the card lives on screen
    const sx = b.x * view.k + view.tx, sy = b.y * view.k + view.ty, sr = b.r * view.k;
    const left = Math.min(Math.max(8, sx + sr + 12), W - 300);
    const top = Math.min(Math.max(8, sy - 40), H - 200);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.querySelector('.gc-open').onclick = () => openNode(n);
    const close = card.querySelector('.gc-close');
    if (close) close.onclick = () => { selected = null; hideCard(); };
  }

  function hideCard() { if (!selected) card.hidden = true; }

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtAge = (h) => h < 1 ? `${Math.round(h * 60)} 分钟前` : h < 48 ? `${h.toFixed(1)} 小时前` : `${Math.round(h / 24)} 天前`;

  function openNode(n) {
    if (typeof window.openSession === 'function') window.openSession(n.slug, n.id);
  }

  // ---------- legend + data ----------
  function renderLegend() {
    legend.innerHTML = `
      <div><span class="lg ring-run"></span>正在跑</div>
      <div><span class="lg ring-goal"></span>goal</div>
      <div><span class="lg ring-loop"></span>loop</div>
      <div><span class="lg ring-err"></span>报错</div>
      <div><span class="lg ring-open"></span>别处打开</div>
      <div><span class="lg ring-pin"></span>置顶</div>
      <div class="lg-note">大小 = 轮数×新鲜度 · 颜色/图标 = 主题 · 滚轮缩放 · 拖拽平移</div>`;
  }

  async function load(reseed = true) {
    try {
      const r = await fetch('/api/graph');
      const d = await r.json();
      if (d.error) return;
      data = d;
      // bodies match nodes by id — order shifts between polls as attention changes
      const byId = new Map(data.nodes.map(n => [n.id, n]));
      const allMatch = sim.length === data.nodes.length && sim.every(b => byId.has(b.id));
      if (reseed || !allMatch) seedSim();
      else for (const b of sim) { b.n = byId.get(b.id); b.r = radius(b.n); }
      const byAtt = [...data.nodes].sort((a, b) => b.attention - a.attention).map(n => n.id);
      const rankOf = new Map(byAtt.map((id, i) => [id, i]));
      for (const b of sim) b.rank = rankOf.get(b.id) ?? sim.length - 1;
      renderLegend();
      if (typeof window.applyGraphMeta === 'function') window.applyGraphMeta(data.nodes);
      kick();
    } catch { /* server busy; next poll retries */ }
  }

  // ---------- wiring ----------
  function show() {
    if (typeof window.switchView === 'function') window.switchView('graph');
    userMoved = false;
    load(true);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.getElementById('graph-view').hidden) { clearInterval(pollTimer); return; }
      load(false);
    }, 5000);
  }

  document.getElementById('btn-graph').addEventListener('click', show);
  document.getElementById('btn-open-graph').addEventListener('click', show);
  document.getElementById('graph-refresh').addEventListener('click', () => { userMoved = false; load(true); });
  document.getElementById('graph-attention').addEventListener('change', () => { userMoved = false; kick(); });
  document.getElementById('graph-clusters').addEventListener('change', () => { userMoved = false; kick(); });
  document.getElementById('graph-filter').addEventListener('input', () => { if (!raf) render(); });
  svg.addEventListener('click', () => {
    if (squelchClick) { squelchClick = false; return; }
    selected = null; hideCard();
  });
  window.addEventListener('resize', () => { if (!document.getElementById('graph-view').hidden) kick(); });

  window.showGraph = show;
})();
