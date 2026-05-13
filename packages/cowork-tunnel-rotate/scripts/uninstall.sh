#!/bin/bash
# Remove the cloudflared-rotate dual-instance LaunchAgent pair (and any
# residual legacy single-instance plist) plus any cloudflared process they
# were managing. Idempotent.

set -euo pipefail

LABEL_BASE="com.cowork.tunnel-rotate"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

# Read tunnel name from any of the plists so we know exactly which
# cloudflared processes are ours. Falls back to a wildcard if all plists
# are already gone.
TUNNEL_NAME=""
for inst in a b ""; do
    suffix=""
    [[ -n "$inst" ]] && suffix=".${inst}"
    plist="${LAUNCH_AGENTS}/${LABEL_BASE}${suffix}.plist"
    if [[ -f "$plist" ]]; then
        TUNNEL_NAME=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:TUNNEL_NAME" "$plist" 2>/dev/null || true)
        [[ -n "$TUNNEL_NAME" ]] && break
    fi
done

# Unload everything we might have installed (including the old single-
# instance plist from earlier versions).
for plist in \
    "${LAUNCH_AGENTS}/${LABEL_BASE}.plist" \
    "${LAUNCH_AGENTS}/${LABEL_BASE}.a.plist" \
    "${LAUNCH_AGENTS}/${LABEL_BASE}.b.plist"; do
    [[ -f "$plist" ]] && launchctl unload "$plist" 2>/dev/null || true
done

# Defensive cleanup of cloudflared processes pointing at our tunnel — covers
# the case where unload didn't deliver SIGTERM in time, or someone started
# cloudflared by hand alongside.
PATTERN="cloudflared tunnel"
[[ -n "$TUNNEL_NAME" ]] && PATTERN="cloudflared tunnel.*${TUNNEL_NAME}"
pkill -TERM -f "$PATTERN" 2>/dev/null || true
for _ in $(seq 1 10); do
    pgrep -f "$PATTERN" >/dev/null || break
    sleep 1
done
pkill -KILL -f "$PATTERN" 2>/dev/null || true

# Remove plists, sentinels, logs.
rm -f \
    "${LAUNCH_AGENTS}/${LABEL_BASE}.plist" \
    "${LAUNCH_AGENTS}/${LABEL_BASE}.a.plist" \
    "${LAUNCH_AGENTS}/${LABEL_BASE}.b.plist" \
    /tmp/${LABEL_BASE}.started \
    /tmp/${LABEL_BASE}.a.started \
    /tmp/${LABEL_BASE}.b.started \
    /tmp/${LABEL_BASE}.log /tmp/${LABEL_BASE}.err \
    /tmp/${LABEL_BASE}.a.log /tmp/${LABEL_BASE}.a.err \
    /tmp/${LABEL_BASE}.b.log /tmp/${LABEL_BASE}.b.err

echo
remaining=$(launchctl list 2>/dev/null | grep -c "${LABEL_BASE}" || true)
if [[ "$remaining" -gt 0 ]]; then
    echo "[!] ${remaining} LaunchAgent(s) still in launchctl list — try:" >&2
    echo "    launchctl bootout gui/\$(id -u)/${LABEL_BASE}.a" >&2
    echo "    launchctl bootout gui/\$(id -u)/${LABEL_BASE}.b" >&2
    exit 1
fi
echo "[OK] LaunchAgents removed."

if [[ -n "$TUNNEL_NAME" ]] && pgrep -f "cloudflared tunnel.*${TUNNEL_NAME}" >/dev/null 2>&1; then
    echo "[!] cloudflared process for '$TUNNEL_NAME' still running — inspect with: pgrep -fl cloudflared" >&2
    exit 1
fi
echo "[OK] no stray cloudflared process."
