import { spawn } from 'child_process';

// macOS sleeps aggressively on battery (this machine: sleep after 1 min idle),
// which kills a streaming response mid-flight. Hold a caffeinate assertion while
// work is in flight, and expose a manual hold for long unattended runs.
//   -i 阻止闲置休眠 · -m 阻止磁盘休眠 · -s 阻止系统休眠（仅接电源时有效）
const FLAGS = ['-i', '-m', '-s'];

let autoProc = null;      // held while chats are running
let manualProc = null;    // held by the user for a fixed span
let manualUntil = 0;
let manualTimer = null;

function start(reason) {
  try {
    const p = spawn('caffeinate', FLAGS, { stdio: 'ignore', detached: false });
    p.on('error', () => {});
    return p;
  } catch { return null; }
}

function stop(p) {
  if (!p) return;
  try { p.kill('SIGTERM'); } catch { /* already gone */ }
}

/** Called whenever the number of running chats changes. */
export function setBusy(busy) {
  if (busy && !autoProc) autoProc = start('chat');
  else if (!busy && autoProc) { stop(autoProc); autoProc = null; }
}

export function holdAwake(hours) {
  releaseAwake();
  const h = Math.max(0, Math.min(12, Number(hours) || 0));
  if (!h) return status();
  manualProc = start('manual');
  manualUntil = Date.now() + h * 3600 * 1000;
  manualTimer = setTimeout(releaseAwake, h * 3600 * 1000);
  return status();
}

export function releaseAwake() {
  if (manualTimer) { clearTimeout(manualTimer); manualTimer = null; }
  stop(manualProc);
  manualProc = null;
  manualUntil = 0;
  return status();
}

export function status() {
  return {
    auto: !!autoProc,
    manual: !!manualProc,
    manualUntil: manualUntil || null,
    minutesLeft: manualUntil ? Math.max(0, Math.round((manualUntil - Date.now()) / 60000)) : 0,
  };
}
