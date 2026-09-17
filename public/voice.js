/* 右下角口播: 麦 → cockpit /ws/asr → Fun-ASR /ws/dictate → 填进输入框。 */
(function () {
  const $ = (s) => document.querySelector(s);
  const PLACEHOLDER = 'Enter 发送 · Shift+Enter 换行 · / 命令 · @ 临时换模型 · 可粘贴图片';
  const btn = $('#btn-mic');
  const input = $('#input');
  if (!btn || !input) return;

  let on = false;
  let ws = null;
  let audio = {};
  let spans = new Map();
  let recRetry = 0;

  function setTitle(s) { btn.title = s || '语音输入 · Fun-ASR'; }

  function gluePrefix(cur) {
    if (!cur) return '';
    return /\s$/.test(cur) ? '' : ' ';
  }

  function applySeg(id, text) {
    const body = String(text || '').trim();
    if (!body) return;
    if (spans.has(id)) {
      applyUpd(id, body);
      return;
    }
    const glue = gluePrefix(input.value);
    const start = input.value.length + glue.length;
    input.value += glue + body;
    spans.set(id, { start, len: body.length });
    input.dispatchEvent(new Event('input'));
    input.scrollTop = input.scrollHeight;
  }

  function applyUpd(id, text) {
    const body = String(text || '').trim();
    if (!body) return;
    const sp = spans.get(id);
    if (!sp) {
      applySeg(id, body);
      return;
    }
    const before = input.value.slice(0, sp.start);
    const after = input.value.slice(sp.start + sp.len);
    input.value = before + body + after;
    const delta = body.length - sp.len;
    sp.len = body.length;
    for (const o of spans.values()) {
      if (o.start > sp.start) o.start += delta;
    }
    input.dispatchEvent(new Event('input'));
  }

  function onEvt(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'err') {
      setTitle(d.msg || '识别出错');
      stop();
      return;
    }
    if (d.t === 'ready') {
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ t: 'cfg', language: 'auto', mode: 'raw', hotwords: [] }));
      }
      return;
    }
    if (d.t === 'seg') applySeg(d.id, d.fixed || d.text);
    else if (d.t === 'upd') applyUpd(d.id, d.fixed || d.text);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws/asr`);
    const old = ws;
    ws = sock;
    try { if (old && old !== sock) old.close(); } catch { /* ignore */ }
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => { recRetry = 0; };
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try { onEvt(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    sock.onclose = () => {
      if (ws !== sock || !on) return;
      recRetry = Math.min(8000, (recRetry || 400) * 2);
      setTitle('连接断了，正在重连…');
      setTimeout(() => { if (on) connect(); }, recRetry);
    };
  }

  async function startMic() {
    if (!audio.stream) {
      audio.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    }
    if (!audio.ctx || audio.ctx.state === 'closed') {
      audio.ctx = new AudioContext({ sampleRate: 16000 });
    }
    if (audio.ctx.state === 'suspended') await audio.ctx.resume();
    connect();
    if (!audio.node) {
      const src = audio.ctx.createMediaStreamSource(audio.stream);
      const node = audio.ctx.createScriptProcessor(4096, 1, 1);
      const mute = audio.ctx.createGain();
      mute.gain.value = 0;
      node.onaudioprocess = (ev) => {
        if (ws?.readyState === 1) {
          ws.send(new Float32Array(ev.inputBuffer.getChannelData(0)).buffer);
        }
      };
      src.connect(node);
      node.connect(mute);
      mute.connect(audio.ctx.destination);
      audio.node = node;
      audio.src = src;
      audio.mute = mute;
    }
  }

  async function start() {
    const st = await (await fetch('/api/asr')).json();
    if (!st.ok) {
      setTitle(st.error || '试听台没开');
      return;
    }
    if (st.recording) {
      setTitle('试听台正在听课');
      return;
    }
    on = true;
    spans = new Map();
    btn.classList.add('on');
    input.dataset.ph = input.placeholder;
    input.placeholder = '正在听，说完停顿一下…';
    setTitle('点击停止');
    try {
      await startMic();
    } catch (e) {
      setTitle('麦克风打不开：' + (e.message || e));
      stop();
    }
  }

  function stop() {
    on = false;
    btn.classList.remove('on');
    input.placeholder = input.dataset.ph || PLACEHOLDER;
    if (ws?.readyState === 1) {
      try { ws.send(JSON.stringify({ t: 'stop' })); } catch { /* ignore */ }
    }
    try { audio.node?.disconnect(); } catch { /* ignore */ }
    try { audio.mute?.disconnect(); } catch { /* ignore */ }
    try { audio.src?.disconnect(); } catch { /* ignore */ }
    try { audio.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { audio.ctx?.close(); } catch { /* ignore */ }
    const sock = ws;
    setTimeout(() => { try { sock?.close(); } catch { /* ignore */ } }, 2500);
    audio = {};
    ws = null;
    if (!btn.title || btn.title === '点击停止' || btn.title.startsWith('连接断了')) {
      setTitle('语音输入 · Fun-ASR');
    }
  }

  btn.addEventListener('click', () => { if (on) stop(); else start(); });
})();
