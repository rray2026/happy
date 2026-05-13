# cowork-tunnel-rotate

macOS LaunchAgent pair that keeps a `cloudflared` tunnel up for
`cowork-agent` and **rotates the connectors on a fixed cadence with zero
public downtime**.

## Architecture — dual phase-offset connectors

Two LaunchAgents (`com.cowork.tunnel-rotate.a` / `.b`) each run one
cloudflared connector, both pointed at the same Cloudflare tunnel. Their
lifecycles are 180° out of phase, so at any moment one is "fresh" (just
started) and the other is "aged" (about to recycle). Cloudflare load-
balances over both connectors, so the inevitable 1–3s connector
handshake never reaches the public URL.

```
t=0         instance a starts ──────────────────► dies at t=3600 ──► restart
                                                                       │
t=1800           instance b starts ──────────────────► dies at t=5400 ─┼─► restart
                                                                       │
            ←────  rotation moments at 3600, 5400, 7200, …  ───────────┘

At any t, the OTHER instance has been alive for 1800s already —
plenty of time to be fully connected with its 2 HA edge connections.
```

The stagger is applied as a one-shot `INITIAL_DELAY` only on the very
first launch after install; subsequent KeepAlive restarts skip it so the
cadence stays correct. The sentinel that tracks "have we served the
initial delay yet" lives in `/tmp` so a host reboot re-staggers from
scratch — desired behavior.

## Requirements

- macOS (launchd)
- `cloudflared` on `PATH` — install with `brew install cloudflared`
- A tunnel already created and authenticated:
  `cloudflared tunnel create <name>`

## Install

```bash
cd packages/cowork-tunnel-rotate
./scripts/install.sh
```

With non-default config:

```bash
./scripts/install.sh \
    --tunnel my-tunnel \
    --url http://localhost:4000 \
    --interval 3600
```

| Flag | Default | Env var |
|---|---|---|
| `--tunnel` | `my-tunnel` | `TUNNEL_NAME` |
| `--url` | `http://localhost:4000` | `LOCAL_URL` |
| `--interval` | `3600` (per-connector lifetime, in seconds) | `ROTATE_SECONDS` |

The phase offset is always half of `--interval`.

The installer is **idempotent** — re-running with new flags tears down
any prior instances (and the legacy single-instance plist from earlier
versions), wipes the stagger sentinels, kills running cloudflareds, and
reinstalls cleanly.

Immediately after install, only instance `a`'s cloudflared is running;
instance `b` waits `--interval`/2 seconds before its first start.

## Uninstall

```bash
./scripts/uninstall.sh
```

Unloads both LaunchAgents (and the legacy single-instance plist if
present), SIGTERMs/SIGKILLs any cloudflared they owned, removes plists +
sentinels + logs.

## Operations

| Action | Command |
|---|---|
| Force restart instance a | `launchctl kickstart -k gui/$(id -u)/com.cowork.tunnel-rotate.a` |
| Force restart instance b | `launchctl kickstart -k gui/$(id -u)/com.cowork.tunnel-rotate.b` |
| Pause both | `launchctl unload ~/Library/LaunchAgents/com.cowork.tunnel-rotate.{a,b}.plist` |
| Resume both | `launchctl load ~/Library/LaunchAgents/com.cowork.tunnel-rotate.{a,b}.plist` |
| Tail all logs | `tail -f /tmp/com.cowork.tunnel-rotate.*.{log,err}` |
| Status | `launchctl list \| grep com.cowork.tunnel-rotate` |
| See edge connections | both `127.0.0.1:20241/ready` and `:20242/ready` (cloudflared auto-picks port) |

## Files

- `scripts/wrapper.sh` — the actual process launchd runs; config-free,
  reads env vars set by each plist.
- `scripts/install.sh` — generates both plists, loads them.
- `scripts/uninstall.sh` — reverses cleanly.
- `~/Library/LaunchAgents/com.cowork.tunnel-rotate.a.plist`
- `~/Library/LaunchAgents/com.cowork.tunnel-rotate.b.plist`

## Why two connectors instead of one?

A single connector restart costs 1–3s of public-facing downtime while
the new process handshakes with the Cloudflare edge. For an interactive
voice-mode webapp talking through the tunnel, that means dropped
WebSocket frames and a reconnect spinner once an hour.

Two phase-offset connectors hide the rotation: Cloudflare's tunnel
infrastructure already supports multiple connectors per tunnel as a
first-class HA feature, and balances traffic across them. When one is
mid-restart the other carries the full load — the only cost is a brief
single-replica window every half-interval, which Cloudflare's natural
retries absorb invisibly.

If you don't need zero-downtime rotation, running a single connector
manually (no LaunchAgent) is perfectly fine — cloudflared's built-in HA
auto-reconnect handles most failure modes already.

## Pairs with `cowork-agent` auto-start

This package rotates the **tunnel**; it doesn't keep the **origin**
alive. If `cowork-agent` isn't running on `LOCAL_URL`, cloudflared will
happily proxy 502s through the freshly-rotated connections. The
companion installer at `packages/cowork-agent/scripts/install-autostart.sh`
puts cowork-agent itself under launchd so a host reboot brings the full
stack back online. Run both for a hands-off deployment:

```bash
packages/cowork-agent/scripts/install-autostart.sh
packages/cowork-tunnel-rotate/scripts/install.sh
```
