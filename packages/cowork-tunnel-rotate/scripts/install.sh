#!/bin/bash
# Install / refresh the cloudflared-rotate dual-instance LaunchAgent pair.
#
# Two LaunchAgents (com.cowork.tunnel-rotate.a / .b) each run one
# cloudflared connector. They are phase-offset by ROTATE_SECONDS/2 so at
# every moment one is "fresh" and the other is "aged" — rotation gives
# zero public-facing downtime.
#
# Idempotent: re-run with new flags to update config; the script tears
# down any prior instances (and the legacy single-instance plist) before
# reinstalling.
#
# Usage:
#   ./install.sh [--tunnel NAME] [--url URL] [--interval SECONDS]
#
# Defaults:
#   --tunnel    my-tunnel
#   --url       http://localhost:4000
#   --interval  3600   (each connector lives this long; phase offset is half)

set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-my-tunnel}"
LOCAL_URL="${LOCAL_URL:-http://localhost:4000}"
ROTATE_SECONDS="${ROTATE_SECONDS:-3600}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tunnel)   TUNNEL_NAME="$2"; shift 2 ;;
        --url)      LOCAL_URL="$2"; shift 2 ;;
        --interval) ROTATE_SECONDS="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,20p' "$0"
            exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 2 ;;
    esac
done

if [[ "$OSTYPE" != darwin* ]]; then
    echo "This installer is macOS-only (uses launchd). Aborting." >&2
    exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared not found in PATH. Install it first: brew install cloudflared" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/wrapper.sh"
chmod +x "$WRAPPER"

LABEL_BASE="com.cowork.tunnel-rotate"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
OFFSET=$(( ROTATE_SECONDS / 2 ))

mkdir -p "$LAUNCH_AGENTS"

# --- tear down prior state ----------------------------------------------------
# Both instances + the legacy single-instance plist so re-running install
# after a config change leaves no stale agents behind.
for plist in \
    "$LAUNCH_AGENTS/${LABEL_BASE}.plist" \
    "$LAUNCH_AGENTS/${LABEL_BASE}.a.plist" \
    "$LAUNCH_AGENTS/${LABEL_BASE}.b.plist"; do
    [[ -f "$plist" ]] && launchctl unload "$plist" 2>/dev/null || true
done

# Kill any cloudflared we (or a previous install) had pointing at this
# tunnel so the new agents come up to a clean field. cloudflared's
# graceful shutdown can take up to ~30s on SIGTERM, so poll for up to 10s
# and then SIGKILL — we'd rather hard-kill than have stale connectors
# fighting the new pair.
pkill -TERM -f "cloudflared tunnel.*${TUNNEL_NAME}" 2>/dev/null || true
for _ in $(seq 1 10); do
    pgrep -f "cloudflared tunnel.*${TUNNEL_NAME}" >/dev/null || break
    sleep 1
done
pkill -KILL -f "cloudflared tunnel.*${TUNNEL_NAME}" 2>/dev/null || true

# Sentinels track whether the one-shot INITIAL_DELAY has already been
# applied. Wipe them so reinstalling re-staggers from scratch.
rm -f /tmp/${LABEL_BASE}.a.started /tmp/${LABEL_BASE}.b.started

# Remove the legacy single-instance plist file too.
rm -f "$LAUNCH_AGENTS/${LABEL_BASE}.plist"
rm -f /tmp/${LABEL_BASE}.log /tmp/${LABEL_BASE}.err

# --- write + load both plists -------------------------------------------------
write_plist() {
    local instance="$1"
    local delay="$2"
    local label="${LABEL_BASE}.${instance}"
    local plist="$LAUNCH_AGENTS/${label}.plist"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array><string>${WRAPPER}</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>/tmp/${label}.log</string>
    <key>StandardErrorPath</key><string>/tmp/${label}.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>TUNNEL_NAME</key><string>${TUNNEL_NAME}</string>
        <key>LOCAL_URL</key><string>${LOCAL_URL}</string>
        <key>ROTATE_SECONDS</key><string>${ROTATE_SECONDS}</string>
        <key>INITIAL_DELAY</key><string>${delay}</string>
        <key>INSTANCE_ID</key><string>${instance}</string>
    </dict>
</dict>
</plist>
EOF
    launchctl load "$plist"
}

write_plist a 0
write_plist b "$OFFSET"

# --- report -------------------------------------------------------------------
echo
echo "Installed dual-instance rotation:"
echo "  wrapper:   $WRAPPER"
echo "  tunnel:    $TUNNEL_NAME"
echo "  origin:    $LOCAL_URL"
echo "  lifetime:  ${ROTATE_SECONDS}s per connector"
echo "  stagger:   ${OFFSET}s (instance b's first start is delayed by this)"
echo "  logs:      /tmp/${LABEL_BASE}.a.{log,err}"
echo "             /tmp/${LABEL_BASE}.b.{log,err}"
echo

sleep 3
loaded_count=$(launchctl list | grep -c "^[0-9-]*[[:space:]].*${LABEL_BASE}\.[ab]$" || true)
if [[ "$loaded_count" -eq 2 ]]; then
    echo "[OK] both LaunchAgents loaded."
else
    echo "[!] expected 2 LaunchAgents loaded, found ${loaded_count} — check logs." >&2
fi

# Only instance "a" should have cloudflared running right now; "b" sleeps
# INITIAL_DELAY first before spawning its connector.
a_alive=$(pgrep -f "cloudflared tunnel.*${TUNNEL_NAME}" | wc -l | tr -d ' ')
if [[ "$a_alive" -ge 1 ]]; then
    echo "[OK] instance a's cloudflared is up (b will start in ${OFFSET}s)."
else
    echo "[!] no cloudflared running yet — tail /tmp/${LABEL_BASE}.a.err for details." >&2
fi
