# ⌘ Command Code Remote

Run [Command Code](https://commandcode.ai) from your phone — anywhere.

A self-hosted bridge that gives you **the full interactive Command Code terminal** (plus a
clean chat UI) in your phone's browser, securely tunneled through [Tailscale](https://tailscale.com).
No open ports, no cloud dependency — your PC does all the work.

![terminal](https://img.shields.io/badge/terminal-xterm.js-4f8cff) ![stack](https://img.shields.io/badge/stack-node.js%20%2B%20node--pty-7c5cff)

## Download

| Platform | Installer | What it does |
|---|---|---|
| 📱 **Android** | [`CmdRemote-Android.apk`](https://github.com/wxgmin/cmd-remote/releases/latest) | Native app — settings screen for server URL + token, opens the full terminal |
| 🖥️ **Windows** | [`CmdRemote-Windows.exe`](https://github.com/wxgmin/cmd-remote/releases/latest) | One-click installer — installs to `%LOCALAPPDATA%`, checks/installs Node.js, runs setup, creates Start Menu + desktop shortcuts |

**Latest release:** https://github.com/wxgmin/cmd-remote/releases/latest
(Both installers are built automatically in CI and attached to every `v*` release tag.)

- **Android:** allow "Install unknown apps", open the APK, install, enter your PC's
  Tailscale URL + token on first launch.
- **Windows:** run the .exe, follow the wizard — it checks for Node.js (installs it if
  missing), copies the app, runs the one-command setup, and creates shortcuts.

## What you get

| | Full Terminal (port 8788) | Chat UI (port 8787) |
|---|---|---|
| Interface | The **actual Command Code TUI** (banner, `❯ Ask your question...`, thinking, tool events, permission prompts, `/` menus) rendered via web PTY | Clean chat bubbles, slash-command palette |
| Session sync | ✅ **Two-way** — sessions write to `~/.commandcode/projects/` exactly like a local terminal; phone convos appear in `/resume` on your PC and vice versa | One-way — proxy-owned history, but can browse/continue real terminal sessions |
| Keyboard | Full TUI shortcuts | Chat-style Enter-to-send |

## Why this beats SSH-on-phone

- No SSH server setup, no key management, no terminal app needed — just a browser
- **Same session files** as your desktop terminal: `~/.commandcode/projects/<slug>/<id>.jsonl`
- Works over cellular/any Wi-Fi via Tailscale's encrypted mesh — zero ports exposed
- Installable as a PWA (Add to Home Screen → fullscreen app icon)
- **Native Android app** (WebView wrapper) — see below

## Android app (APK)

A small native Android app wraps the terminal so it feels like a real app, not a browser
tab. It has a settings screen (server address + token, saved locally) and opens the full
terminal in a WebView.

- **Download:** [`CmdRemote-Android.apk`](https://github.com/wxgmin/cmd-remote/releases/latest)
  from the latest release.
- **Install:** allow "Install unknown apps" for your browser/downloads app, open the APK,
  install, then enter your PC's Tailscale URL + token on first launch.
- **Build it yourself:** push a tag (`git tag v1.0.0 && git push origin v1.0.0`) and the
  workflow produces the APK in CI — no Android SDK needed locally.

> Note: the app uses `usesCleartextTraffic=true` so it works over plain HTTP on your
> tailnet. If you later enable HTTPS via `tailscale cert`, that stays working too.

## Windows installer (EXE)

A one-click NSIS installer wraps the whole app:

- Installs to `%LOCALAPPDATA%\CmdRemote` (no admin needed)
- Checks for Node.js — if missing, offers to install it via winget
- Runs the one-command setup (deps, token, Tailscale, firewall, servers)
- Creates Start Menu + desktop shortcuts
- Registers in Add/Remove Programs (with uninstaller)

- **Download:** [`CmdRemote-Windows.exe`](https://github.com/wxgmin/cmd-remote/releases/latest)
  from the latest release.

## Quick start

**Prereqs:** [Node.js 18+](https://nodejs.org), [Tailscale](https://tailscale.com/download)
installed and logged in on your PC.

```bat
git clone https://github.com/<you>/cmd-remote.git
cd cmd-remote
npm run setup     REM one-command setup: deps, Tailscale, token, firewall, servers, URLs
```

Or the manual path:

```bat
install.bat      REM installs deps, generates a token, sets up HTTPS if possible
start.bat        REM starts both servers, prints your phone URLs
```

On your phone: install the **Tailscale app**, sign in with the **same account**, then open:

```
http://<your-pc-magicdns-name>:8788/?token=<your-token>    ← full terminal
http://<your-pc-magicdns-name>:8787/?token=<your-token>    ← chat UI
```

Run `url.cmd` on the PC any time to print all URLs (local / LAN / Tailscale).

## Give it to a friend (one-command setup)

Everything is designed so a friend (or another machine with Command Code) can point at
this repo and be running in minutes. The repo ships an `AGENTS.md` that any Command Code
instance reads automatically.

**What the friend does:**

1. Make sure [Node.js 18+](https://nodejs.org) is installed.
2. Tell their Command Code: *"Set up https://github.com/wxgmin/cmd-remote"* — it clones,
   runs `npm run setup`, and walks through anything interactive (Tailscale login).
3. Or manually: `git clone ... && cd cmd-remote && npm run setup`.

**What `npm run setup` handles automatically:**

- Installs dependencies
- Finds or **auto-installs Tailscale** (winget / brew / install script) and prompts for
  login if needed (`tailscale up` opens the browser)
- Brings up the tailnet and reads the machine's MagicDNS name
- Generates a **per-machine token** into `.env` (never overwrites an existing one)
- Fetches a Tailscale HTTPS cert when the plan allows (free plan degrades gracefully)
- Adds the Windows Firewall rule (UAC prompt), creates a desktop shortcut
- Starts both servers detached
- Prints the exact phone URLs (Local / LAN / Anywhere / MagicDNS)

**Phone side:** install the Android APK from
[GitHub Releases](https://github.com/wxgmin/cmd-remote/releases) (asset `app-debug.apk`),
open it, enter the PC's URL + token from the setup summary. Done.

> Both machines must be on the same Tailscale tailnet (same account, or the friend is
> added to yours) for anywhere-access. On the same Wi-Fi, no Tailscale needed at all.

## Configuration (`.env`)

| Key | Default | Purpose |
| --- | ------- | ------- |
| `CMD_REMOTE_TOKEN` | *(required)* | Bearer token gating every request and websocket |
| `PORT` | `8787` | Chat server port |
| `TTY_PORT` | `8788` | Terminal server port |
| `HOST` | `0.0.0.0` | Bind address |
| `WORK_DIR` | server's cwd | Working directory the agent operates in |
| `CMD_ENTRY` | auto-detected | Command Code JS entry (override if auto-detect fails) |
| `TAILSCALE_HOST` | auto | MagicDNS name; enables HTTPS via `tailscale cert` (Premium) |

Generate a token: `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`

## HTTPS (optional, for full PWA install)

Service workers / PWA "Install app" prompts require HTTPS. If your Tailscale plan supports
certs (`tailscale cert`), run `node tls-setup.mjs` once and set `TAILSCALE_HOST` in `.env`.
Without HTTPS, Android still offers **Add to Home Screen**, which opens fullscreen.

## Architecture

```
phone browser ──Tailscale mesh VPN──► PC:8788 ──node-pty (ConPTY)──► cmd TUI
                                    │                                   │
                                    └─► writes ~/.commandcode/projects/  │
                                        ▲ (same files your terminal uses)│
PC terminal ◄───────────────────────────┘ resume with /resume           │
phone browser ──► PC:8787 ──spawn──► cmd -p --output-format json --yolo ─┘
```

- `server.js` — chat proxy: spawns `cmd -p` per message, streams NDJSON over WebSocket,
  slash commands, terminal-session sync API
- `tty-server.mjs` — web PTY: node-pty ConPTY + xterm.js, renders the real interactive TUI
- `lib/util.mjs` — Tailscale/TLS helpers shared by both
- `tls-setup.mjs` — fetches a Tailscale HTTPS cert for the MagicDNS name
- `public/` — PWA shell (manifest, service worker, icons), chat UI, terminal UI

## Security

- The agent runs with **full shell + file access** (`--yolo`) on `WORK_DIR` — treat the
  token as a password.
- Tailscale keeps everything on your private tailnet: no ports open to the internet.
- Never expose these ports publicly without TLS and a strong token.

## License

MIT
