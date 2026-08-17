// Shared helpers for cmd-remote servers.
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find the Tailscale IPv4 address (100.x.y.z)
export function tailscaleIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && ni.address.startsWith('100.') && !ni.internal) {
        return ni.address;
      }
    }
  }
  return null;
}

export function lanIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

// Tailscale HTTPS certs: `tailscale cert <magicdns-name>` writes <name>.crt/.key
// in the given dir. Returns {cert, key, host} or null.
export function tailscaleTLS() {
  const certDir = path.join(os.homedir(), '.cmd-remote', 'tls');
  const host = process.env.TAILSCALE_HOST || null;
  if (!host) return null;
  const cert = path.join(certDir, `${host}.crt`);
  const key = path.join(certDir, `${host}.key`);
  if (fs.existsSync(cert) && fs.existsSync(key)) {
    return { cert, key, host };
  }
  return null;
}
