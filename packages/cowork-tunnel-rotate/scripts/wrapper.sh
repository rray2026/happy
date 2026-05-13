#!/bin/bash
# The actual process launchd runs. One instance of this script manages one
# cloudflared connector: boots it, sleeps the configured lifetime, then
# SIGTERMs and exits — launchd's KeepAlive=true relaunches us. Two of
# these run in parallel (instance "a" and "b"), staggered so their
# rotations are out of phase by half the interval; at any moment the
# other connector is mid-lifetime and serving traffic, so rotation looks
# like zero downtime to the public.
#
# Env vars (set by the LaunchAgent plist that calls this script):
#   TUNNEL_NAME       cloudflared tunnel name
#   LOCAL_URL         origin URL cloudflared proxies
#   ROTATE_SECONDS    lifetime of a single connector (default 3600)
#   INITIAL_DELAY     one-shot offset applied only on the very first start
#                     after install — used to stagger instance "b" by
#                     ROTATE_SECONDS/2. Subsequent KeepAlive restarts skip
#                     this so the rotation cadence stays correct.
#   INSTANCE_ID       label suffix ("a" / "b") — disambiguates the
#                     sentinel file that tracks whether INITIAL_DELAY has
#                     been served.

set -euo pipefail

: "${TUNNEL_NAME:?TUNNEL_NAME not set — re-run install.sh}"
: "${LOCAL_URL:?LOCAL_URL not set — re-run install.sh}"
: "${ROTATE_SECONDS:=3600}"
: "${INITIAL_DELAY:=0}"
: "${INSTANCE_ID:=default}"

SENTINEL="/tmp/com.cowork.tunnel-rotate.${INSTANCE_ID}.started"

PID=""

# Trap is armed up front so SIGTERM during the initial-delay sleep still
# cleans up gracefully — at that point cloudflared hasn't spawned yet so
# PID is empty and the kill is a no-op.
cleanup() {
    if [[ -n "$PID" ]]; then
        kill -TERM "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup TERM INT

# Only the very first launch after install observes INITIAL_DELAY. The
# sentinel lives in /tmp so it clears on reboot — a fresh boot re-staggers
# the two instances from scratch, which is what we want.
if [[ ! -e "$SENTINEL" ]] && [[ "$INITIAL_DELAY" -gt 0 ]]; then
    sleep "$INITIAL_DELAY"
fi
touch "$SENTINEL"

cloudflared tunnel --protocol http2 --url "$LOCAL_URL" run "$TUNNEL_NAME" &
PID=$!

sleep "$ROTATE_SECONDS"

kill -TERM "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
