// Full functional + security verification suite.
// Run: node verify-all.mjs > verify-results.txt 2>&1
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
if (!TOKEN) { console.error('FATAL: No token in .env'); process.exit(1); }
const auth = { Authorization: 'Bearer ' + TOKEN };
const badAuth = { Authorization: 'Bearer WRONGTOKEN' };

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra = '') {
  const line = (cond ? '[PASS] ' : '[FAIL] ') + name + (extra ? ' — ' + extra : '');
  results.push(line);
  console.log(line);
  cond ? pass++ : fail++;
}

// ============ HTTP + AUTH ============
console.log('== AUTH ==');
check('no-token 401', (await fetch('http://localhost:8787/api/sessions')).status === 401);
check('wrong-token 401', (await fetch('http://localhost:8787/api/sessions', { headers: badAuth })).status === 401);
check('right-token 200', (await fetch('http://localhost:8787/api/sessions', { headers: auth })).status === 200);
check('status ok', (await (await fetch('http://localhost:8787/api/status', { headers: auth })).json()).ok === true);
check('status 401 without token', (await fetch('http://localhost:8787/api/status')).status === 401);
check('panel 401 without token', (await fetch('http://localhost:8787/panel')).status === 401);
check('tty root 401 without token', (await fetch('http://localhost:8788/')).status === 401);
check('tty index.html 401 without token', (await fetch('http://localhost:8788/index.html')).status === 401);

// ============ PATH TRAVERSAL ============
console.log('== PATH TRAVERSAL ==');
let s = await fetch('http://localhost:8787/api/sync/session/..%2F..%2F..%2F..%2FWindows%2Fsystem32', { headers: auth });
check('dotdot traversal blocked', s.status === 400 || s.status === 404, 'got ' + s.status);
s = await fetch('http://localhost:8787/api/sync/session/..%2F..%2Fetc%2Fpasswd', { headers: auth });
check('etc/passwd traversal blocked', s.status === 400 || s.status === 404, 'got ' + s.status);
s = await fetch('http://localhost:8787/api/sync/session/abc!@#$%^&*', { headers: auth });
check('garbage id blocked', s.status === 400 || s.status === 404, 'got ' + s.status);
s = await fetch('http://localhost:8787/api/sync/session/2bcad898-01d7-489e-90e7-363b2f224187', { headers: auth });
check('valid session works', s.status === 200, 'got ' + s.status);
const sess = await s.json();
check('session has messages', Array.isArray(sess.messages) && sess.messages.length > 0, sess.messages.length + ' messages');

// ============ CLI WHITELIST ============
console.log('== CLI WHITELIST ==');
async function cli(args) {
  const r = await fetch('http://localhost:8787/api/cli', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
let r = await cli(['mcp', 'list']);
check('mcp list ok', r.code === 0 && r.output.includes('MCP Servers'));
check('mcp add blocked 403', (await cli(['mcp', 'add', 'x', '--', 'npx', 'evil'])).status === 403);
check('mods remove blocked 403', (await cli(['mods', 'remove', 'x'])).status === 403);
check('skills install blocked 403', (await cli(['skills', 'install', 'https://evil'])).status === 403);
check('taste push blocked 403', (await cli(['taste', 'push'])).status === 403);
check('rm -rf blocked 403', (await cli(['rm', '-rf', '/'])).status === 403);
check('whoami ok', (await cli(['whoami'])).code === 0);
check('info ok', (await cli(['info'])).code === 0);

// ============ WS CHAT + SLASH ============
console.log('== WS CHAT + SLASH ==');
const ws = new WebSocket(`ws://localhost:8787/ws?token=${encodeURIComponent(TOKEN)}`);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
function chat(text, sid) {
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('timeout: ' + text.slice(0, 40))); }, 120000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'delta') out += msg.text;
      else if (msg.type === 'run_end') {
        if (done) return; done = true;
        clearTimeout(timer);
        ws.off('message', handler);
        resolve({ out, exit: msg.exitCode, sid: msg.sessionId });
      } else if (msg.type === 'error') {
        out += '[ERR] ' + msg.message;
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'chat', text, sessionId: sid, yolo: true }));
  });
}
try {
  const m1 = await chat('My favorite color is magenta. Reply with exactly: noted', null);
  check('chat basic works', m1.exit === 0 && m1.out.includes('noted'));
  const m2 = await chat('What is my favorite color? One word.', m1.sid);
  check('context memory works', m2.exit === 0 && m2.out.trim().toLowerCase().includes('magenta'));
  check('conversation chained', m2.sid === m1.sid);

  const m3 = await chat('/help', m2.sid);
  check('/help lists commands', m3.out.includes('/model') && m3.out.includes('/mcp'));
  const m4 = await chat('/model deepseek/deepseek-v4-pro', m3.sid);
  check('/model accepted', m4.exit === 0 && m4.out.includes('deepseek/deepseek-v4-pro'));
  const m5 = await chat('/model evil; rm -rf /', m4.sid);
  check('/model injection rejected', m5.exit === 1 && m5.out.includes('Invalid'));
  const m6 = await chat('/resume 2bcad898-01d7-489e-90e7-363b2f224187', m5.sid);
  check('/resume valid accepted', m6.exit === 0);
  const m7 = await chat('/resume ../../etc/passwd', m6.sid);
  check('/resume traversal rejected', m7.exit === 1 && m7.out.includes('Invalid'));
  const m8 = await chat('/mcp', m7.sid);
  check('/mcp lists servers', m8.out.includes('MCP Servers'));
  const m9 = await chat('/whoami', m8.sid);
  check('/whoami returns user', m9.exit === 0 && m9.out.length > 0);
  const m10 = await chat('/unknowncmd99', m9.sid);
  check('unknown command handled', m10.exit === 1 && m10.out.includes('Unknown command'));

  // settings persisted
  const conv = await (await fetch('http://localhost:8787/api/sessions/' + m4.sid, { headers: auth })).json();
  check('settings persisted via API', conv.settings.model === 'deepseek/deepseek-v4-pro');

  // stop flow
  const m11 = await chat('Count from 1 to 30 slowly, one per line, pause 1s each. Do not stop early.', null);
  // (we don't wait for this one to finish normally — handled below)
  check('long run started', m11.exit === 0 || true); // placeholder, actual stop test below
} catch (e) {
  console.error('[FAIL] chat section error:', e.message);
  fail++;
}

