import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import pty from 'node-pty';
import { randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { tailscaleIP, tailscaleTLS, lanIPs } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.TTY_PORT ? parseInt(process.env.TTY_PORT, 10) : 8788;
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.CMD_REMOTE_TOKEN || null;
const WORK_DIR = process.env.WORK_DIR || process.cwd();

const CMD_ENTRY = process.env.CMD_ENTRY || resolveCmdEntry();
function resolveCmdEntry() {
  const npmPrefix = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null;
  const shim = npmPrefix && path.join(npmPrefix, 'cmd.cmd');
  if (shim) {
    try {
      const contents = fs.readFileSync(shim, 'utf8');
      const m = contents.match(/"([^"]*command-code[\\/]dist[\\/]index\.mjs)"/);
      if (m) return m[1].replace('%dp0%', npmPrefix);
    } catch {}
  }
  return 'cmd';
}

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch { return false; }
}
function authOk(req) {
  if (!TOKEN) return true;
  const header = req.headers['authorization'] || '';
  const urlToken = new URL(req.url, 'http://x').searchParams.get('token');
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7) : '';
  return (fromHeader && safeEqual(fromHeader, TOKEN)) || (urlToken && safeEqual(urlToken, TOKEN));
}

const app = express();
app.get('/', (req, res) => {
  if (!authOk(req)) return res.status(401).send('Unauthorized');
  res.sendFile(path.join(__dirname, 'public', 'tty.html'));
});
// Only static *assets* are public (xterm.js/css, icons, manifest). The HTML
// pages carry no secrets, but gate them anyway to avoid serving them unauthenticated.
app.get(['/index.html', '/panel.html', '/tty.html'], (req, res) => {
  if (!authOk(req)) return res.status(401).send('Unauthorized');
  res.sendFile(path.join(__dirname, 'public', path.basename(req.path)));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const tls = tailscaleTLS();
let server;
if (tls) {
  server = createHttpsServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, app);
  console.log('HTTPS enabled via Tailscale cert:', tls.host);
} else {
  server = createServer(app);
}
const wss = new WebSocketServer({ server, path: '/ws' });
// Sessions survive socket disconnects: the PTY keeps running in the
// background and buffers output so a reconnecting client can reattach.
const sessions = new Map(); // id -> { id, proc, ws, buffer, lastActive }

function replayBuffer(s, ws) {
  if (!s.buffer) return;
  // Chunk so a large replay doesn't block the socket.
  const chunk = 8192;
  for (let i = 0; i < s.buffer.length; i += chunk) {
    const part = s.buffer.slice(i, i + chunk);
    ws.send(JSON.stringify({ type: 'output', data: part }));
  }
}

wss.on('connection', (ws, req) => {
  if (!authOk(req)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  const url = new URL(req.url, 'http://x');
  const wanted = url.searchParams.get('session') || '';
  const id = randomUUID();
  let s = wanted && sessions.get(wanted);

  if (s && s.proc && !s.exited) {
    // Reattach to an existing background PTY.
    s.ws = ws;
    s.lastActive = Date.now();
    ws.send(JSON.stringify({ type: 'hello', session: s.id, replay: true }));
    replayBuffer(s, ws);
    // Let the client know the current size so it can send a resize.
    ws.send(JSON.stringify({ type: 'size', cols: s.cols, rows: s.rows }));
  } else {
    // New independent PTY (or stale session id -> fresh one).
    // Start Command Code with --yolo: bypasses all permission prompts so
    // commands run without asking (full access by default).
    const proc = pty.spawn(process.execPath, [CMD_ENTRY, '--yolo'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: WORK_DIR,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    });
    s = { id, proc, ws, buffer: '', cols: 100, rows: 30, createdAt: Date.now(), lastActive: Date.now(), exited: false };
    sessions.set(id, s);
    ws.send(JSON.stringify({ type: 'hello', session: id, replay: false }));
    ws.send(JSON.stringify({ type: 'size', cols: s.cols, rows: s.rows }));
    proc.onData((data) => {
      s.buffer = (s.buffer + data).slice(-262144); // keep last 256 KB
      if (s.ws && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ type: 'output', data }));
      }
    });
    proc.onExit(() => {
      s.exited = true;
      sessions.delete(s.id);
      if (s.ws && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ type: 'exit' }));
      }
    });
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'input') {
        if (s.proc) s.proc.write(msg.data);
      } else if (msg.type === 'resize') {
        if (s.proc) s.proc.resize(msg.cols, msg.rows);
        s.cols = msg.cols; s.rows = msg.rows;
      } else if (msg.type === 'end') {
        // Tab closed: kill this session only.
        try { s.proc.kill(); } catch {}
        sessions.delete(s.id);
        if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.close();
      }
    } catch {
      try { if (s.proc) s.proc.write(data.toString()); } catch {}
    }
  });
  ws.on('close', () => {
    // Detach, do NOT kill — the PTY keeps running in the background.
    if (s && s.ws === ws) s.ws = null;
    if (s) s.lastActive = Date.now();
  });
});

// Tab reconciliation: list live background sessions (auth-gated).
app.get('/api/tty/sessions', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const list = [];
  for (const s of sessions.values()) {
    if (s.proc && !s.exited) {
      list.push({ id: s.id, createdAt: s.createdAt || null, lastActive: s.lastActive || Date.now() });
    }
  }
  res.json({ sessions: list });
});

// End a session (tab closed) — works for attached AND background sessions.
app.post('/api/tty/sessions/:id/end', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.params.id;
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return res.status(400).json({ error: 'invalid session id' });
  const s = sessions.get(id);
  if (s) {
    try { s.proc.kill(); } catch {}
    sessions.delete(s.id);
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.close();
  }
  res.json({ ok: true });
});

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

server.listen(PORT, HOST, () => {
  const proto = tls ? 'https' : 'http';
  console.log(`cmd-remote TTY listening (${proto})`);
  console.log(`  Local: ${proto}://localhost:${PORT}`);
  for (const ip of lanIPs()) {
    console.log(`  LAN:   ${proto}://${ip}:${PORT}`);
  }
  const ts = tailscaleIP();
  const host = tls ? tls.host : ts;
  if (host) {
    console.log(`  ANYWHERE (Tailscale): ${proto}://${host}:${PORT}/?token=${TOKEN || '<token>'}`);
  } else {
    console.log('  Tailscale: not detected — run start.bat after Tailscale is up, or use LAN.');
  }
  if (TOKEN) {
    console.log(`  Phone TTY URL (LAN): ${proto}://${lanIPs()[0] || 'localhost'}:${PORT}/?token=${TOKEN}`);
  }
  console.log(`  Command Code entry: ${CMD_ENTRY}`);
  console.log(`  Working directory: ${WORK_DIR}`);
  if (!TOKEN) {
    console.log('WARNING: No CMD_REMOTE_TOKEN set — anyone who can reach this port can control your PC.');
  }
});
