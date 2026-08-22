import os from 'os';
import pty from 'node-pty';
import ssh2 from 'ssh2';

// Local PTY running the user's shell. Optional cmd is auto-typed after spawn.
export function openLocalTerm({ cols, rows, cwd, cmd }, { onData, onExit, onError }) {
  const shell = process.env.SHELL || '/bin/zsh';
  let p;
  try {
    p = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: process.env,
    });
  } catch (err) {
    onError(String(err));
    return null;
  }
  p.onData(onData);
  p.onExit(({ exitCode }) => onExit(exitCode));
  if (cmd) setTimeout(() => { try { p.write(cmd + '\r'); } catch { /* closed */ } }, 300);
  return {
    write: (d) => p.write(d),
    resize: (c, r) => { try { p.resize(c, r); } catch { /* closed */ } },
    close: () => { try { p.kill(); } catch { /* closed */ } },
  };
}

// Remote shell over SSH (password auth supported — for servers without pubkey).
export function openSshTerm({ cols, rows, ssh, cmd }, { onData, onExit, onError }) {
  const conn = new ssh2.Client();
  let stream = null;
  let closed = false;

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, s) => {
      if (err) { onError('shell: ' + err.message); conn.end(); return; }
      stream = s;
      s.on('data', (d) => onData(d.toString('utf8')));
      s.stderr.on('data', (d) => onData(d.toString('utf8')));
      s.on('close', () => { if (!closed) { closed = true; onExit(0); } conn.end(); });
      if (cmd) setTimeout(() => { try { s.write(cmd + '\r'); } catch { /* closed */ } }, 300);
    });
  });
  conn.on('error', (err) => onError(err.message));
  conn.on('close', () => { if (!closed) { closed = true; onExit(0); } });

  try {
    conn.connect({
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.username,
      password: ssh.password,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
    });
  } catch (err) {
    onError(String(err));
    return null;
  }

  return {
    write: (d) => { if (stream) stream.write(d); },
    resize: (c, r) => { if (stream) { try { stream.setWindow(r, c, 0, 0); } catch { /* closed */ } } },
    close: () => { closed = true; try { conn.end(); } catch { /* closed */ } },
  };
}
