// Fetch Tailscale HTTPS cert for the MagicDNS name and store it for the servers.
// Usage: node tls-setup.mjs [hostname]
// If hostname omitted, uses `tailscale status --json` to find this machine's DNSName.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const TS = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const certDir = path.join(os.homedir(), '.cmd-remote', 'tls');
fs.mkdirSync(certDir, { recursive: true });

let host = process.argv[2];
if (!host) {
  try {
    const out = execFileSync(TS, ['status', '--json'], { encoding: 'utf8' });
    const j = JSON.parse(out);
    host = j.Self?.DNSName?.replace(/\.$/, '');
  } catch (e) {
    console.error('Could not determine Tailscale hostname:', e.message);
    process.exit(1);
  }
}
if (!host) {
  console.error('Tailscale does not report a DNS name — is Tailscale running?');
  process.exit(1);
}
console.log(`Fetching TLS cert for ${host} ...`);

try {
  execFileSync(TS, ['cert', host], { cwd: certDir, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
} catch (e) {
  const msg = ((e.message || '') + (e.stderr || '')).toString();
  if (msg.includes('does not support getting TLS certs') || msg.includes('500')) {
    console.error('');
    console.error('Your Tailscale plan does not include TLS certs (free plan limitation).');
    console.error('Options:');
    console.error('  1. Use the app over HTTP on your tailnet (works fine; Chrome may not show');
    console.error('     "Install app" for non-HTTPS, but you can still Add to Home Screen).');
    console.error('  2. Upgrade to Tailscale Premium for HTTPS certs, then re-run this script.');
    console.error('  3. Use a reverse proxy with your own cert (e.g. Caddy) for HTTPS.');
    console.error('');
    console.error('Continuing without HTTPS...');
    process.exit(0);
  }
  console.error('tailscale cert failed:', msg);
  process.exit(1);
}

console.log(`Cert saved: ${path.join(certDir, host + '.crt')}`);
console.log(`Key saved:  ${path.join(certDir, host + '.key')}`);

// Write TAILSCALE_HOST into .env so the servers pick up HTTPS.
const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
try {
  let env = '';
  try { env = fs.readFileSync(envFile, 'utf8'); } catch {}
  if (!/^TAILSCALE_HOST=/m.test(env)) {
    env += (env.endsWith('\n') ? '' : '\n') + `TAILSCALE_HOST=${host}\n`;
    fs.writeFileSync(envFile, env);
    console.log('TAILSCALE_HOST written to .env');
  } else {
    console.log('TAILSCALE_HOST already set in .env');
  }
} catch (e) {
  console.warn('Could not write TAILSCALE_HOST to .env:', e.message);
}
console.log('HTTPS enabled. Restart the servers to pick it up.');
