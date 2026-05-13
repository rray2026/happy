#!/bin/bash
# Install a per-user LaunchAgent that auto-starts cowork-agent at login and
# keeps it alive after crashes. Pairs with packages/cowork-tunnel-rotate
# so a host reboot brings the whole stack — agent on :4000, cloudflared
# rotation in front — back online unattended.
#
# Idempotent: re-run with different flags to update the plist and reload.
#
# Usage:
#   ./install-autostart.sh [--flavor claude|gemini] [--model NAME] [--port N]
#
# Defaults:
#   --flavor claude
#   --port   4000

set -euo pipefail

FLAVOR="${COWORK_AGENT_FLAVOR:-claude}"
MODEL="${COWORK_AGENT_MODEL:-}"
PORT="${COWORK_AGENT_PORT:-4000}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flavor) FLAVOR="$2"; shift 2 ;;
        --model)  MODEL="$2"; shift 2 ;;
        --port)   PORT="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,17p' "$0"
            exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 2 ;;
    esac
done

if [[ "$OSTYPE" != darwin* ]]; then
    echo "This installer is macOS-only (uses launchd). Aborting." >&2
    exit 1
fi
if [[ "$FLAVOR" != "claude" && "$FLAVOR" != "gemini" ]]; then
    echo "--flavor must be 'claude' or 'gemini'" >&2
    exit 2
fi

# Resolve binaries up-front and bake their absolute paths into the plist.
# launchd starts with a minimal PATH, and node-via-nvm in particular lives
# at a version-specific path that needs to be in scope before cowork-agent
# can spawn its CLI children.
NODE_BIN=$(command -v node || true)
[[ -z "$NODE_BIN" ]] && { echo "node not found in PATH" >&2; exit 1; }
CLI_BIN=$(command -v "$FLAVOR" || true)
[[ -z "$CLI_BIN" ]] && { echo "${FLAVOR} CLI not found in PATH (expected for --flavor=${FLAVOR})" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_ENTRY="$AGENT_ROOT/bin/cowork-agent.mjs"
[[ -f "$AGENT_ENTRY" ]] || { echo "cowork-agent entry not found: $AGENT_ENTRY" >&2; exit 1; }

# Compose PATH from the dirs containing node and the agent CLI, plus the
# usual macOS defaults. Keeps the agent's spawn calls (claude / gemini)
# resolvable even though launchd ignores the user shell environment.
# `/usr/sbin` is non-optional: gemini-cli probes the system architecture
# via `execFileSync('sysctl', ...)` without an absolute path, and
# launchd's default PATH omits sbin entirely — without this entry the
# whole gemini subprocess dies with `spawnSync sysctl ENOENT`.
NODE_DIR=$(dirname "$NODE_BIN")
CLI_DIR=$(dirname "$CLI_BIN")
LAUNCH_PATH="${NODE_DIR}:${CLI_DIR}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LABEL="com.cowork.agent"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/${LABEL}.plist"
LOG_OUT="/tmp/${LABEL}.log"
LOG_ERR="/tmp/${LABEL}.err"
mkdir -p "$LAUNCH_AGENTS"

# --- tear down prior state ----------------------------------------------------
[[ -f "$PLIST" ]] && launchctl unload "$PLIST" 2>/dev/null || true

# Kill manually-started agents pointing at the same port so the new
# LaunchAgent doesn't immediately exit on a bind error. cowork-agent
# exits cleanly on SIGTERM so a graceful try first, SIGKILL fallback
# only if it lingers.
pkill -TERM -f "cowork-agent.*serve" 2>/dev/null || true
for _ in $(seq 1 6); do
    pgrep -f "cowork-agent.*serve" >/dev/null || break
    sleep 1
done
pkill -KILL -f "cowork-agent.*serve" 2>/dev/null || true

# --- write plist --------------------------------------------------------------
# Build ProgramArguments dynamically so --model only appears when set.
ARGS_XML="<string>${NODE_BIN}</string>
        <string>${AGENT_ENTRY}</string>
        <string>serve</string>
        <string>--${FLAVOR}</string>"
if [[ -n "$MODEL" ]]; then
    ARGS_XML+="
        <string>--model</string>
        <string>${MODEL}</string>"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        ${ARGS_XML}
    </array>
    <key>WorkingDirectory</key><string>${AGENT_ROOT}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${LOG_OUT}</string>
    <key>StandardErrorPath</key><string>${LOG_ERR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${LAUNCH_PATH}</string>
        <key>HOME</key><string>${HOME}</string>
        <key>COWORK_AGENT_PORT</key><string>${PORT}</string>
    </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST"

# --- report -------------------------------------------------------------------
echo
echo "Installed cowork-agent auto-start:"
echo "  plist:    $PLIST"
echo "  node:     $NODE_BIN"
echo "  agent:    $AGENT_ENTRY"
echo "  flavor:   $FLAVOR${MODEL:+ (--model $MODEL)}"
echo "  port:     $PORT"
echo "  logs:     $LOG_OUT"
echo "            $LOG_ERR"
echo

sleep 3
if launchctl list | grep -q "${LABEL}"; then
    echo "[OK] LaunchAgent loaded."
else
    echo "[!] LaunchAgent not visible in launchctl list — check $LOG_ERR." >&2
    exit 1
fi
if pgrep -f "${AGENT_ENTRY}.*serve" >/dev/null; then
    echo "[OK] cowork-agent running."
else
    echo "[!] agent did not start within 3s — tail $LOG_ERR for details." >&2
fi
