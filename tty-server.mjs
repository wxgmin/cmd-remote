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
const sessions = new Map();

wss.on('connection', (ws, req) => {
  if (!authOk(req)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  const id = randomUUID();
  const proc = pty.spawn(process.execPath, [CMD_ENTRY], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: WORK_DIR,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
  });
  sessions.set(id, { ws, proc });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'input') proc.write(msg.data);
      else if (msg.type === 'resize') proc.resize(msg.cols, msg.rows);
    } catch {
      try { proc.write(data.toString()); } catch {}
    }
  });
  ws.on('close', () => {
    try { proc.kill(); } catch {}
    sessions.delete(id);
  });
  proc.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
  });
  proc.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'exit' }));
    sessions.delete(id);
  });
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
