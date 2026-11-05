# dsh-sidebar-reader

[English](README.md) | [中文](README.zh.md)

Let your model read the **current session's** sidebar on demand: official right-sidebar tabs, terminal screens, and browser page text.

Once installed, just tell the model "read my sidebar" or "show me my terminal" — the model triggers a capture through the plugin's command channel and receives a snapshot within seconds.

## How it works

```
model ──POST /sidebar-reader/command──▶ host route (lib/index.js)
                                  client polls every 2s
                                          ▼
                     client capture (lib/client.js, runs in the Web UI)
                     ├── right-sidebar tabs (sidebarRight.openTabs, current session only)
                     ├── terminal screens (remote.terminal.attach, first full-screen snapshot)
                     └── web page text (webview innerText, desktop only)
                                          │
              client ──POST /sidebar-reader/latest──▶ host keeps the latest snapshot only
model ◀──GET /sidebar-reader/latest─── host
```

## Agent tool (auto-registered)

The plugin's host side registers a native agent tool **`sidebar_read`** with the DSH tool registry: it appears in every new session's tool list automatically, and one **zero-argument call** returns the full snapshot (web page text + sidebar tabs + terminal screens) — no HTTP, no configuration. The "prefer this over pwsh/web_fetch for terminal or page questions" preference is encoded in the tool description itself.

The HTTP endpoints below remain as a fallback channel.

## Features

| Channel | Source | Notes |
|---|---|---|
| Right-sidebar tabs | `sidebarRight.openTabs` live snapshot | Files / folders / documents / browser / terminal tabs — **current session only** |
| Terminal screens | `remote.terminal.attach` first snapshot frame | Full screen including scrollback; input control is released right after reading |
| Web page text | Sidebar browser webview `innerText` | **Desktop (Electron) only**; quietly returns null in a plain browser |

Design disciplines:

1. **Scope** — everything is filtered to the session on screen before leaving the browser; other sessions are unreadable;
2. **Never throws** — each channel degrades independently; one failing channel doesn't break the others;
3. **Transparent** — a toast is shown on every read;
4. **Revocable** — all side effects live in `ctx.effect` and are cleaned up when the plugin is disabled.

## Install

```sh
# From a plugin market (dshmarket / the official Discover tab, once listed): search "Sidebar Reader"
# or via CLI:
dsh plugin --profile <your-profile> add dsh-sidebar-reader
```

On the official DSH Desktop app, install from the app's own **Settings → Plugins**.

For local development: clone this repo anywhere and point the plugin manager's local install at the folder (pnpm link).

## Requirements

- **DSH >= 0.2.1-rc.2** (terminal capture uses `remote.terminal.attach`; on 0.2.0-rc.2 the plugin loads and tabs work, but terminal capture errors out — that version still called it `follow`)
- **No better-sidebar required** — official services only (`sidebarRight`, `remote.terminal`)
- Web page text is desktop-only; the web build (browser access) still gets tabs + terminals

## Compatibility

| Host version | Loads | Sidebar tabs | Terminals | Web page text |
|---|---|---|---|---|
| >= 0.2.1-rc.2 | ✅ | ✅ | ✅ | desktop ✅ / web ❌ |
| 0.2.0-rc.2 | ✅ | ✅ | ❌ (API renamed follow→attach) | desktop ✅ / web ❌ |

## Privacy & security

- Reads the current session only; other sessions' data never leaves the browser;
- Everything stays on your machine: host routes sit on loopback HTTP (`/sidebar-reader/*`), no browser auth, nothing leaves the machine;
- Every read is announced with a toast — no silent capture;
- No telemetry, no external requests.

## Host routes (prefix `/sidebar-reader`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Self-check: snapshot present? command pending? |
| `/latest` | GET | Model reads the snapshot (404 when empty) |
| `/latest` | POST | Client submits a snapshot (replace-only-latest) |
| `/command` | GET | Client claims a command (consume-on-read) |
| `/command` | POST | Model issues a command |

## License

[MIT](LICENSE)
