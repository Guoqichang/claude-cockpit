/* Icon library shared by the graph nodes and the sidebar chips.
   Every icon is hand-drawn in a -12..12 box as a list of shapes:
     { p: 'path data' }            stroked path
     { p: '...', f: 1 }            filled path
     { c: [cx, cy, r], f?: 1 }     circle
   optional per-shape: w (stroke width), o (opacity).
   The server decides WHICH icon a session gets (lib/graph.js pickIcon);
   this file only knows how to draw them. */
'use strict';

window.CockpitIcons = (function () {
  const NS = 'http://www.w3.org/2000/svg';

  const ICONS = {
    // 量化 / 交易：三根上升的 K 线（带影线的实体蜡烛）
    quant: [
      { p: 'M-7,9.5 V-3' }, { p: 'M-8.7,-1 h3.4 v7 h-3.4 Z', f: 1 },
      { p: 'M0,6 V-7.5' }, { p: 'M-1.7,-5.5 h3.4 v8.5 h-3.4 Z', f: 1 },
      { p: 'M7,1.5 V-11' }, { p: 'M5.3,-9 h3.4 v7 h-3.4 Z', f: 1 },
    ],
    // 财务：¥ 硬币
    finance: [
      { c: [0, 0, 9.6] },
      { p: 'M-3.6,-5 L0,-0.8 L3.6,-5' },
      { p: 'M0,-0.8 V5.6' },
      { p: 'M-3.4,1.2 H3.4' }, { p: 'M-3.4,3.8 H3.4' },
    ],
    // 代码：</> 尖括号加斜杠
    code: [
      { p: 'M-4.6,-5.4 L-10,0 L-4.6,5.4' },
      { p: 'M4.6,-5.4 L10,0 L4.6,5.4' },
      { p: 'M2.2,-8.2 L-2.2,8.2' },
    ],
    // 网页 / 前端：浏览器窗口
    web: [
      { p: 'M-8.5,-8 H8.5 Q10.5,-8 10.5,-6 V6 Q10.5,8 8.5,8 H-8.5 Q-10.5,8 -10.5,6 V-6 Q-10.5,-8 -8.5,-8 Z' },
      { p: 'M-10.5,-3.6 H10.5' },
      { c: [-8, -5.8, 0.95], f: 1 }, { c: [-5.2, -5.8, 0.95], f: 1 },
      { p: 'M-6.5,0.5 H6.5' }, { p: 'M-6.5,4 H1.5' },
    ],
    // 数据分析：坐标轴 + 柱状图
    data: [
      { p: 'M-9.5,-10 V9.5 H10' },
      { p: 'M-6,9.5 v-5.5 h3.6 v5.5 Z', f: 1 },
      { p: 'M-0.6,9.5 v-9.5 h3.6 v9.5 Z', f: 1 },
      { p: 'M4.8,9.5 v-13.5 h3.6 v13.5 Z', f: 1 },
    ],
    // 文档 / 写作：折角纸页
    doc: [
      { p: 'M-7,-10 H3 L8,-5 V10 H-7 Z' },
      { p: 'M3,-10 V-5 H8' },
      { p: 'M-3.8,-1.5 H4.8' }, { p: 'M-3.8,2 H4.8' }, { p: 'M-3.8,5.5 H1.5' },
    ],
    // 数学：求和号 Σ
    math: [
      { p: 'M7,-9 H-6.8 L1.6,0 L-6.8,9 H7' },
      { p: 'M7,-9 V-6.6' }, { p: 'M7,9 V6.6' },
    ],
    // AI / 模型：三层神经网络
    ai: [
      { p: 'M-6.1,-6 L-0.6,-3.4 M-6.1,-6 L-0.6,3.4 M-6.1,0 L-0.6,-3.4 M-6.1,0 L-0.6,3.4 M-6.1,6 L-0.6,-3.4 M-6.1,6 L-0.6,3.4 M3.4,-3 L6.9,-0.5 M3.4,3 L6.9,0.5', o: 0.55, w: 1.2 },
      { c: [-8, -6, 1.9], f: 1 }, { c: [-8, 0, 1.9], f: 1 }, { c: [-8, 6, 1.9], f: 1 },
      { c: [1.4, -3.4, 1.9], f: 1 }, { c: [1.4, 3.4, 1.9], f: 1 },
      { c: [8.9, 0, 2.1], f: 1 },
    ],
    // 消息 / IM：对话气泡
    chat: [
      { p: 'M-8.5,-8.5 H8.5 Q10.5,-8.5 10.5,-6.5 V2.5 Q10.5,4.5 8.5,4.5 H-1.5 L-6.5,9.5 V4.5 H-8.5 Q-10.5,4.5 -10.5,2.5 V-6.5 Q-10.5,-8.5 -8.5,-8.5 Z' },
      { c: [-4.5, -2, 1.25], f: 1 }, { c: [0, -2, 1.25], f: 1 }, { c: [4.5, -2, 1.25], f: 1 },
    ],
    // 服务器 / 运维：双层机架
    server: [
      { p: 'M-9,-8.5 H9 Q10.5,-8.5 10.5,-7 V-2.5 Q10.5,-1 9,-1 H-9 Q-10.5,-1 -10.5,-2.5 V-7 Q-10.5,-8.5 -9,-8.5 Z' },
      { p: 'M-9,1 H9 Q10.5,1 10.5,2.5 V7 Q10.5,8.5 9,8.5 H-9 Q-10.5,8.5 -10.5,7 V2.5 Q-10.5,1 -9,1 Z' },
      { c: [-7, -4.75, 1.15], f: 1 }, { c: [-7, 4.75, 1.15], f: 1 },
      { p: 'M-1,-4.75 H7.5' }, { p: 'M-1,4.75 H7.5' },
    ],
    // 手机 / 移动端
    mobile: [
      { p: 'M-5.5,-10.5 H5.5 Q7.2,-10.5 7.2,-8.8 V8.8 Q7.2,10.5 5.5,10.5 H-5.5 Q-7.2,10.5 -7.2,8.8 V-8.8 Q-7.2,-10.5 -5.5,-10.5 Z' },
      { p: 'M-2,-7.8 H2' },
      { c: [0, 7.4, 1.15], f: 1 },
    ],
    // 音频 / 语音：波形
    audio: [
      { p: 'M-9,-2.8 V2.8', w: 2.3 }, { p: 'M-5.4,-5.5 V5.5', w: 2.3 },
      { p: 'M-1.8,-9 V9', w: 2.3 }, { p: 'M1.8,-4.5 V4.5', w: 2.3 },
      { p: 'M5.4,-7 V7', w: 2.3 }, { p: 'M9,-2.2 V2.2', w: 2.3 },
    ],
    // 视频：播放器
    video: [
      { p: 'M-8.5,-7 H8.5 Q10.5,-7 10.5,-5 V5 Q10.5,7 8.5,7 H-8.5 Q-10.5,7 -10.5,5 V-5 Q-10.5,-7 -8.5,-7 Z' },
      { p: 'M-2.4,-3.4 L3.8,0 L-2.4,3.4 Z', f: 1 },
    ],
    // 法律：天平
    legal: [
      { p: 'M0,-8.5 V8' }, { p: 'M-4.5,9.5 H4.5' }, { p: 'M-8,-6 H8' },
      { c: [0, -9.3, 1.1], f: 1 },
      { p: 'M-8,-6 L-10.8,0 M-8,-6 L-5.2,0' }, { p: 'M-10.8,0 A2.9,2.9 0 0 0 -5.2,0' },
      { p: 'M8,-6 L5.2,0 M8,-6 L10.8,0' }, { p: 'M5.2,0 A2.9,2.9 0 0 0 10.8,0' },
    ],
    // 医疗：心电 + 十字
    medical: [
      { p: 'M-10.5,1.5 H-5.5 L-3.2,-3.5 L0.2,7.5 L2.8,-0.5 L4.2,1.5 H7' },
      { p: 'M8.3,-9.8 V-4.6 M5.7,-7.2 H10.9', w: 2.1 },
    ],
    // 设计：贝塞尔曲线编辑
    design: [
      { p: 'M-9,6.5 C-4.5,-7.5 4.5,-7.5 9,6.5' },
      { p: 'M-9,6.5 L-5.4,-2.4', o: 0.5, w: 1.2 }, { p: 'M9,6.5 L5.4,-2.4', o: 0.5, w: 1.2 },
      { c: [-5.4, -2.4, 1.3] }, { c: [5.4, -2.4, 1.3] },
      { p: 'M-10.3,5.2 h2.7 v2.7 h-2.7 Z', f: 1 }, { p: 'M7.6,5.2 h2.7 v2.7 h-2.7 Z', f: 1 },
    ],
    // 日程 / 会议：日历
    calendar: [
      { p: 'M-9,-7.5 H9 Q10.6,-7.5 10.6,-5.9 V7.9 Q10.6,9.5 9,9.5 H-9 Q-10.6,9.5 -10.6,7.9 V-5.9 Q-10.6,-7.5 -9,-7.5 Z' },
      { p: 'M-5,-10.5 V-4.8 M5,-10.5 V-4.8' },
      { p: 'M-10.6,-1.8 H10.6' },
      { c: [-5, 3, 1.1], f: 1 }, { c: [0, 3, 1.1], f: 1 }, { c: [5, 3, 1.1], f: 1 },
      { c: [-5, 6.6, 1.1], f: 1 }, { c: [0, 6.6, 1.1], f: 1 },
    ],
    // 研究 / 搜索：放大镜
    search: [
      { c: [-2.6, -2.6, 6.4] },
      { p: 'M2.1,2.1 L9.4,9.4', w: 2.4 },
    ],
    // 游戏：手柄
    game: [
      { p: 'M-5,-4.5 H5 Q11,-4.5 11,1.5 Q11,6.8 7.6,6.8 Q5.4,6.8 4,4.2 H-4 Q-5.4,6.8 -7.6,6.8 Q-11,6.8 -11,1.5 Q-11,-4.5 -5,-4.5 Z' },
      { p: 'M-6.5,-1.2 V3.2 M-8.7,1 H-4.3' },
      { c: [5.2, -0.6, 1.2], f: 1 }, { c: [7.8, 1.9, 1.2], f: 1 },
    ],
    // 终端 / CLI：>_
    term: [
      { p: 'M-8.5,-8 H8.5 Q10.5,-8 10.5,-6 V6 Q10.5,8 8.5,8 H-8.5 Q-10.5,8 -10.5,6 V-6 Q-10.5,-8 -8.5,-8 Z' },
      { p: 'M-6.2,-2.8 L-2.4,0.6 L-6.2,4' },
      { p: 'M0.5,4.4 H6.3' },
    ],
    // 邮件：信封
    mail: [
      { p: 'M-9.5,-6.5 H9.5 Q11,-6.5 11,-5 V5 Q11,6.5 9.5,6.5 H-9.5 Q-11,6.5 -11,5 V-5 Q-11,-6.5 -9.5,-6.5 Z' },
      { p: 'M-10,-5.2 L0,1.8 L10,-5.2' },
    ],
    // 旅行：纸飞机
    travel: [
      { p: 'M10.5,-8.5 L-10.5,-0.6 L-2.6,2.4 L-1.2,9.5 L2.6,4.4 L10.5,-8.5 Z' },
      { p: 'M10.5,-8.5 L-2.6,2.4', o: 0.6, w: 1.3 },
    ],
    // 通用兜底（按会话 id 哈希取一个，保证彼此不同）
    g0: [{ p: 'M0,-9.6 L8.3,-4.8 V4.8 L0,9.6 L-8.3,4.8 V-4.8 Z' }, { c: [0, 0, 1.7], f: 1 }],
    g1: [{ c: [0, 0, 9.4] }, { p: 'M0,-4.6 L4.4,3 H-4.4 Z' }],
    g2: [{ c: [0, -5, 3.4] }, { c: [5, 0, 3.4] }, { c: [0, 5, 3.4] }, { c: [-5, 0, 3.4] }],
    g3: [{ p: 'M0.5,0.5 Q3.5,0.5 3.5,-2.5 Q3.5,-6 -0.5,-6 Q-6,-6 -6,-1 Q-6,5.5 1,5.5 Q8.5,5.5 8.5,-2.5' }],
    g4: [{ p: 'M0,-9.5 L6.4,-3.1 L0,3.3 L-6.4,-3.1 Z' }, { p: 'M-6.4,2.6 L0,9 L6.4,2.6' }],
    g5: [{ p: 'M2.6,-9.4 A9.4,9.4 0 1 0 2.6,9.4 A7.2,7.2 0 1 1 2.6,-9.4 Z', f: 1, o: 0.8 }],
    g6: [{ c: [-5, 5.5, 1.6], f: 1 }, { p: 'M-5,-1.3 A6.8,6.8 0 0 1 1.8,5.5' }, { p: 'M-5,-5 A10.5,10.5 0 0 1 5.5,5.5' }],
    g7: [{ p: 'M0,-9.8 L2.4,-3.3 L9.3,-3 L3.9,1.3 L5.7,7.9 L0,4.1 L-5.7,7.9 L-3.9,1.3 L-9.3,-3 L-2.4,-3.3 Z' }],
  };

  function defOf(key) { return ICONS[key] || ICONS.g0; }

  /* Graph nodes: append the icon as SVG-NS children, scaled to node radius r. */
  function appendTo(parent, key, r, opts = {}) {
    const stroke = opts.stroke || 'rgba(18,13,6,.62)';
    const s = r / 21;                       // 24-unit box spans ≈ 1.15 r
    const baseW = Math.max(1.9, 30 / r);    // thin strokes vanish on small nodes
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `scale(${s.toFixed(3)})`);
    g.setAttribute('pointer-events', 'none');
    for (const sh of defOf(key)) {
      let node;
      if (sh.c) {
        node = document.createElementNS(NS, 'circle');
        node.setAttribute('cx', sh.c[0]); node.setAttribute('cy', sh.c[1]); node.setAttribute('r', sh.c[2]);
      } else {
        node = document.createElementNS(NS, 'path');
        node.setAttribute('d', sh.p);
      }
      if (sh.f) {
        node.setAttribute('fill', stroke);
        node.setAttribute('stroke', 'none');
      } else {
        node.setAttribute('fill', 'none');
        node.setAttribute('stroke', stroke);
        node.setAttribute('stroke-width', sh.w || baseW);
        node.setAttribute('stroke-linecap', 'round');
        node.setAttribute('stroke-linejoin', 'round');
      }
      if (sh.o) node.setAttribute('opacity', sh.o);
      g.appendChild(node);
    }
    parent.appendChild(g);
    return g;
  }

  /* Sidebar chips: a colored disc with the icon on top, as an HTML string. */
  function html(key, px, color) {
    const parts = [`<circle r="11.3" fill="${color || '#38332b'}"/>`];
    if (key) {
      const stroke = 'rgba(15,11,6,.72)';
      for (const sh of defOf(key)) {
        const op = sh.o ? ` opacity="${sh.o}"` : '';
        if (sh.c) {
          parts.push(sh.f
            ? `<circle cx="${sh.c[0]}" cy="${sh.c[1]}" r="${sh.c[2]}" fill="${stroke}"${op}/>`
            : `<circle cx="${sh.c[0]}" cy="${sh.c[1]}" r="${sh.c[2]}" fill="none" stroke="${stroke}" stroke-width="${sh.w || 2.1}"${op}/>`);
        } else {
          parts.push(sh.f
            ? `<path d="${sh.p}" fill="${stroke}"${op}/>`
            : `<path d="${sh.p}" fill="none" stroke="${stroke}" stroke-width="${sh.w || 2.1}" stroke-linecap="round" stroke-linejoin="round"${op}/>`);
        }
      }
    }
    return `<svg viewBox="-13 -13 26 26" width="${px}" height="${px}" aria-hidden="true">${parts.join('')}</svg>`;
  }

  return { appendTo, html };
})();
