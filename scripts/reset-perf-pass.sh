#!/usr/bin/env bash
# Reset the perf-pass throwaway repo to a known seed state.
# Usage: scripts/reset-perf-pass.sh [path-to-perf-pass-repo]
set -euo pipefail

PERF_PASS="${1:-${ADE_PERF_PASS_DIR:-$HOME/Projects/perf pass}}"
SEED_TAG="${ADE_PERF_PASS_SEED_TAG:-perf-pass-seed}"

if [[ ! -d "$PERF_PASS/.git" ]]; then
  echo "[perf-pass] $PERF_PASS is not a git repo" >&2
  exit 2
fi

cd "$PERF_PASS"

if [[ "${PERF_PASS_FORCE:-}" != "1" && -z "${CI:-}" ]]; then
  echo "[perf-pass] WARNING: this will reset tracked changes and permanently delete untracked and ignored files in:"
  echo "[perf-pass]   $PERF_PASS"
  read -r -p "[perf-pass] Continue? [y/N] " CONFIRM
  case "$CONFIRM" in
    y|Y|yes|YES) ;;
    *)
      echo "[perf-pass] cancelled"
      exit 1
      ;;
  esac
fi

if ! git rev-parse --verify "$SEED_TAG" >/dev/null 2>&1; then
  echo "[perf-pass] tagging current HEAD as $SEED_TAG"
  git tag "$SEED_TAG"
fi

echo "[perf-pass] resetting to $SEED_TAG"
git reset --hard "$SEED_TAG"

echo "[perf-pass] clearing untracked"
git clean -fdx

if [[ -d "$PERF_PASS/.ade" ]]; then
  echo "[perf-pass] clearing .ade/"
  rm -rf "$PERF_PASS/.ade"
fi

echo "[perf-pass] ready at $PERF_PASS ($(git rev-parse --short HEAD))"
