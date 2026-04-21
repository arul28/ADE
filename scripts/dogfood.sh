#!/usr/bin/env bash
# Launch a second ADE instance for dogfooding.
#
# Usage:
#   ./scripts/dogfood.sh                  # run from main repo
#   ./scripts/dogfood.sh <lane-name>      # run code from a lane's worktree
#
# Both instances share the same DB (lanes, missions, configs stay in sync).
# The dogfood instance uses an isolated ADE CLI socket. The sync host stays enabled
# by default and will retry alternate ports if your primary ADE window already
# owns the default port, which keeps mobile pairing usable while dogfooding.
# Set ADE_DOGFOOD_DISABLE_SYNC_HOST=1 to opt out. When run from a lane
# worktree, the new code is used but the DB from the main repo is still shared
# — so all your existing lanes/state are visible.

set -euo pipefail

MAIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOCKET_PATH="/tmp/ade-dogfood-ade-cli.sock"

if [ -n "${1:-}" ]; then
  # Find the lane worktree by name/slug match
  LANE_NAME="$1"
  if [ ! -d "$MAIN_ROOT/.ade/worktrees" ]; then
    echo "No worktree found matching '$LANE_NAME' in .ade/worktrees/"
    echo "Available:"
    echo "  (none)"
    exit 1
  fi
  WORKTREE_DIR=$(find "$MAIN_ROOT/.ade/worktrees" -maxdepth 1 -type d -name "*${LANE_NAME}*" -print -quit)
  if [ -z "$WORKTREE_DIR" ]; then
    echo "No worktree found matching '$LANE_NAME' in .ade/worktrees/"
    echo "Available:"
    ls "$MAIN_ROOT/.ade/worktrees/" 2>/dev/null || echo "  (none)"
    exit 1
  fi
  DEV_DIR="$WORKTREE_DIR/apps/desktop"
  echo "Running from lane worktree: $WORKTREE_DIR"
else
  DEV_DIR="$MAIN_ROOT/apps/desktop"
  echo "Running from main repo"
fi

# Clean stale socket from prior run
rm -f "$SOCKET_PATH"

echo "DB: $MAIN_ROOT/.ade/ade.db (shared)"
echo "Socket: $SOCKET_PATH (isolated)"
if [ "${ADE_DOGFOOD_DISABLE_SYNC_HOST:-0}" = "1" ]; then
  echo "Sync host: disabled by ADE_DOGFOOD_DISABLE_SYNC_HOST=1"
else
  echo "Sync host: enabled (will retry alternate ports if needed)"
fi
echo ""

cd "$DEV_DIR"
ADE_PROJECT_ROOT="$MAIN_ROOT" \
  ADE_RPC_SOCKET_PATH="$SOCKET_PATH" \
  ADE_DISABLE_SYNC_HOST="${ADE_DOGFOOD_DISABLE_SYNC_HOST:-0}" \
  npm run dev
