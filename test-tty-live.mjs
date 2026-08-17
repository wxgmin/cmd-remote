// TTY terminal functional check (ANSI-aware).
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let TOKEN = '';
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const m = env.match(/^CMD_REMOTE_TOKEN=(.+)$/m);
  if (m) TOKEN = m[1].trim();
} catch {}
if (!TOKEN) { console.error('No token'); process.exit(1); }

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

const ws = new WebSocket(`ws://localhost:8788/ws?token=${encodeURIComponent(TOKEN)}`);
let out = '';
let pass = 0, fail = 0;
let promptSeen = false;
let sent = false;
function check(name, cond, extra = '') {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (extra ? ' — ' + extra : ''));
  cond ? pass++ : fail++;
}

ws.on('open', () => {
  console.log('[connected to tty]');
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'output') {
    out += msg.data;
    const plain = stripAnsi(out);
    if (!promptSeen && plain.includes('Ask your question')) {
      promptSeen = true;
      check('TUI prompt rendered', true);
      ws.send(JSON.stringify({ type: 'input', data: 'Reply with exactly: tty-ok' }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: '\r' })), 300);
    }
    if (plain.includes('tty-ok') && (plain.includes('Worked for') || plain.includes('Thought for'))) {
      check('TUI input round-trip works', true);
      ws.close();
      console.log(`\n[RESULT] ${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }
  }
});
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
setTimeout(() => {
  check('TUI prompt rendered (timeout)', promptSeen);
  check('TUI input round-trip (timeout)', stripAnsi(out).includes('tty-ok'));
  console.log(`\n[RESULT] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 60000);
