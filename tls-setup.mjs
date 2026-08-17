// Fetch Tailscale HTTPS cert for the MagicDNS name and store it for the servers.
// Usage: node tls-setup.mjs [hostname]
// If hostname omitted, uses `tailscale status --json` to find this machine's DNSName.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
  execFileSync(TS, ['cert', host], { cwd: certDir, stdio: 'inherit' });
} catch (e) {
  const msg = (e.message || '').toString();
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
console.log(`Set TAILSCALE_HOST=${host} in .env (already done automatically) to enable HTTPS.`);
