#!/usr/bin/env bash
# TEMP diagnostic (to be removed): cold brain start from source, this branch vs origin/main.
set -u
ROOT=$PWD
git fetch -q --depth=1 origin main
git worktree add -q --detach /tmp/mainwt FETCH_HEAD
ln -s "$ROOT/apps/desktop/node_modules" /tmp/mainwt/apps/desktop/node_modules
ln -s "$ROOT/apps/ade-cli/node_modules" /tmp/mainwt/apps/ade-cli/node_modules
start_brain() {
  local tree=$1 label=$2
  cd "$tree/apps/ade-cli"
  local T; T=$(mktemp -d); mkdir -p "$T/sock"; local S="$T/sock/ade.sock"
  local L="file://$ROOT/apps/ade-cli/node_modules/tsx/dist/loader.mjs"
  local s; s=$(date +%s%N)
  TMPDIR="$T" ADE_HOME="$T" ADE_RUNTIME_SOCKET_PATH="$S" ADE_CLI_VERSION=2.0.0 ADE_DEFAULT_ROLE=cto ADE_DISABLE_TOOLS_FETCH=1 NODE_OPTIONS="--import $L" \
    node src/cli.ts serve --socket "$S" --no-sync > "$T/out" 2> "$T/err" & local pid=$!
  for t in $(seq 1 900); do [ -S "$S" ] && break; kill -0 $pid 2>/dev/null || break; sleep 0.05; done
  echo "$label cold ms=$(( ($(date +%s%N)-s)/1000000 )) socket=$([ -S "$S" ] && echo yes || echo no)"
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  cd "$ROOT"
}
for r in 1 2 3; do start_brain "$ROOT" "r$r branch"; start_brain /tmp/mainwt "r$r main  "; done
exit 0