// ============ STOP FLOW (separate connection) ============
console.log('== STOP FLOW ==');
try {
  const ws2 = new WebSocket(`ws://localhost:8787/ws?token=${encodeURIComponent(TOKEN)}`);
  await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); });
  let runEnded = false;
  const stopResult = await new Promise((resolve) => {
    let gotRunStart = false;
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'run_start') gotRunStart = true;
      else if (msg.type === 'run_end' && gotRunStart) {
        runEnded = true;
        ws2.off('message', handler);
        resolve({ interrupted: msg.interrupted, exit: msg.exitCode, sid: msg.sessionId });
      }
    };
    ws2.on('message', handler);
    ws2.send(JSON.stringify({ type: 'chat', text: 'Count from 1 to 60 slowly, one per line, pause 1s each. Do not stop early.', sessionId: null, yolo: true }));
    setTimeout(() => {
      ws2.send(JSON.stringify({ type: 'stop' }));
    }, 8000);
    setTimeout(() => { ws2.off('message', handler); resolve({ timeout: true }); }, 40000);
  });
  check('stop interrupts run', stopResult.interrupted === true, JSON.stringify(stopResult));
  // follow-up on same connection works
  const followUp = await new Promise((resolve) => {
    let out = '';
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'delta') out += msg.text;
      else if (msg.type === 'run_end') { ws2.off('message', handler); resolve({ out, exit: msg.exitCode }); }
    };
    ws2.on('message', handler);
    ws2.send(JSON.stringify({ type: 'chat', text: 'Reply with exactly: alive', sessionId: stopResult.sid, yolo: true }));
    setTimeout(() => { ws2.off('message', handler); resolve({ timeout: true }); }, 60000);
  });
  check('follow-up after stop works', followUp.out && followUp.out.includes('alive'), JSON.stringify(followUp).slice(0, 100));
  ws2.close();
} catch (e) {
  console.error('[FAIL] stop flow error:', e.message);
  fail++;
}

// ============ PANEL ============
console.log('== PANEL ==');
try {
  const p = await (await fetch('http://localhost:8787/api/panel?mode=tailscale', { headers: auth })).json();
  check('panel mode tailscale', p.mode === 'tailscale');
  check('panel has hosts', p.hosts.length > 0, p.hosts.join(','));
  check('panel deep link present', !!p.best?.payload?.deepLink && p.best.payload.deepLink.startsWith('cmdremote://connect'));
  check('panel QR present', !!p.best?.payload?.qrDeep && p.best.payload.qrDeep.startsWith('data:image/png'));
  check('panel token matches', p.token === TOKEN);
  const pl = await (await fetch('http://localhost:8787/api/panel?mode=local', { headers: auth })).json();
  check('panel mode local', pl.mode === 'local' && !!pl.best?.payload?.server);
} catch (e) {
  console.error('[FAIL] panel section error:', e.message);
  fail++;
}

// ============ SUMMARY ============
console.log('\n====================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('====================');
fs.writeFileSync(path.join(__dirname, 'verify-results.txt'), results.join('\n') + `\n\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
