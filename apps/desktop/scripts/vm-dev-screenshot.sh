#!/usr/bin/env bash
set -euo pipefail
LOG="${1:-/workspace/ade-bg.log}"
PNG="${2:-/workspace/ade-vm-proof.png}"

pkill -f "tsup --watch" 2>/dev/null || true
pkill -f "vite --port" 2>/dev/null || true
pkill -f "electron \." 2>/dev/null || true
sleep 2

rm -f "$LOG" "$PNG"
cd "$(dirname "$0")/.."

export ADE_DISABLE_HARDWARE_ACCEL="${ADE_DISABLE_HARDWARE_ACCEL:-1}"
export ADE_PROJECT_ROOT="${ADE_PROJECT_ROOT:-/workspace}"

npm run dev >"$LOG" 2>&1 &
DEVPID=$!
echo "[vm-dev-screenshot] dev pid=$DEVPID"

READY=0
for _ in $(seq 1 120); do
  if grep -q "DevTools listening" "$LOG" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "[vm-dev-screenshot] timeout waiting for DevTools"
  kill "$DEVPID" 2>/dev/null || true
  tail -40 "$LOG" || true
  exit 1
fi

CDP_PORT="$(grep -oE '127\.0\.0\.1:[0-9]+' "$LOG" | tail -1 | cut -d: -f2)"
echo "[vm-dev-screenshot] CDP port=$CDP_PORT"

curl -sS "http://127.0.0.1:${CDP_PORT}/json/version" | head -c 120
echo

node "$(dirname "$0")/capture-dev-screenshot.mjs" "$CDP_PORT" "$PNG"
ls -la "$PNG"

kill "$DEVPID" 2>/dev/null || true
sleep 2
pkill -f "tsup --watch" 2>/dev/null || true
pkill -f "vite --port" 2>/dev/null || true
pkill -f "electron \." 2>/dev/null || true

echo "[vm-dev-screenshot] done"
