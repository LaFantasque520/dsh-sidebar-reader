# dsh-sidebar-reader

[English](README.md) | [中文](README.zh.md)

Let your model read the **current session's** sidebar on demand: the active tab, official right-sidebar tabs, terminal screens, and browser page text.

Once installed, just tell the model "read my sidebar" or "show me my terminal" — the model triggers a capture through the plugin's command channel and receives a snapshot within seconds.

## How it works

```
model ──POST /sidebar-reader/command──▶ host route (lib/index.js)
                                  client polls every 2s
                                          ▼
                     client capture (lib/client.js, runs in the Web UI)
                     ├── active tab (sidebarRight.active(), active pane's active tab)
                     ├── right-sidebar tabs (sidebarRight.openTabs, current session only)
                     ├── terminal screens (remote.terminal.attach, first full-screen snapshot)
                     └── web page text (webview innerText, desktop only)
                                          │
              client ──POST /sidebar-reader/latest──▶ host keeps the latest snapshot only
model ◀──GET /sidebar-reader/latest─── host
```

## Agent tool (auto-registered)

The plugin's host side registers a native agent tool **`sidebar_read`** with the DSH tool registry: it appears in every new session's tool list automatically, and one **zero-argument call** returns the full snapshot — no HTTP, no configuration. The "prefer this over pwsh/web_fetch for terminal or page questions" preference is encoded in the tool description itself.

The HTTP endpoints below remain as a fallback channel.

## Features

| Channel | Source | Notes |
|---|---|---|
| Active tab | `sidebarRight.active()` | The active pane's active tab (id / kind / title / contentId), plus `expanded` telling whether the column is showing |
| Right-sidebar tabs | `sidebarRight.openTabs` live snapshot | Every open tab of the current session (`tabId` / `kind` / `contentId`) |
| Terminal screens | `remote.terminal.attach` first snapshot frame | Full screen including scrollback; input control is released right after reading |
| Web page text | Sidebar browser webview `innerText` | **Desktop (Electron) only**; strict mode, see below |

### Strict mode for web page text

The page is read only when **the active tab is a browser** *and* **the column is expanded**. Otherwise `page` is `null`.

Why: when a sidebar browser tab moves to the background, its webview stays in the DOM with zero width, and the fallback picker would still return it — the model would receive a page the user is not looking at. `null` is better than the wrong page.

## What you get

| What you are looking at | Readable | Notes |
|---|---|---|
| A page in the sidebar browser | ✅ title + URL + text | Must be the active browser tab, with the column expanded |
| A file / document tab | ⚠️ address only | You get its `contentId` (e.g. `dsh-resource://file/...`); read the file by that path |
| A terminal | ✅ full screen | Includes scrollback (max 40k chars per terminal) |
| Plain web build (browser access) | ❌ page text | No webview; tabs and terminals still work |

## Snapshot example

```json
{
  "page": { "title": "…", "url": "https://…", "text": "…", "chars": 1235 },
  "right": {
    "sessionId": "session-…",
    "expanded": true,
    "active": { "id": "tab5", "type": "browser", "title": "Browser", "path": "sidebar://browser/…" },
    "tabs": [
      { "id": "tab3", "type": "files", "path": "sidebar://files" },
      { "id": "tab5", "type": "browser", "path": "sidebar://browser/…" }
    ]
  },
  "terminals": { "sessionId": "session-…", "terminals": [ { "id": "…", "title": "…", "state": "running", "screen": "…" } ] },
  "commandId": "cmd-…",
  "receivedAt": "2026-11-08T13:11:42.350Z"
}
```

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

On the official DSH Desktop app, install from the app's own **Settings → Plugins** (or clone this repo anywhere and point the plugin manager's local install at the folder).

## Requirements

- **DSH >= 0.2.1-rc.2** (terminal capture uses `remote.terminal.attach`; on 0.2.0-rc.2 the plugin loads and tabs work, but terminal capture errors out — that version still called it `follow`)
- **No better-sidebar required** — official services only (`sidebarRight`, `remote.terminal`)
- Web page text is desktop-only; the web build still gets the active tab, tabs and terminals

## Compatibility

| Host version | Loads | Active tab | Sidebar tabs | Terminals | Web page text |
|---|---|---|---|---|---|
| 0.2.1-rc.2 ~ 0.2.2-rc.1 | ✅ | ✅ | ✅ | ✅ | desktop ✅ / web ❌ |
| 0.2.0-rc.2 | ✅ | ⚠️ | ✅ | ❌ (API renamed follow→attach) | desktop ✅ / web ❌ |

Verified: all four channels on 0.2.1-rc.5; install + composition + client module registration on 0.2.1-rc.2 and 0.2.2-rc.1 (`scripts/test-plugin.ps1`).

## Development & testing

Two Windows PowerShell scripts ship with the repo:

```powershell
# 1) Smoke test against a running GUI port: host route + client polling + snapshot
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-plugin.ps1 -Port 53233

# 2) Multi-version compatibility test: isolated directory + DSH_HOME per version
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-plugin.ps1 -Version 0.2.1-rc.2 -Port 6123
```

Two traps worth knowing:

- **Client changes require a page refresh**: the host swaps the bundle immediately (rev changes), but a module already loaded in the page is not replaced — HMR graph sync only adds/removes entries, it does not replace an existing one;
- **The `id` in `__ModuleLoader__.load({ id })` must equal the npm package name** (including scope). DSH's client module system matches registrations by package name; a mismatch fails silently — `sidebar_read` still answers, but every capture times out.

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

## Changelog

- **1.0.1** — fixed the client module registration id not matching the package name (previously the client never loaded on any host, surfacing as `capture timed out`); `tabs[].id` now carries the real `tabId`; added `right.active` (the active tab) and `right.expanded`; web page text is now strict mode (`null` unless a browser tab is active and the column is expanded).
- **1.0.0** — first release.

## License

[MIT](LICENSE)
