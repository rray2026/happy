#!/bin/bash
# Remove the cowork-agent LaunchAgent and any process it owns. Idempotent.

set -euo pipefail

LABEL="com.cowork.agent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_OUT="/tmp/${LABEL}.log"
LOG_ERR="/tmp/${LABEL}.err"

if [[ -f "$PLIST" ]]; then
    launchctl unload "$PLIST" 2>/dev/null || true
fi

# Belt and suspenders: drain anything launchd missed plus any manually-
# started cowork-agent on this host.
pkill -TERM -f "cowork-agent.*serve" 2>/dev/null || true
for _ in $(seq 1 6); do
    pgrep -f "cowork-agent.*serve" >/dev/null || break
    sleep 1
done
pkill -KILL -f "cowork-agent.*serve" 2>/dev/null || true

rm -f "$PLIST" "$LOG_OUT" "$LOG_ERR"

echo
if launchctl list 2>/dev/null | grep -q "${LABEL}"; then
    echo "[!] ${LABEL} still in launchctl list — try \`launchctl bootout gui/\$(id -u)/${LABEL}\`." >&2
    exit 1
fi
echo "[OK] LaunchAgent removed."
if pgrep -f "cowork-agent.*serve" >/dev/null; then
    echo "[!] cowork-agent process still running — inspect with: pgrep -fl cowork-agent" >&2
    exit 1
fi
echo "[OK] no stray cowork-agent process."
