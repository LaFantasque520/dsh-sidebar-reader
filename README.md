# dsh-terminal-operator

Lets the model **drive** a sidebar terminal, not just read it.

## Tools

| Tool | Purpose |
|---|---|
| `terminal_list` | List terminals retained for the current session (id, title, state, cwd, shell) |
| `terminal_write` | Type text into a terminal and return the settled screen |
| `terminal_open` | Create an agent-owned terminal, returns its id |
| `terminal_close` | Close a terminal: kill its process range and free the slot |

## How it works

- **Host side is a mailbox**: `lib/index.js` registers `/terminal-operator/{command,result,health}` on the loopback `webServer` (no browser auth), and pairs four agent tools with the page through `pendingCommand` / `results`.
- **Client side holds the keyboard**: `lib/client.js` polls every 1.5s, opens the duplex stream with `ctx.remote.terminal.attach()`, sends `handle.send({type:"write",sequence,data})`, waits for `ack` while consuming output frames, then `abort()`s to release input control.
- The bridge is required because `remote.terminal` is a cordis-injected renderer service; the host process has no `ctx.remote`.

## Protocol notes (from the official terminal-controller)

- `sequence` increments from 1 with no gaps; `ack` must match in order.
- Frames must be consumed continuously; a slow subscriber is dropped.
- The newest attachment holds input control; `abort` releases input only, the process keeps running.

## Known behavior

- `terminal_write` briefly takes over that terminal's keyboard; after it disconnects the GUI may ask you to click "take over input".
- The client skips polling while the page is hidden, so tools time out if the GUI is minimized.
- Line-oriented commands only; full-screen TUIs (vim, top) do not apply.
- User terminals run with the system user's privileges, independent of the agent sandbox and approval policy.

## Local install

Copy the directory into `~/.dsh/profiles/desktop/vendor/dsh-terminal-operator` and
`~/.dsh/profiles/desktop/node_modules/dsh-terminal-operator`, add
`"dsh-terminal-operator": "file:vendor/dsh-terminal-operator"` to the profile dependencies and the
package name to `dsh.profile.bundles`, then restart DSH so the host bundle loads.
