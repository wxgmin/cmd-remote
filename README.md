# ⌘ Command Code Remote

Run [Command Code](https://commandcode.ai) from your phone — anywhere.

A self-hosted bridge that gives you **the full interactive Command Code terminal** (plus a
clean chat UI) in your phone's browser, securely tunneled through [Tailscale](https://tailscale.com).
No open ports, no cloud dependency — your PC does all the work.

![terminal](https://img.shields.io/badge/terminal-xterm.js-4f8cff) ![stack](https://img.shields.io/badge/stack-node.js%20%2B%20node--pty-7c5cff)

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

## Quick start

**Prereqs:** [Node.js 18+](https://nodejs.org), [Tailscale](https://tailscale.com/download)
installed and logged in on your PC.

```bat
git clone https://github.com/<you>/cmd-remote.git
cd cmd-remote
install.bat      REM installs deps, generates a token, sets up HTTPS if possible
start.bat        REM starts both servers, prints your phone URLs
```

On your phone: install the **Tailscale app**, sign in with the **same account**, then open:

```
http://<your-pc-magicdns-name>:8788/?token=<your-token>    ← full terminal
http://<your-pc-magicdns-name>:8787/?token=<your-token>    ← chat UI
```

Run `url.cmd` on the PC any time to print all URLs (local / LAN / Tailscale).

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
