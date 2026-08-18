# AGENTS.md — cmd-remote setup instructions

This repo is a self-hosted bridge that runs Command Code from a phone (full terminal TUI on
port 8788, chat UI on port 8787). When a user asks you to "set this up", "install this",
"get cmd-remote running", or points you at this repo on a fresh machine, follow this guide.

## Quick setup (recommended)

1. **Prereqs**: Node.js >= 18 must be installed. If missing, install it (https://nodejs.org)
   and confirm with `node --version` before continuing.
2. **Clone**: `git clone https://github.com/wxgmin/cmd-remote.git && cd cmd-remote`
3. **Run the one-command setup**:
   ```
   npm run setup
   ```
   (This runs `node setup.mjs` — it installs deps, sets up Tailscale, generates a token,
   configures the firewall, starts both servers, and prints phone URLs.)

## What setup.mjs does automatically

- Installs npm dependencies
- Finds or installs Tailscale (winget on Windows, brew on macOS, install script on Linux)
- If Tailscale is not logged in: it runs `tailscale up` — on Windows this opens the login
  browser; on headless machines it prints a login URL. **Ask the user to complete that
  login**, then re-run `npm run setup`.
- Generates `CMD_REMOTE_TOKEN` in `.env` (never overwrites an existing token)
- Fetches a Tailscale HTTPS cert if the plan supports it (free plan degrades gracefully)
- Adds firewall rules (Windows, may prompt UAC)
- Starts both servers detached
- Prints a summary with Local / LAN / Anywhere / MagicDNS URLs

## After setup completes

1. Read the printed summary. Give the user:
   - The **Anywhere/MagicDNS URL** for port 8788 (the full terminal) plus the token,
     or point them to the URL line — they open it on their phone.
   - The **Android APK** is on GitHub Releases:
     https://github.com/wxgmin/cmd-remote/releases (asset `CmdRemote-Android-<ver>.apk`).
     The app asks for the server URL and token on first launch.
2. **Health check**: verify the servers respond:
   ```
   curl -s http://localhost:8787/api/status
   ```
   Expect `{"ok":true,...}`. Ports: chat proxy 8787, terminal 8788.
3. If the phone will connect from anywhere, ensure the PC and phone are on the **same
   Tailscale tailnet** (same account or shared tailnet). The phone needs the Tailscale app.

## Installing by pointing Command Code at this repo

If an agent is already running on the PC (e.g. this very Command Code session) and the user
wants cmd-remote installed, you can set it up from the repo itself:

1. Clone + install + start:
   ```
   git clone https://github.com/wxgmin/cmd-remote.git
   cd cmd-remote
   npm install
   npm run setup
   ```
   (`npm run setup` runs `node setup.mjs` — installs deps, sets up Tailscale, generates a
   token in `.env` if none exists, adds firewall rules, and starts both servers detached.)

2. **Read the token and URL to give the user** (the values they type/scan into the mobile
   app). After setup, get the token from the server's own panel endpoint:
   ```
   curl -s http://localhost:8787/api/panel | <parse "token" and "browserUrl">
   ```
   Or read the console output the setup printed (it prints `Phone URL (LAN)` /
   `ANYWHERE (Tailscale)` lines containing `?token=...`).
   - The **token** is the `?token=` value from those URLs (also in `.env` as
     `CMD_REMOTE_TOKEN`).
   - The **URL** the user enters in the mobile app is the full `browserUrl`
     (e.g. `http://100.125.35.110:8788/?token=<token>`) — or just the
     `http://<host>:8788` base and the token separately; the Android app accepts both.
   - Give the user BOTH the URL line AND the token explicitly — do not make them
     grep `.env` or the logs themselves.
 3. For a phone on the same Wi-Fi, the LAN URL works immediately. For anywhere-access,
    the user must be signed into the same Tailscale tailnet on the phone.

## Live browser view (Playwright MCP + shared browser)

cmd-remote starts a **shared browser** (Edge/Chrome) with a CDP debug port
(`--remote-debugging-port=9222`, profile in `~/.cmd-remote/browser-profile`). Playwright
MCP connects to it via `--cdp-endpoint http://127.0.0.1:9222` (see `~/.commandcode/mcp.json`),
so the agent and the phone's **🌐 Browser page** drive the SAME browser:

- The user watches the agent's browser live from the phone (`/browser.html` — live
  screenshots every ~1.5 s, tab strip, address bar, tap-to-click, type row).
- Browser API (all auth-gated): `GET /api/browser/tabs`, `GET /api/browser/screenshot`,
  `POST /api/browser/navigate|click|type|eval|newtab`.
- If the browser isn't running, the endpoints return `{available:false}` and the page
  shows "Browser not running"; the shared browser self-heals (each request re-spawns it).
- The Files page (`/files.html`) previews Excel/CSV/TSV via SheetJS (table + Export CSV),
  opens PDFs in the phone's built-in viewer, and shows images inline.

## Rules

- **Never commit `.env`** (it is gitignored). Never print the token into chat logs beyond
  the URL lines the setup script already prints.
- **Never modify** server.js / tty-server.mjs / public/ to "fix" setup — the setup flow is
  self-contained. If setup genuinely fails, read the error, fix the cause (missing
  prereq, Tailscale login), and re-run `npm run setup`.
- Re-running `npm run setup` is always safe (idempotent).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `node: command not found` | Install Node.js 18+ first |
| Tailscale not logged in | Complete `tailscale up` login (browser/URL), re-run setup |
| Phone can't reach PC on LAN | Run setup once as admin (firewall rule), or add rule manually for ports 8787/8788 |
| `Cannot GET /` on 8788 | Servers not started — re-run `npm run setup` |
| HTTPS cert warning | Expected on free Tailscale plan; the app works over HTTP on the tailnet |
