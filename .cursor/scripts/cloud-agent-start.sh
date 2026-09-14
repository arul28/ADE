#!/usr/bin/env bash
set -euo pipefail

# Cloud Agent VMs expose a virtual display; Electron needs explicit DISPLAY and
# software rendering when no GPU is present.
export DISPLAY="${DISPLAY:-:1}"
export ADE_DISABLE_HARDWARE_ACCEL="${ADE_DISABLE_HARDWARE_ACCEL:-1}"

if ! mkdir -p "$HOME/.ade/sock"; then
  echo "[cloud-agent-start] failed to create $HOME/.ade/sock" >&2
  exit 1
fi
mkdir -p "$HOME/.ade/runtime" 2>/dev/null || true

echo "[cloud-agent-start] DISPLAY=$DISPLAY ADE_DISABLE_HARDWARE_ACCEL=$ADE_DISABLE_HARDWARE_ACCEL"
