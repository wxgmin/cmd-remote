// Shared Files + Obsidian API router. Mounted on BOTH servers (8787 chat and
// 8788 terminal) so the phone's Files/Browser pages work from either port.
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

export function fsApiRouter({ authOk, workDir, projectsDir }) {
  const r = express.Router();
  const OBSIDIAN_VAULT = path.join(os.homedir(), 'Documents', 'Obsidian Vault');

  function fsRoots() {
    // Roots the phone may browse. Always: working dir, agent session projects,
    // and the Obsidian vault (if it exists).
    const roots = [workDir, projectsDir];
    try { if (fs.existsSync(OBSIDIAN_VAULT)) roots.push(OBSIDIAN_VAULT); } catch {}
    return roots.map((p) => path.resolve(p));
  }
  function isInsideRoots(abs) {
    const roots = fsRoots();
    // Case-insensitive comparison (Windows paths are case-insensitive).
    const lower = abs.toLowerCase();
    return roots.some((r2) => {
      const rl = r2.toLowerCase();
      return lower === rl || lower.startsWith(rl + path.sep.toLowerCase());
    });
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

  r.get('/api/fs/list', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const p = safeFsPath(req.query.path || workDir);
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
  const BIN_EXT = new Set(['.xlsx', '.xls', '.tsv', '.pdf', '.docx', '.doc', '.pptx', '.zip', '.tar', '.gz']);
  // Secret-ish files that should never be previewable even under a root.
  const BLOCKED_BASENAMES = new Set(['.env', '.env.local', 'id_rsa', 'id_ed25519', 'id_ecdsa', '.netrc', '.npmrc', '.git-credentials', 'credential', 'credentials', 'secret', 'secrets', '.htpasswd']);

  r.get('/api/fs/file', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const p = safeFsPath(req.query.path);
    if (!p) return res.status(403).json({ error: 'Path not allowed' });
    const base = path.basename(p).toLowerCase();
    if (BLOCKED_BASENAMES.has(base) || base.endsWith('.pem') || base.endsWith('.key')) {
      return res.status(403).json({ error: 'file not viewable' });
    }
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
  r.get('/api/obsidian/vault', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ vault: fs.existsSync(OBSIDIAN_VAULT) ? OBSIDIAN_VAULT : null });
  });

  // Vault search: server-side scan of the vault (filename + text content).
  r.get('/api/obsidian/search', (req, res) => {
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
        const r2 = rel ? rel + '/' + d.name : d.name;
        if (d.isDirectory()) { walk(full, r2); continue; }
        if (d.name.toLowerCase().includes(q)) {
          let size = 0;
          try { size = fs.statSync(full).size; } catch {}
          results.push({ filename: r2, result: d.name, size });
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
                results.push({ filename: r2, result: snippet, size: content.length });
              }
            }
          } catch {}
        }
      }
    };
    walk(OBSIDIAN_VAULT, '');
    res.json({ available: true, results: results.slice(0, 50) });
  });

  return r;
}
