// Shared-browser bridge: spawns Edge/Chrome once with a CDP debug port so
// Playwright MCP and the phone's live-view page drive the SAME browser.
//
// CDP docs used:
//   GET  /json/list                       -> open tabs
//   GET  /json/new?url=                   -> open a new tab
//   WebSocket per tab                     -> Page.captureScreenshot,
//                                            Page.navigate, Input.*, Runtime.evaluate
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9222;
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;
const PROFILE_DIR = path.join(os.homedir(), '.cmd-remote', 'browser-profile');

// Browser candidates: Edge first (usually present on Windows), then Chrome.
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let browserProc = null;
let startingPromise = null; // mutex: one spawn in flight at a time

function findBrowser() {
  for (const b of BROWSERS) {
    try { if (fs.existsSync(b)) return b; } catch {}
  }
  return null;
}

async function cdpAlive() {
  try {
    const r = await fetch(CDP_HTTP + '/json/version', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export async function startSharedBrowser() {
  // Already running (this process or an external one)?
  if (browserProc || await cdpAlive()) return browserProc;
  // Mutex: if a spawn is already in flight, wait for it.
  if (startingPromise) return startingPromise;
  startingPromise = (async () => {
    try {
      if (await cdpAlive()) return browserProc; // another call won the race
      const bin = findBrowser();
      if (!bin) return null;
      try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}
      const args = [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=msEdgeFirstRunExperience',
        '--window-size=1280,900',
        'about:blank',
      ];
      const proc = spawn(bin, args, { detached: false, windowsHide: true, stdio: 'ignore' });
      browserProc = proc;
      proc.on('exit', () => { if (browserProc === proc) browserProc = null; });
      proc.on('error', () => { if (browserProc === proc) browserProc = null; });
      // Give it a moment to open the debug port.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await cdpAlive()) break;
      }
      return browserProc;
    } finally {
      startingPromise = null;
    }
  })();
  return startingPromise;
}

async function cdpFetch(pathname) {
  const r = await fetch(CDP_HTTP + pathname, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('CDP HTTP ' + r.status);
  return r.json();
}

// One-shot CDP command over the tab's WebSocket (used by screenshots, etc).
async function cdpCommand(tabWsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(tabWsUrl);
    } catch (e) { return reject(e); }
    const id = Math.floor(Math.random() * 1e9);
    const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP timeout')); }, 6000);
    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.id === id) {
          clearTimeout(to);
          try { ws.close(); } catch {}
          if (m.error) reject(new Error(m.error.message));
          else resolve(m.result);
        }
      } catch {}
    });
    ws.on('error', (e) => { clearTimeout(to); try { ws.close(); } catch {} reject(e); });
    ws.on('close', () => { clearTimeout(to); try { ws.close(); } catch {} reject(new Error('CDP closed')); });
  });
}

function tabWsUrl(tab) {
  return tab.webSocketDebuggerUrl || '';
}

export function browserRouter(authOk) {
  const r = express.Router();

  // List open tabs (from CDP /json/list).
  r.get('/tabs', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    await startSharedBrowser();
    try {
      const list = await cdpFetch('/json/list');
      const tabs = (list || [])
        .filter((t) => t.type === 'page')
        .map((t) => ({ id: t.id, title: t.title || '', url: t.url, ws: t.webSocketDebuggerUrl }));
      res.json({ available: true, tabs });
    } catch {
      res.json({ available: false, error: 'Browser not running' });
    }
  });

  // Live screenshot of a tab (PNG).
  r.get('/screenshot', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    await startSharedBrowser();
    try {
      const list = await cdpFetch('/json/list');
      const tab = (list || []).find((t) => t.id === req.query.tab) || (list || []).find((t) => t.type === 'page');
      if (!tab) return res.status(404).json({ error: 'tab not found' });
      const result = await cdpCommand(tabWsUrl(tab), 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const buf = Buffer.from(result.data, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.send(buf);
    } catch {
      res.status(502).json({ error: 'screenshot failed' });
    }
  });

  // Navigate a tab to a URL.
  r.post('/navigate', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { tab, url } = req.body || {};
    if (!tab || !url) return res.status(400).json({ error: 'tab and url required' });
    await startSharedBrowser();
    try {
      const list = await cdpFetch('/json/list');
      const t = (list || []).find((x) => x.id === tab);
      if (!t) return res.status(404).json({ error: 'tab not found' });
      await cdpCommand(tabWsUrl(t), 'Page.navigate', { url });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Click at viewport coords (tap-to-click on the screenshot).
  r.post('/click', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { tab, x, y } = req.body || {};
    if (tab == null || x == null || y == null) return res.status(400).json({ error: 'tab, x, y required' });
    await startSharedBrowser();
    try {
      const list = await cdpFetch('/json/list');
      const t = (list || []).find((x) => x.id === tab);
      if (!t) return res.status(404).json({ error: 'tab not found' });
      const ws = tabWsUrl(t);
      await cdpCommand(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdpCommand(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Type text into the focused element.
  r.post('/type', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { tab, text } = req.body || {};
    if (!tab || text == null) return res.status(400).json({ error: 'tab and text required' });
    await startSharedBrowser();
    try {
      const list = await cdpFetch('/json/list');
      const t = (list || []).find((x) => x.id === tab);
      if (!t) return res.status(404).json({ error: 'tab not found' });
      await cdpCommand(tabWsUrl(t), 'Input.insertText', { text });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Run JS in the page (advanced; e.g. scroll, click by selector).
  r.post('/eval', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { tab, expression } = req.body || {};
    if (!tab || !expression) return res.status(400).json({ error: 'tab and expression required' });
    await startSharedBrowser();
    try {
      const list = await cdpFetch('/json/list');
      const t = (list || []).find((x) => x.id === tab);
      if (!t) return res.status(404).json({ error: 'tab not found' });
      const result = await cdpCommand(tabWsUrl(t), 'Runtime.evaluate', { expression, returnByValue: true });
      res.json({ ok: true, value: result?.result?.value });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Open a new tab in the shared browser (via CDP /json/new — returns the
  // exact target id, no guessing which tab was created).
  r.post('/newtab', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { url } = req.body || {};
    await startSharedBrowser();
    try {
      const target = url || 'about:blank';
      const t = await cdpFetch('/json/new?' + (url ? 'url=' + encodeURIComponent(target) : ''));
      res.json({ ok: true, id: t.id });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return r;
}

export function browserStatus() {
  return { cdpPort: CDP_PORT, running: !!browserProc };
}
