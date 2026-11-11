# dsh-sidebar-operator

Read the sidebar — and **drive** its terminals.

This is the integrated build of `dsh-sidebar-reader`: the read capability stays, terminal
write/open/close are added.

## Five tools

| Tool | Purpose |
|---|---|
| `sidebar_read` | Read the current session's sidebar: tabs, every terminal screen, browser page text |
| `terminal_list` | List retained terminals (id, title, state, cwd, shell) |
| `terminal_write` | Type text into a terminal and return the settled screen |
| `terminal_open` | Create a terminal, as a visible sidebar tab by default |
| `terminal_close` | Close a terminal: kill its process range |

## The gate

There is no command allowlist. The gate is the **session's sandbox policy**:

```
sandboxPolicy.resolve({session})
  mode === danger-full-access            → run immediately
  destructive head (format/reg/…)        → approval
  every path stays inside workspaceRoot  → run immediately
  any path outside the workspace         → approval
```

Approval goes through the host's native `ctx.approval.request()` (bottom approval UI), not a
custom dialog; the custom dialog is only a fallback when the approval service is unavailable.

- Session policy `never` (Full access preset) skips approval — otherwise `request()` returns
  `rejected` deterministically and the plugin would be unusable there.
- Every request / decision / run is appended to `~/.dsh/sidebar-operator-audit.log` (NDJSON).

## Protocol notes

- Writes use the official `remote.terminal.attach` duplex stream:
  `handle.send({type:"write",sequence,data})`; `sequence` increments from 1 with no gaps, and
  the caller must keep consuming output frames and wait for `ack`.
- The newest attachment holds input control; `abort` releases input only, the process keeps running.
- One write is capped at 4000 characters (the underlying `maxInputBytes` defaults to 64KB).
- `terminal_open` uses `sidebarRight.openTab('terminal')` — Host terminals outside the saved
  layout have no UI entry at all.

## Known behavior

- A write briefly takes over that terminal's keyboard; the GUI may ask you to click "take over input".
- The client skips polling while the page is hidden, so tools time out if the GUI is minimized.
- Path matching is heuristic (no shell variable expansion), and the terminal itself is not sandboxed.
- `terminal_close` always requires approval.

## Install

Copy into `~/.dsh/profiles/desktop/vendor/dsh-sidebar-operator` and
`node_modules/dsh-sidebar-operator`, add `"dsh-sidebar-operator": "file:vendor/dsh-sidebar-operator"`
to the profile dependencies and the package name to `dsh.profile.bundles`, then restart DSH.
