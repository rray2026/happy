# cowork-agent autostart (macOS)

Two shell scripts to drop a LaunchAgent that auto-starts `cowork-agent serve`
at user login (and restarts it on crash via `KeepAlive`). Pairs with the
sibling [`cowork-tunnel-rotate`](../../cowork-tunnel-rotate/README.md)
package so the whole stack — agent on `:4000`, cloudflared rotation in
front — comes back online after a reboot without manual intervention.

## Install

```bash
./install-autostart.sh                       # defaults: --flavor claude --port 4000
./install-autostart.sh --flavor gemini       # gemini variant
./install-autostart.sh --model haiku         # passes --model to the agent CLI
```

The installer is idempotent — re-running rewrites the plist and reloads.
Logs land at `/tmp/com.cowork.agent.{log,err}`.

## Uninstall

```bash
./uninstall-autostart.sh
```

## ⚠️ macOS TCC caveat (Documents / Desktop / Downloads)

If your `cowork` checkout lives under `~/Documents/`, `~/Desktop/`, or
`~/Downloads/`, **the LaunchAgent will hang on startup** because macOS's
"Files and Folders" privacy gate (TCC) blocks launchd-spawned processes
from accessing those protected directories. The symptom is a Node process
sitting idle in `getcwd()` indefinitely — no log output, port 4000 never
bound, `pgrep`/`launchctl list` show the job running but unresponsive.

You'll know if this is hitting you:

```bash
sample $(pgrep -f cowork-agent.mjs) 1 2>&1 | grep -A1 uv_cwd
# stuck in __getcwd → open$NOCANCEL = TCC block
```

Three ways out:

1. **Grant the node binary Full Disk Access**
   System Settings → Privacy & Security → Full Disk Access → `+` → add
   `$(which node)` (e.g. `/Users/<you>/.nvm/versions/node/<ver>/bin/node`).
   Then `launchctl unload + load` the plist. One-time gesture; trade-off
   is any node script under that binary now has full-disk read scope.

2. **Move the repo out of protected folders**
   Anywhere under `~/` that isn't Documents / Desktop / Downloads works
   — `~/Workspace/`, `~/Code/`, `~/src/`, `~/.local/share/cowork/` etc.
   No FDA needed.

3. **Don't use the LaunchAgent**
   `nohup node bin/cowork-agent.mjs serve --claude &` from a terminal
   session inherits the terminal's TCC permissions and works fine. Trade
   off the auto-restart-on-reboot convenience.

The scripts themselves are correct — this is purely a TCC interaction
between launchd and macOS's privacy framework. If the agent already runs
manually from your shell, the scripts will work the moment the binary or
the repo is in a TCC-friendly location.
