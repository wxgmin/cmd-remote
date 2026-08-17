#!/usr/bin/env node
// cmd-remote one-command setup.
// Run: node setup.mjs   (or: npm run setup)
//
// What it does:
//   1. Checks Node.js (>= 18)
//   2. Installs npm dependencies
//   3. Checks/installs Tailscale (winget on Windows; brew on macOS; script on Linux),
//      ensures login, brings up the tailnet
//   4. Generates a token and writes .env (never overwrites an existing token)
//   5. Tries Tailscale HTTPS cert (optional; free plan degrades gracefully)
//   6. Adds Windows Firewall rules (best-effort, needs admin)
//   7. Creates a desktop shortcut (Windows)
//   8. Starts both servers
//   9. Prints a setup summary with phone URLs
//
// Idempotent: safe to re-run. Never overwrites existing .env or token.
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.cmd-remote');
const CERT_DIR = path.join(DATA_DIR, 'tls');
const ENV_FILE = path.join(__dirname, '.env');

const ok = (s) => console.log('  [OK] ' + s);
const warn = (s) => console.log('  [WARN] ' + s);
const step = (n, s) => console.log(`\n[${n}/9] ${s}`);

function run(cmd, args, opts = {}) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...opts });
    return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
  } catch (e) {
    return { code: -1, out: '', err: e.message };
  }
}

// npm on Windows is a .cmd shim which spawnSync can't run directly (EINVAL).
// Resolve npm's real JS entry and run it via node.
function npmRun(args, opts = {}) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const res = run(process.execPath, [c, ...args], opts);
        return res;
      }
    } catch {}
  }
  // Last resort: shell invocation.
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: true, ...opts });
}

function nodeMajor() {
  const m = /^v(\d+)/.exec(process.version);
  return m ? parseInt(m[1], 10) : 0;
}

// --- 1. Node check ---
step(1, 'Checking Node.js');
if (nodeMajor() < 18) {
  console.error('  [ERROR] Node.js >= 18 required (found ' + process.version + ').');
  console.error('  Install from https://nodejs.org then re-run: node setup.mjs');
  process.exit(1);
}
ok('Node.js ' + process.version);

// --- 2. npm install ---
step(2, 'Installing dependencies');
let res = npmRun(['install', '--no-audit', '--no-fund'], { cwd: __dirname });
if (res.code !== 0) {
  console.error('  [ERROR] npm install failed:\n' + (res.err || res.out));
  process.exit(1);
}
ok('Dependencies installed');

