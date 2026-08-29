/* Session graph: a live map of every session.
   Size = volume × recency, color = cluster, ring = state, and the whole thing
   re-lays out when you switch to attention mode. Force sim is hand-rolled —
   150 nodes does not justify a dependency. */
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
  let view = { x: 0, y: 0, k: 1 };
  let pollTimer = null;

  const el = (name, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // ---------- visual encoding ----------
  const hashInt = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return Math.abs(h);
  };

  // cluster picks the hue family, the id varies lightness inside it, so a glance
  // shows both "which topic" and "which session"
  function nodeColor(n) {
    const clusters = Math.max(1, data.clusters.length);
    const hue = Math.round((n.cluster * 360) / clusters + (n.cluster % 3) * 17) % 360;
    const light = 46 + (hashInt(n.id) % 22);
    const sat = n.state === 'cold' ? 22 : 58;
    return `hsl(${hue} ${sat}% ${light}%)`;
  }

  function radius(n) {
    const vol = Math.log2((n.msgCount || 4) + 2);          // 轮数
    const fresh = 1 + 1.15 * Math.max(0, 1 - n.ageHours / 72);  // 越新越大
    const base = 5 + vol * 2.1 * fresh;
    return Math.max(6, Math.min(34, base));
  }

  const stateOf = (n) => n.state;

  // tiny deterministic glyph so each node is recognisable beyond colour
  function glyph(n, r) {
    const g = el('g', { class: 'glyph', 'pointer-events': 'none' });
    if (r < 11) return g;
    const h = hashInt(n.id + 'g');
    const kind = h % 5;
    const s = r * 0.42;
    const stroke = { stroke: 'rgba(0,0,0,.45)', 'stroke-width': 1.4, fill: 'none', 'stroke-linecap': 'round' };
    if (kind === 0) g.appendChild(el('path', { d: `M${-s},0 L0,${-s} L${s},0 L0,${s} Z`, ...stroke }));
    else if (kind === 1) g.appendChild(el('path', { d: `M${-s},${-s} L${s},${s} M${-s},${s} L${s},${-s}`, ...stroke }));
    else if (kind === 2) g.appendChild(el('circle', { r: s * 0.8, ...stroke }));
    else if (kind === 3) g.appendChild(el('path', { d: `M${-s},${s * .6} L0,${-s} L${s},${s * .6} Z`, ...stroke }));
    else g.appendChild(el('path', { d: `M${-s},0 H${s} M0,${-s} V${s}`, ...stroke }));
    return g;
  }

  // ---------- layout ----------
  function seedSim() {
    const W = stage.clientWidth || 900, H = stage.clientHeight || 600;
    // sunflower placement fills the whole canvas; a plain ring left the middle
    // empty and crushed everything against the edges
    const byCluster = new Map();
    const order = data.clusters.map((c, i) => i).sort((a, b) => data.clusters[b].size - data.clusters[a].size);
    const N = Math.max(1, order.length);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const mx = 70, my = 60;
    order.forEach((ci, rank) => {
      const t = (rank + 0.5) / N;
      const rad = Math.sqrt(t);                     // big clusters land near the centre
      const ang = rank * golden;
      byCluster.set(ci, {
        x: W / 2 + Math.cos(ang) * rad * (W / 2 - mx),
        y: H / 2 + Math.sin(ang) * rad * (H / 2 - my),
      });
    });
    sim = data.nodes.map((n, i) => {
      const anchor = byCluster.get(n.cluster) || { x: W / 2, y: H / 2 };
      const prev = sim[i] && sim[i].id === n.id ? sim[i] : null;
      return {
        id: n.id, n,
        x: prev ? prev.x : anchor.x + (hashInt(n.id) % 120) - 60,
        y: prev ? prev.y : anchor.y + (hashInt(n.id + 'y') % 120) - 60,
        vx: 0, vy: 0, r: radius(n), anchor,
      };
    });
    ticks = 0;
  }

  function step() {
    const W = stage.clientWidth || 900, H = stage.clientHeight || 600;
    const attention = document.getElementById('graph-attention').checked;
    const grouped = document.getElementById('graph-clusters').checked;
    const cx = W / 2, cy = H / 2;
    const maxAtt = Math.max(1, ...data.nodes.map(n => n.attention));

    for (const b of sim) {
      let tx, ty;
      if (attention) {
        // rank (not raw score) sets the distance: scores bunch up at the low end,
        // which would pack almost everything into one ring
        const t = (b.rank + 0.5) / sim.length;
        const ang = b.rank * 2.399963;               // golden angle keeps rings from forming
        const rad = Math.sqrt(t) * Math.min(W, H) * 0.47 + 26;
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
        const min = a.r + b.r + 6;
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
      b.x = Math.max(b.r + 4, Math.min(W - b.r - 4, b.x));
      b.y = Math.max(b.r + 4, Math.min(H - b.r - 4, b.y));
    }
  }

  // ---------- render ----------
  function render() {
    const q = document.getElementById('graph-filter').value.trim().toLowerCase();
    svg.setAttribute('viewBox', `0 0 ${stage.clientWidth || 900} ${stage.clientHeight || 600}`);
    svg.innerHTML = '';

    const gRoot = el('g');
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
    const ranked = [...sim].sort((a, b) => (b.n.attention + b.r * 2) - (a.n.attention + a.r * 2));
    for (const b of ranked) {
      if (wantsLabel.size >= 26 && selected !== b.n.id) continue;
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

      if (n.state === 'running') g.appendChild(el('circle', { r: b.r + 7, class: 'ring-run' }));
      if (n.goal) g.appendChild(el('circle', { r: b.r + 4, class: 'ring-goal' }));
      if (n.loop) g.appendChild(el('circle', { r: b.r + 4, class: 'ring-loop' }));
      if (n.state === 'error') g.appendChild(el('circle', { r: b.r + 4, class: 'ring-err' }));
      if (n.state === 'open') g.appendChild(el('circle', { r: b.r + 3, class: 'ring-open' }));

      g.appendChild(el('circle', { r: b.r, fill: nodeColor(n), class: 'body' }));
      g.appendChild(glyph(n, b.r));

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
    if (ticks < 600) { step(); ticks++; }
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
        <span class="gc-engine ${n.engine}">${n.engine === 'cursor' ? 'CR' : 'CC'}</span></div>
      <div class="gc-meta">${n.msgCount == null ? '长会话' : n.msgCount + ' 条'} ·
        ${fmtAge(n.ageHours)} · 注意力 ${n.attention}${n.lastCost != null ? ' · $' + n.lastCost.toFixed(3) : ''}</div>
      <div class="gc-cwd">${escapeHtml(n.cwd || '')}</div>
      ${rows.join('')}
      <div class="gc-actions"><button class="gc-open">进入对话</button>${pin ? '<button class="gc-close">关闭</button>' : ''}</div>`;
    card.hidden = false;
    const W = stage.clientWidth, H = stage.clientHeight;
    const left = Math.min(Math.max(8, b.x + b.r + 12), W - 300);
    const top = Math.min(Math.max(8, b.y - 40), H - 190);
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
      <div class="lg-note">大小 = 轮数 × 新鲜度 · 颜色 = 聚类</div>`;
  }

  async function load(reseed = true) {
    try {
      const r = await fetch('/api/graph');
      const d = await r.json();
      if (d.error) return;
      data = d;
      if (reseed || sim.length !== data.nodes.length) seedSim();
      else sim.forEach((b, i) => { b.n = data.nodes[i]; b.r = radius(data.nodes[i]); });
      const byAtt = [...data.nodes].sort((a, b) => b.attention - a.attention).map(n => n.id);
      const rankOf = new Map(byAtt.map((id, i) => [id, i]));
      for (const b of sim) b.rank = rankOf.get(b.id) ?? sim.length - 1;
      renderLegend();
      kick();
    } catch { /* server busy; next poll retries */ }
  }

  // ---------- wiring ----------
  function show() {
    if (typeof window.switchView === 'function') window.switchView('graph');
    load(true);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.getElementById('graph-view').hidden) { clearInterval(pollTimer); return; }
      load(false);
    }, 5000);
  }

  document.getElementById('btn-graph').addEventListener('click', show);
  document.getElementById('btn-open-graph').addEventListener('click', show);
  document.getElementById('graph-refresh').addEventListener('click', () => load(true));
  document.getElementById('graph-attention').addEventListener('change', kick);
  document.getElementById('graph-clusters').addEventListener('change', kick);
  document.getElementById('graph-filter').addEventListener('input', () => { if (!raf) render(); });
  svg.addEventListener('click', () => { selected = null; hideCard(); });
  window.addEventListener('resize', () => { if (!document.getElementById('graph-view').hidden) kick(); });

  window.showGraph = show;
})();
