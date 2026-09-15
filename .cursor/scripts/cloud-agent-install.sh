#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "[cloud-agent-install] Node $(node --version)"

npm run install:apps

echo "[cloud-agent-install] Building ADE CLI runtime"
npm --prefix apps/ade-cli run build

echo "[cloud-agent-install] Building publishable SDK (chat-ui typecheck dependency)"
npm --prefix packages/sdk run build

echo "[cloud-agent-install] Rebuilding Electron native modules for Linux"
npm --prefix apps/desktop run rebuild:native

PTY_DIR="$REPO_ROOT/apps/desktop/node_modules/node-pty"
SPAWN_HELPER="$PTY_DIR/build/Release/spawn-helper"
if [[ ! -x "$SPAWN_HELPER" ]]; then
  echo "[cloud-agent-install] Compiling node-pty spawn-helper"
  g++ -o "$SPAWN_HELPER" "$PTY_DIR/src/unix/spawn-helper.cc"
fi

echo "[cloud-agent-install] Prebuilding desktop bundles for dev launcher race"
npm --prefix apps/desktop run build

echo "[cloud-agent-install] Done"