// --- 3. Tailscale ---
step(3, 'Setting up Tailscale (anywhere-access)');
function findTailscale() {
  const candidates = [
    process.env.TAILSCALE_PATH,
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  // PATH fallback
  try {
    const r = run('tailscale', ['--version']);
    return r.code === 0 ? 'tailscale' : null;
  } catch { return null; }
}

let tailscaleBin = findTailscale();

if (tailscaleBin) {
  ok('Tailscale found: ' + tailscaleBin);
} else {
  warn('Tailscale not installed. Installing...');
  try {
    if (process.platform === 'win32') {
      const w = run('winget', ['install', '--id', 'Tailscale.Tailscale', '--accept-source-agreements', '--accept-package-agreements', '--silent']);
      if (w.code !== 0) throw new Error((w.err || w.out).slice(0, 300));
      tailscaleBin = findTailscale();
      if (!tailscaleBin) throw new Error('Tailscale installed but binary not found — restart the terminal and re-run');
    } else if (process.platform === 'darwin') {
      run('brew', ['install', '--cask', 'tailscale']);
      tailscaleBin = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    } else {
      run('sh', ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh']);
      tailscaleBin = '/usr/bin/tailscale';
    }
    ok('Tailscale installed');
  } catch (e) {
    warn('Could not auto-install Tailscale: ' + e.message);
    warn('Install from https://tailscale.com/download, log in, then re-run: node setup.mjs');
  }
}

let tailscaleUp = false;
let dnsName = null;
if (tailscaleBin && (fs.existsSync(tailscaleBin) || tailscaleBin === 'tailscale')) {
  // Login if needed
  const who = run(tailscaleBin, ['whoami'], { timeout: 15000 });
  if (who.code !== 0) {
    warn('Tailscale is not logged in. Opening login (complete it in the browser, then re-run setup)...');
    // `tailscale up` on Windows opens the login browser; headless prints a URL.
    try {
      const up = run(tailscaleBin, ['up'], { timeout: 20000 });
      if (up.code !== 0) warn('Login not completed yet: ' + (up.err || up.out).trim().slice(0, 300));
    } catch (e) {
      warn('tailscale up failed: ' + e.message);
    }
  }
  // Read status; bring up if no IP
  try {
    const status = run(tailscaleBin, ['status', '--json'], { timeout: 15000 });
    if (status.code === 0) {
      const j = JSON.parse(status.out);
      dnsName = j.Self?.DNSName?.replace(/\.$/, '') || null;
      tailscaleUp = !!j.Self?.TailscaleIPs?.length;
      if (!tailscaleUp) {
        const up = run(tailscaleBin, ['up'], { timeout: 20000 });
        tailscaleUp = up.code === 0;
      }
    }
  } catch (e) {
    warn('Could not read Tailscale status: ' + e.message);
  }
  if (tailscaleUp) ok('Tailscale is up' + (dnsName ? ' as ' + dnsName : ''));
  else warn('Tailscale not up yet — LAN-only until login. Phone must be on the same tailnet/Wi-Fi.');
} else {
  warn('Tailscale not available — continuing LAN-only.');
}

// --- 4. Token + .env ---
step(4, 'Generating access token');
let token = null;
if (fs.existsSync(ENV_FILE)) {
  const env = fs.readFileSync(ENV_FILE, 'utf8');
  const m = env.match(/^CMD_REMOTE_TOKEN=(.+)$/m);
  if (m) {
    token = m[1].trim();
    ok('.env exists — keeping existing token');
  }
}
if (!token) {
  token = randomBytes(16).toString('hex');
  const lines = ['# cmd-remote configuration', 'CMD_REMOTE_TOKEN=' + token];
  if (dnsName) lines.push('TAILSCALE_HOST=' + dnsName);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  ok('Token generated and saved to .env');
} else if (dnsName) {
  // Ensure TAILSCALE_HOST is present when we know the DNS name
  let env = fs.readFileSync(ENV_FILE, 'utf8');
  if (!/^TAILSCALE_HOST=/m.test(env)) {
    env += (env.endsWith('\n') ? '' : '\n') + 'TAILSCALE_HOST=' + dnsName + '\n';
    fs.writeFileSync(ENV_FILE, env);
  }
}

// --- 5. TLS via Tailscale (optional) ---
step(5, 'Setting up HTTPS (optional, needs Tailscale Premium)');
if (tailscaleBin && dnsName && (fs.existsSync(tailscaleBin) || tailscaleBin === 'tailscale')) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const certRes = run(tailscaleBin, ['cert', dnsName], { cwd: CERT_DIR, timeout: 30000 });
  if (certRes.code === 0) {
    let env = fs.readFileSync(ENV_FILE, 'utf8');
    if (!/^TAILSCALE_HOST=/m.test(env)) {
      env += (env.endsWith('\n') ? '' : '\n') + 'TAILSCALE_HOST=' + dnsName + '\n';
      fs.writeFileSync(ENV_FILE, env);
    }
    ok('HTTPS cert fetched for ' + dnsName);
  } else {
    warn('HTTPS cert unavailable (free Tailscale plan?). Continuing over HTTP on the tailnet.');
  }
} else {
  warn('HTTPS skipped (no Tailscale).');
}

// --- 6. Firewall (Windows, best-effort) ---
step(6, 'Configuring firewall (best-effort)');
if (process.platform === 'win32') {
  const fw = run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=cmd-remote']);
  if (fw.code !== 0) {
    try {
      run('powershell', ['-NoProfile', '-Command',
        "Start-Process -Verb RunAs -Wait -FilePath 'netsh' -ArgumentList 'advfirewall','firewall','add','rule','name=cmd-remote','dir=in','action=allow','protocol=TCP','localport=8787,8788'"]);
      ok('Firewall rule added (or UAC prompt accepted)');
    } catch (e) {
      warn('Could not add firewall rule: ' + e.message);
    }
  } else {
    ok('Firewall rule already present');
  }
} else {
  warn('Non-Windows: open ports 8787/8788 in your firewall manually if needed.');
}

// --- 7. Desktop shortcut (Windows) ---
step(7, 'Creating shortcuts (Windows)');
if (process.platform === 'win32') {
  try {
    run('powershell', ['-NoProfile', '-Command',
      "$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\Cmd Remote.lnk'); $lnk.TargetPath = '" + path.join(__dirname, 'start.bat') + "'; $lnk.WorkingDirectory = '" + __dirname + "'; $lnk.Save()"]);
    ok('Desktop shortcut created');
  } catch (e) {
    warn('Could not create desktop shortcut: ' + e.message);
  }
}

// --- 8. Start servers ---
step(8, 'Starting servers');
for (const script of ['server.js', 'tty-server.mjs']) {
  try {
    const child = spawn(process.execPath, [script], {
      cwd: __dirname,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    warn('Could not start ' + script + ': ' + e.message);
  }
}
await new Promise((r) => setTimeout(r, 2500));
ok('Servers starting (chat :8787, terminal :8788)');

// --- 9. Summary ---
step(9, 'Setup summary');

function lanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const n of Object.keys(nets)) {
    for (const ni of nets[n] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}
const ips = lanIPs();
const ts = ips.find((i) => i.startsWith('100.')) || null;
const lan = ips.filter((i) => !i.startsWith('100.'));

console.log('');
console.log('  ================================================');
console.log('   CMD-REMOTE SETUP COMPLETE');
console.log('  ================================================');
console.log('');
console.log('   Terminal (full TUI)  — port 8788:');
console.log('     Local:     http://localhost:8788/?token=' + token);
if (lan[0]) console.log('     LAN:       http://' + lan[0] + ':8788/?token=' + token);
if (ts) console.log('     Anywhere:  http://' + ts + ':8788/?token=' + token);
if (dnsName) console.log('     MagicDNS:  http://' + dnsName + ':8788/?token=' + token);
console.log('');
console.log('   Chat UI  — port 8787:');
console.log('     Local:     http://localhost:8787/?token=' + token);
if (lan[0]) console.log('     LAN:       http://' + lan[0] + ':8787/?token=' + token);
if (ts) console.log('     Anywhere:  http://' + ts + ':8787/?token=' + token);
if (dnsName) console.log('     MagicDNS:  http://' + dnsName + ':8787/?token=' + token);
console.log('');
console.log('   Phone: install the APK (GitHub Releases) or open the URL above.');
console.log('   Keep this token private — it grants full access to this PC.');
console.log('  ================================================');
console.log('');
console.log('Re-run "node setup.mjs" any time to re-print URLs / re-check health.');
