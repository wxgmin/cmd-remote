import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, spawnSync } from 'child_process';
import { randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { tailscaleIP, tailscaleTLS, lanIPs } from './lib/util.mjs';
import { browserRouter, startSharedBrowser } from './browser-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(os.homedir(), '.cmd-remote');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CMDC_HOME = path.join(os.homedir(), '.commandcode');
const PROJECTS_DIR = path.join(CMDC_HOME, 'projects');

// The Command Code CLI. On Windows, `spawn('cmd')` would hit cmd.exe and
// `.cmd` shims can't be spawned without a shell — so we resolve the npm
// global shim's real JS entry point and spawn `node` directly.
const CMD_ENTRY = process.env.CMD_ENTRY || resolveCmdEntry();
function resolveCmdEntry() {
  const npmPrefix = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm')
    : null;
  const shim = npmPrefix && path.join(npmPrefix, 'cmd.cmd');
  if (shim) {
    try {
      const contents = fs.readFileSync(shim, 'utf8');
      const m = contents.match(/"([^"]*command-code[\\/]dist[\\/]index\.mjs)"/);
      if (m) return m[1].replace('%dp0%', npmPrefix);
    } catch {}
  }
  // Fallback: let Node resolve the package from PATH.
  return 'cmd';
}

const WORK_DIR = process.env.WORK_DIR || process.cwd();
const TOKEN = process.env.CMD_REMOTE_TOKEN || null;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;
const HOST = process.env.HOST || '0.0.0.0';

// --- Persistent conversation history (proxy-owned, survives restarts) ---
let history = {};
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch {}

function saveHistory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function getOrCreateConv(id) {
  if (history[id]) return history[id];
  const conv = {
    id,
    title: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    settings: {},
  };
  history[id] = conv;
  return conv;
}

function buildContext(messages) {
  // Last 40 turns, capped to keep the prompt bounded.
  const recent = messages.slice(-40);
  const lines = [
    'The following is the earlier part of this ongoing conversation — you are the assistant in it. Use it as context for what the user says next:',
  ];
  for (const m of recent) {
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  }
  lines.push('End of earlier conversation context.');
  return lines.join('\n');
}

// --- Auth ---
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

// --- CLI helpers ---
function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CMD_ENTRY, ...args], {
      cwd: opts.cwd || WORK_DIR,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
  });
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// --- Express app ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  if (!authOk(req)) return res.status(401).send('Unauthorized');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/panel', (req, res) => {
  if (!authOk(req)) return res.status(401).send('Unauthorized');
  res.sendFile(path.join(PUBLIC_DIR, 'panel.html'));
});
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use('/api/browser', browserRouter(authOk));

app.get('/api/status', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ ok: true, tokenRequired: !!TOKEN, workDir: WORK_DIR });
});

// --- Control panel data ---
// mode: 'auto' (tailscale if up, else LAN) | 'tailscale' | 'local'
async function buildPanelData(mode) {
  const nets = os.networkInterfaces();
  const lan = [];
  let tsIp = null;
  for (const n of Object.keys(nets)) {
    for (const ni of nets[n] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        if (ni.address.startsWith('100.')) tsIp = ni.address;
        else lan.push(ni.address);
      }
    }
  }
  // Tailscale magic DNS via `tailscale status --json` (best-effort)
  let magicDNS = null;
  let tailscaleInstalled = false;
  const tsBin = process.platform === 'win32'
    ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
    : '/usr/bin/tailscale';
  tailscaleInstalled = (() => { try { return fs.existsSync(tsBin); } catch { return false; } })();
  if (tailscaleInstalled) {
    try {
      const r = spawnSync(tsBin, ['status', '--json'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (r.status === 0) {
        const j = JSON.parse(r.stdout);
        magicDNS = j.Self?.DNSName?.replace(/\.$/, '') || null;
        if (!tsIp) tsIp = j.Self?.TailscaleIPs?.[0] || null;
      }
    } catch {}
  }

  const token = TOKEN || '';
  // Choose the "best" host per mode.
  let bestHost = null;
  let bestName = null;
  if (mode === 'tailscale') {
    bestHost = tsIp || magicDNS;
    bestName = 'Tailscale';
  } else if (mode === 'local') {
    bestHost = lan[0] || 'localhost';
    bestName = 'LAN';
  } else { // auto
    bestHost = tsIp || magicDNS || lan[0] || 'localhost';
    bestName = tsIp || magicDNS ? 'Tailscale' : 'LAN';
  }

  // Build the per-mode payloads: one for each host we can offer.
  const hosts = [];
  if (tsIp) hosts.push({ name: 'tailscale-ip', label: 'Anywhere (Tailscale)', host: tsIp });
  if (magicDNS) hosts.push({ name: 'magicdns', label: 'MagicDNS', host: magicDNS });
  for (const ip of lan) hosts.push({ name: 'lan', label: 'Home Wi-Fi (LAN)', host: ip });
  if (!hosts.length) hosts.push({ name: 'local', label: 'On this PC', host: 'localhost' });

  const qrcode = (await import('qrcode')).default;
  const modes = {};
  for (const h of hosts) {
    const host = h.host;
    const server = `http://${host}:8788`;
    const browserUrl = `${server}/?token=${token}`;
    const deepLink = `cmdremote://connect?server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}&mode=${encodeURIComponent(mode)}`;
    let qrBrowser = null;
    let qrDeep = null;
    try {
      qrBrowser = await qrcode.toDataURL(browserUrl, { margin: 1, width: 300 });
      qrDeep = await qrcode.toDataURL(deepLink, { margin: 1, width: 300 });
    } catch {}
    modes[h.name] = {
      label: h.label,
      host,
      server,
      browserUrl,
      deepLink,
      qrBrowser,
      qrDeep,
    };
  }

  return {
    token,
    workDir: WORK_DIR,
    ports: { chat: 8787, terminal: 8788 },
    lan,
    tailscaleIP: tsIp,
    magicDNS,
    tailscaleInstalled,
    mode,
    best: bestHost ? { name: bestName, host: bestHost, payload: modes[Object.keys(modes).find((k) => modes[k].host === bestHost)] || modes[Object.keys(modes)[0]] } : null,
    modes,
    hosts: hosts.map((h) => h.name),
  };
}

app.get('/api/panel', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const mode = req.query.mode === 'tailscale' || req.query.mode === 'local' ? req.query.mode : 'auto';
  try {
    res.json(await buildPanelData(mode));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Server-rendered panel for the desktop app's embedded WebBrowser (no JS needed).
app.get('/panel/embed', async (req, res) => {
  if (!authOk(req)) return res.status(401).send('Unauthorized');
  const mode = req.query.mode === 'tailscale' || req.query.mode === 'local' ? req.query.mode : 'auto';
  let d;
  try { d = await buildPanelData(mode); }
  catch (e) { return res.status(500).send('<h2>Could not load panel</h2>'); }
  const p = d.best?.payload || d.modes[Object.keys(d.modes)[0]];
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const qr = p ? (p.qrBrowser || p.qrDeep || '') : '';
  const best = d.best ? d.best.host : (d.lan[0] || 'localhost');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cmd Remote Control Panel</title>
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; background: #fafafa; color: #111827; margin: 0; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 4px 0; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 18px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .card h2 { font-size: 14px; margin: 0 0 10px 0; }
  .row { padding: 6px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; }
  .row:last-child { border-bottom: none; }
  .row b { color: #6b7280; display: inline-block; width: 130px; font-weight: 500; }
  .row code { font-family: Consolas, monospace; word-break: break-all; }
  .qr { text-align: center; margin: 10px 0; }
  .qr img { width: 200px; height: 200px; border: 1px solid #e5e7eb; border-radius: 10px; }
  .ok { color: #16a34a; font-weight: 600; }
  .note { color: #6b7280; font-size: 12px; margin-top: 14px; }
</style></head>
<body>
  <h1>Cmd Remote Control Panel</h1>
  <div class="sub">Everything your phone needs to connect to this PC</div>
  <div class="card">
    <h2>Scan with your phone</h2>
    <div class="qr"><img src="${qr}" alt="QR code"></div>
    <div class="row"><b>Phone URL</b><code>${esc(p ? p.browserUrl : '')}</code></div>
  </div>
  <div class="card">
    <h2>Server address</h2>
    <div class="row"><b>Best for phone</b><code>${esc(p ? p.server : '')}</code></div>
    <div class="row"><b>On this PC</b><code>http://localhost:8788/?token=${esc(d.token)}</code></div>
    ${d.lan.length ? `<div class="row"><b>Home Wi-Fi</b><code>http://${esc(d.lan[0])}:8788/?token=${esc(d.token)}</code></div>` : ''}
    ${d.tailscaleIP ? `<div class="row"><b>Anywhere</b><code>http://${esc(d.tailscaleIP)}:8788/?token=${esc(d.token)}</code></div>` : ''}
    ${d.magicDNS ? `<div class="row"><b>MagicDNS</b><code>http://${esc(d.magicDNS)}:8788/?token=${esc(d.token)}</code></div>` : ''}
  </div>
  <div class="card">
    <h2>Access token</h2>
    <div class="row"><b>Token</b><code>${esc(d.token)}</code></div>
    <div class="note">Keep this secret. Anyone with it can control this PC.</div>
  </div>
  <div class="note">Status: <span class="ok">Online</span> · Best host: ${esc(best)}</div>
</body></html>`);
});

// --- Tailscale: bring the tailnet up (best-effort) ---
app.post('/api/tailscale/up', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const tsBin = process.platform === 'win32'
    ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
    : '/usr/bin/tailscale';
  if (!fs.existsSync(tsBin)) {
    // Try to install via winget (Windows)
    if (process.platform === 'win32') {
      const w = spawnSync('winget', ['install', '--id', 'Tailscale.Tailscale', '--accept-source-agreements', '--accept-package-agreements', '--silent'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
      if (w.status !== 0) return res.json({ ok: false, message: 'Tailscale not installed and auto-install failed. Install from https://tailscale.com/download' });
    } else {
      return res.json({ ok: false, message: 'Tailscale not installed. Install from https://tailscale.com/download' });
    }
  }
  try {
    const up = spawnSync(tsBin, ['up'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (up.status === 0) return res.json({ ok: true, message: 'Tailscale is up' });
    return res.json({ ok: false, message: (up.stderr || up.stdout || 'tailscale up failed').trim().slice(0, 300) });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

// --- Sync: read the real Command Code session catalog ---
app.get('/api/sync/sessions', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const result = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return res.json({ sessions: [] });
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const dirPath = path.join(PROJECTS_DIR, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl') && !f.includes('checkpoint'));
      for (const file of files) {
        const id = file.replace('.jsonl', '');
        const filePath = path.join(dirPath, file);
        let stat;
        try { stat = fs.statSync(filePath); } catch { continue; }
        if (stat.size === 0) continue; // skip empty/broken transcripts
        let title = null;
        let entrypoint = 'interactive';
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dirPath, id + '.meta.json'), 'utf8'));
          title = m.title || null;
          entrypoint = m.entrypoint || 'interactive';
        } catch {}
        result.push({
          id,
          title: title || id.slice(0, 8),
          projectSlug: dir,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          entrypoint,
        });
      }
    }
    result.sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {}
  res.json({ sessions: result });
});

app.get('/api/sync/session/:id', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.params.id;
  // Validate id is a plain session id (UUID) — prevents path traversal.
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return res.status(400).json({ error: 'invalid session id' });
  let filePath = null;
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const candidate = path.join(PROJECTS_DIR, dir, id + '.jsonl');
      if (fs.existsSync(candidate)) { filePath = candidate; break; }
    }
  } catch {}
  if (!filePath) return res.status(404).json({ error: 'not found' });
  const messages = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.type !== 'message') continue;
      const msg = parsed.message;
      if (!msg || typeof msg.content !== 'object') continue;
      const texts = [];
      for (const part of msg.content) {
        if (part.type === 'text') texts.push(part.text);
        else if (part.type === 'tool_use') texts.push(`[tool: ${part.name}]`);
        else if (part.type === 'tool_result') {
          try {
            const c = part.content;
            if (typeof c === 'string') texts.push(c);
            else if (Array.isArray(c)) for (const x of c) if (x.type === 'text') texts.push(x.text);
          } catch {}
        }
      }
      if (!texts.length) continue;
      if (msg.role === 'user' && msg.meta?.source === 'tool') continue;
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: texts.join('\n'),
        model: parsed.model || null,
      });
    }
  } catch {}
  res.json({ id, messages });
});

// --- File browser (view-only): whitelisted roots, safe path resolution ---
const OBSIDIAN_VAULT = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
function fsRoots() {
  // Roots the phone may browse. Always: working dir, agent session projects,
  // and the Obsidian vault (if it exists).
  const roots = [WORK_DIR, PROJECTS_DIR];
  try { if (fs.existsSync(OBSIDIAN_VAULT)) roots.push(OBSIDIAN_VAULT); } catch {}
  return roots.map((r) => path.resolve(r));
}
function isInsideRoots(abs) {
  const roots = fsRoots();
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}
function safeFsPath(reqPath) {
  if (typeof reqPath !== 'string' || !reqPath) return null;
  const abs = path.resolve(reqPath);
  if (!isInsideRoots(abs)) return null;
  try {
    const real = fs.realpathSync(abs);
    if (!isInsideRoots(real)) return null;
    return real;
  } catch {
    return null; // nonexistent or unresolvable
  }
}

app.get('/api/fs/list', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const p = safeFsPath(req.query.path || WORK_DIR);
  if (!p) return res.status(403).json({ error: 'Path not allowed' });
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true }).map((d) => {
      const full = path.join(p, d.name);
      let size = 0, mtime = null;
      try {
        const st = fs.statSync(full);
        size = d.isDirectory() ? 0 : st.size;
        mtime = st.mtime.toISOString();
      } catch {}
      return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size, mtime };
    });
  } catch (e) {
    return res.status(500).json({ error: 'Cannot read directory: ' + e.message });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  res.json({ path: p, roots: fsRoots(), entries });
});

// Text/image/file content, capped to keep the phone happy.
const TEXT_EXT = new Set(['.md', '.txt', '.js', '.mjs', '.ts', '.py', '.json', '.html', '.css', '.yml', '.yaml', '.xml', '.log', '.csv', '.ini', '.cfg', '.toml', '.sh', '.bat', '.cmd', '.cs', '.java', '.rs', '.go', '.c', '.h', '.cpp', '.env.example', '.gitignore', '']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
// Binary-ish types the phone previews client-side (SheetJS parses xlsx; the
// browser renders PDFs natively). Streamed as octet-stream with a size cap.
const BIN_EXT = new Set(['.xlsx', '.xls', '.tsv', '.pdf', '.docx', '.doc', '.pptx', '.zip', '.tar', '.gz']);
app.get('/api/fs/file', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const p = safeFsPath(req.query.path);
  if (!p) return res.status(403).json({ error: 'Path not allowed' });
  let st;
  try { st = fs.statSync(p); } catch { return res.status(404).json({ error: 'not found' }); }
  if (st.isDirectory()) return res.status(400).json({ error: 'is a directory' });
  const ext = path.extname(p).toLowerCase();
  try {
    if (IMG_EXT.has(ext)) {
      if (st.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'image too large' });
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      fs.createReadStream(p).pipe(res);
      return;
    }
    if (TEXT_EXT.has(ext)) {
      if (st.size > 1024 * 1024) return res.status(413).json({ error: 'file too large to preview' });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      fs.createReadStream(p).pipe(res);
      return;
    }
    if (BIN_EXT.has(ext)) {
      // SheetJS needs the raw bytes; PDF needs the raw bytes for the viewer.
      const cap = ext === '.pdf' ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
      if (st.size > cap) return res.status(413).json({ error: 'file too large to open' });
      const mime = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.tsv': 'text/tab-separated-values', '.pdf': 'application/pdf' }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      fs.createReadStream(p).pipe(res);
      return;
    }
    res.status(415).json({ error: 'preview not available', name: path.basename(p), size: st.size });
  } catch (e) {
    res.status(500).json({ error: 'Cannot read file: ' + e.message });
  }
});

// Obsidian vault info: tells the Files page where the vault is.
app.get('/api/obsidian/vault', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ vault: fs.existsSync(OBSIDIAN_VAULT) ? OBSIDIAN_VAULT : null });
});

// Vault search: server-side scan of the vault (filename + text content).
// No Obsidian plugin dependency — works even if Obsidian is closed.
app.get('/api/obsidian/search', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.status(400).json({ error: 'q required' });
  if (!fs.existsSync(OBSIDIAN_VAULT)) return res.json({ available: false, error: 'vault not found' });
  const results = [];
  const walk = (dir, rel) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      if (d.name.startsWith('.')) continue; // skip .obsidian etc.
      const full = path.join(dir, d.name);
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { walk(full, r); continue; }
      if (d.name.toLowerCase().includes(q)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        results.push({ filename: r, result: d.name, size });
      }
      // Also search inside markdown/text files (cap at 500 KB each).
      const ext = path.extname(d.name).toLowerCase();
      if (['.md', '.txt'].includes(ext)) {
        try {
          if (fs.statSync(full).size <= 500 * 1024) {
            const content = fs.readFileSync(full, 'utf8');
            if (content.toLowerCase().includes(q)) {
              const idx = content.toLowerCase().indexOf(q);
              const snippet = content.slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ').trim();
              results.push({ filename: r, result: snippet, size: content.length });
            }
          }
        } catch {}
      }
    }
  };
  walk(OBSIDIAN_VAULT, '');
  res.json({ available: true, results: results.slice(0, 50) });
});

// --- Management: run CLI subcommands and return output ---
// Read-only whitelist: the first arg must be a safe subcommand AND the rest of
// the args must be read-only variants (no add/remove/delete/install/auth/etc).
const SAFE_CLI = {
  mcp: ['list', 'get'],
  skills: ['list'],
  mods: ['list'],
  taste: ['list'],
  info: [],
  status: [],
  whoami: [],
  '--list-models': [],
  '--version': [],
};
app.post('/api/cli', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { args } = req.body || {};
  if (!Array.isArray(args) || !args.length) return res.status(400).json({ error: 'args required' });
  const allowed = SAFE_CLI[args[0]];
  if (!allowed) {
    return res.status(403).json({ error: `subcommand not allowed: ${args[0]}` });
  }
  // Only allow the read-only sub-args listed; anything else is rejected.
  const rest = args.slice(1);
  const restOk = rest.every((a) => allowed.includes(a) || a.startsWith('--'));
  if (!restOk) {
    return res.status(403).json({ error: `arguments not allowed: ${rest.join(' ')}` });
  }
  const result = await runCli(args);
  res.json({ code: result.code, output: stripAnsi(result.out), error: stripAnsi(result.err) });
});

// --- Sessions (proxy-owned chat history) ---
app.get('/api/sessions', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const list = Object.values(history)
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      settings: c.settings || {},
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ sessions: list });
});

app.get('/api/sessions/:id', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const conv = history[req.params.id];
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json(conv);
});

app.delete('/api/sessions/:id', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (history[req.params.id]) {
    delete history[req.params.id];
    saveHistory();
  }
  res.json({ ok: true });
});

// --- WebSocket server ---
const tls = tailscaleTLS();
let server;
if (tls) {
  server = createHttpsServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, app);
  console.log('HTTPS enabled via Tailscale cert:', tls.host);
} else {
  server = createServer(app);
}
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map();
// Runs survive socket disconnects: an in-flight agent run keeps going on the
// PC, buffers its output, and a reconnecting client can attach to replay it.
const runs = new Map(); // conversation sessionId -> { child, buffer, stderrTail, wsRef, interrupted, done, exitCode }

function runSend(run, obj) {
  if (run.wsRef && run.wsRef.readyState === WebSocket.OPEN) {
    run.wsRef.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws, req) => {
  if (!authOk(req)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  const clientId = randomUUID();
  clients.set(clientId, { ws, sessionId: null });
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'chat') {
      try {
        handleChat(clientId, msg);
      } catch (err) {
        send(clientId, { type: 'error', message: `Server error: ${err.message}` });
      }
    } else if (msg.type === 'stop') {
      // Stop the run for the conversation this client is viewing.
      const sid = msg.sessionId || clients.get(clientId)?.sessionId;
      if (sid) killRun(sid);
    } else if (msg.type === 'attach') {
      const sid = msg.sessionId;
      if (!sid) return;
      const client = clients.get(clientId);
      if (client) client.sessionId = sid;
      const run = runs.get(sid);
      if (!run) {
        send(clientId, { type: 'run_end', sessionId: sid, exitCode: null, detached: true });
        return;
      }
      // Replay buffered output for this run so the view catches up.
      run.wsRef = ws;
      if (!run.done) {
        send(clientId, { type: 'run_start', sessionId: sid });
        for (const t of run.buffer) send(clientId, { type: t.type, text: t.text, name: t.name, description: t.description });
        if (run.stderrTail) send(clientId, { type: 'stderr', text: run.stderrTail });
      } else {
        send(clientId, { type: 'run_end', sessionId: sid, exitCode: run.exitCode, interrupted: run.interrupted });
      }
    }
  });
  ws.on('close', () => {
    // Detach — do NOT kill the run; it keeps going and buffers output.
    const client = clients.get(clientId);
    if (client) {
      const sid = client.sessionId;
      const run = sid && runs.get(sid);
      if (run && run.wsRef === ws) run.wsRef = null;
    }
    clients.delete(clientId);
  });
});

function send(clientId, obj) {
  const client = clients.get(clientId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(obj));
  }
}

// --- Slash command handling ---
const SLASH_COMMANDS = {
  help: {
    desc: 'Show available slash commands',
    run: (p, c) => {
      const lines = Object.entries(SLASH_COMMANDS)
        .filter(([k]) => k !== 'help2')
        .map(([k, v]) => `/${k} — ${v.desc}`);
      c.delta(lines.join('\n'));
      c.done(0);
    },
  },
  clear: {
    desc: 'Start a new conversation',
    run: (p, c) => {
      c.cleared();
      c.done(0);
    },
  },
  new: {
    desc: 'Start a new conversation (alias of /clear)',
    run: (p, c) => {
      c.cleared();
      c.done(0);
    },
  },
  model: {
    desc: 'Set model for this conversation (e.g. /model deepseek/deepseek-v4-pro)',
    run: async (p, c) => {
      const id = p.trim();
      if (!id) return c.error('Usage: /model <id> — see /models for the list');
      if (!/^[\w./:@-]{1,80}$/.test(id)) return c.error('Invalid model id.');
      c.conv.settings.model = id;
      saveHistory();
      c.delta(`Model set to ${id} for this conversation.`);
      c.done(0);
    },
  },
  models: {
    desc: 'List available models',
    run: async (p, c) => {
      const r = await runCli(['--list-models']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  effort: {
    desc: 'Set reasoning effort (low/medium/high)',
    run: (p, c) => {
      const v = p.trim().toLowerCase();
      if (!['low', 'medium', 'high'].includes(v)) return c.error('Usage: /effort low|medium|high');
      c.conv.settings.effort = v;
      saveHistory();
      c.delta(`Effort set to ${v}.`);
      c.done(0);
    },
  },
  mode: {
    desc: 'Set permission mode (yolo/auto-accept/plan)',
    run: (p, c) => {
      const v = p.trim().toLowerCase();
      if (!['yolo', 'auto-accept', 'plan'].includes(v)) return c.error('Usage: /mode yolo|auto-accept|plan');
      c.conv.settings.permissionMode = v;
      saveHistory();
      c.delta(`Permission mode set to ${v}.`);
      c.done(0);
    },
  },
  plan: {
    desc: 'Toggle plan mode (read-only)',
    run: (p, c) => {
      if (p.trim() === 'off') {
        c.conv.settings.plan = false;
        c.conv.settings.permissionMode = 'yolo';
        saveHistory();
        c.delta('Plan mode OFF.');
      } else {
        c.conv.settings.plan = true;
        saveHistory();
        c.delta('Plan mode ON for the next message (read-only). Send /plan off to disable.');
      }
      c.done(0);
    },
  },
  status: {
    desc: 'Show server/agent status',
    run: async (p, c) => {
      const info = await runCli(['info']);
      const whoami = await runCli(['whoami']);
      c.delta(`[server]\nworkDir: ${WORK_DIR}\nentry: ${CMD_ENTRY}\n\n[info]\n${stripAnsi(info.out)}\n\n[whoami]\n${stripAnsi(whoami.out)}`);
      c.done(info.code || whoami.code);
    },
  },
  sessions: {
    desc: 'List synced terminal sessions',
    run: (p, c) => {
      c.delta('Open the sidebar "Terminal sessions" view to browse, or use /resume <id> to continue one from your phone.');
      c.done(0);
    },
  },
  resume: {
    desc: 'Continue a terminal session by id',
    run: (p, c) => {
      const id = p.trim();
      if (!id) return c.error('Usage: /resume <session-id>');
      if (!/^[0-9a-f-]{8,64}$/i.test(id)) return c.error('Invalid session id.');
      c.conv.settings.resumeSession = id;
      c.conv.settings.sessionType = 'terminal';
      saveHistory();
      c.delta(`Will continue terminal session ${id}. Send a message to start.`);
      c.done(0);
    },
  },
  mcp: {
    desc: 'List MCP servers',
    run: async (p, c) => {
      const r = await runCli(['mcp', 'list']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  skills: {
    desc: 'List installed skills',
    run: async (p, c) => {
      const r = await runCli(['skills', 'list']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  mods: {
    desc: 'List loaded mods',
    run: async (p, c) => {
      const r = await runCli(['mods', 'list']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  taste: {
    desc: 'List taste packages',
    run: async (p, c) => {
      const r = await runCli(['taste', 'list']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  whoami: {
    desc: 'Show current Command Code user',
    run: async (p, c) => {
      const r = await runCli(['whoami']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  info: {
    desc: 'Show Command Code system info',
    run: async (p, c) => {
      const r = await runCli(['info']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  version: {
    desc: 'Show Command Code version',
    run: async (p, c) => {
      const r = await runCli(['--version']);
      c.delta(stripAnsi(r.out || r.err));
      c.done(r.code);
    },
  },
  todo: {
    desc: 'Ask the agent to manage a todo list',
    run: (p, c) => {
      const extra = p.trim() ? ` Task: ${p.trim()}` : '';
      c.passthrough(`[system] The user invoked /todo.${extra} Review the session task list and show it, updating as needed.`);
    },
  },
  help2: { desc: 'hidden', run: () => {} },
};

function handleChat(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;
  const sessionId = msg.sessionId || null;
  if (sessionId && runs.get(sessionId) && !runs.get(sessionId).done) {
    send(clientId, { type: 'error', message: 'A run is already in progress for this conversation.' });
    return;
  }
  const query = String(msg.text || '').trim();
  if (!query) return;

  // Slash command dispatch
  if (query.startsWith('/') && !query.startsWith('//')) {
    const [cmd, ...rest] = query.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    const slash = SLASH_COMMANDS[cmd.toLowerCase()];
    if (!slash) {
      const conv = getOrCreateConv(msg.sessionId || randomUUID());
      send(clientId, { type: 'error', message: `Unknown command /${cmd}. Type /help for the list.` });
      send(clientId, { type: 'run_end', sessionId: conv.id, exitCode: 1 });
      return;
    }
    const conv = getOrCreateConv(msg.sessionId || randomUUID());
    const callbacks = {
      conv,
      delta: (t) => send(clientId, { type: 'delta', text: t }),
      done: (code) => send(clientId, { type: 'run_end', sessionId: conv.id, exitCode: code }),
      error: (m) => {
        send(clientId, { type: 'error', message: m });
        send(clientId, { type: 'run_end', sessionId: conv.id, exitCode: 1 });
      },
      cleared: () => send(clientId, { type: 'cleared' }),
      passthrough: (t) => handleChat(clientId, { ...msg, text: t }),
    };
    const r = slash.run(arg, callbacks);
    if (r && typeof r.then === 'function') r.catch((e) => callbacks.error(e.message));
    return;
  }

  const conv = getOrCreateConv(sessionId);
  conv.messages.push({ role: 'user', content: query, ts: new Date().toISOString() });
  conv.updatedAt = new Date().toISOString();
  if (!conv.title) conv.title = query.length > 60 ? query.slice(0, 60) + '…' : query;
  saveHistory();

  // Validate WORK_DIR exists; fall back to server dir if not.
  const cwd = (() => {
    try {
      if (fs.statSync(WORK_DIR).isDirectory()) return WORK_DIR;
    } catch {}
    return process.cwd();
  })();

  const context = buildContext(conv.messages.slice(0, -1));
  const fullQuery = context ? `${context}\n\nUser: ${query}` : query;

  const args = ['-p', fullQuery, '--output-format', 'json', '--skip-onboarding'];
  const s = conv.settings || {};

  // Permission mode
  if (s.permissionMode === 'plan' || s.plan) args.push('--permission-mode', 'plan');
  else if (s.permissionMode === 'auto-accept') args.push('--auto-accept');
  else if (msg.yolo !== false && s.permissionMode !== 'auto-accept') args.push('--yolo');

  // Model & effort
  if (s.model) args.push('-m', s.model);
  if (s.effort) args.push('--effort', s.effort);

  // Terminal session resume
  if (s.resumeSession && s.sessionType === 'terminal') {
    args.push('--session', s.resumeSession);
  }

  send(clientId, { type: 'run_start', sessionId });

  const child = spawn(process.execPath, [CMD_ENTRY, ...args], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
  });
  const run = { child, buffer: [], stderrTail: '', wsRef: client.ws, interrupted: false, done: false, exitCode: null };
  runs.set(sessionId, run);

  let assistantText = '';
  let lineBuffer = '';
  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString();
    let idx;
    while ((idx = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, idx).trim();
      lineBuffer = lineBuffer.slice(idx + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === 'event') {
        const ev = parsed.event;
        if (!ev) continue;
        if (ev.type === 'text_delta') {
          assistantText += ev.delta || '';
          run.buffer.push({ type: 'delta', text: ev.delta || '' });
          runSend(run, { type: 'delta', text: ev.delta || '' });
        } else if (ev.type === 'tool_running') {
          run.buffer.push({ type: 'tool', name: ev.toolName, description: ev.description || '' });
          runSend(run, { type: 'tool', name: ev.toolName, description: ev.description || '' });
        }
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) {
      run.stderrTail = (run.stderrTail + text).slice(-2000);
      runSend(run, { type: 'stderr', text: text.trim() });
    }
  });

  child.on('error', (err) => {
    runSend(run, { type: 'error', message: `Failed to start Command Code: ${err.message}` });
    run.done = true;
    run.exitCode = 1;
    runSend(run, { type: 'run_end', sessionId, exitCode: 1, interrupted: false });
    run.wsRef = null;
    setTimeout(() => runs.delete(sessionId), 60000);
  });

  child.on('close', (code) => {
    run.done = true;
    run.exitCode = code;
    const interrupted = !!run.interrupted;
    const trimmed = assistantText.trim();
    if (!interrupted && trimmed) {
      conv.messages.push({ role: 'assistant', content: trimmed, ts: new Date().toISOString() });
    } else if (!interrupted && run.stderrTail.trim()) {
      conv.messages.push({ role: 'error', content: run.stderrTail.trim().slice(-500), ts: new Date().toISOString() });
    }
    conv.updatedAt = new Date().toISOString();
    saveHistory();
    runSend(run, { type: 'run_end', sessionId, exitCode: code, interrupted });
    run.wsRef = null;
    // Keep the run briefly so a reconnecting client can attach and learn it
    // finished, then drop it to avoid unbounded memory growth.
    setTimeout(() => runs.delete(sessionId), 60000);
  });
}

function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
}

function killRun(sessionId) {
  const run = runs.get(sessionId);
  if (!run) return;
  run.interrupted = true;
  killTree(run.child);
  run.child = null;
  // The close handler finalizes (done=true, run_end broadcast).
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// --- Startup output: local + LAN + token URLs ---
server.listen(PORT, HOST, () => {
  const proto = tls ? 'https' : 'http';
  console.log(`cmd-remote listening (${proto})`);
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
    console.log(`  Phone URL (LAN): ${proto}://${lanIPs()[0] || 'localhost'}:${PORT}/?token=${TOKEN}`);
  }
  console.log(`  Command Code entry: ${CMD_ENTRY}`);
  console.log(`  Working directory: ${WORK_DIR}`);
  // Launch the shared browser for Playwright MCP + the phone's live view
  // (lazy; each /api/browser call also self-heals if it exited).
  startSharedBrowser().then((p) => {
    console.log(p ? `  Shared browser: up (CDP port 9222)` : '  Shared browser: not found — live browser view disabled');
  });
  if (!TOKEN) {
    console.log('WARNING: No CMD_REMOTE_TOKEN set — anyone who can reach this port can control your PC.');
    console.log('Set CMD_REMOTE_TOKEN (or put it in .env) and restart.');
  }
});
