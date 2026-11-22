#!/usr/bin/env bash
# Installs the core node_modules group (apps/desktop and apps/ade-cli) from
# their lockfiles. ci.yml's install job runs it on a cache miss before it
# saves the entry, and .github/actions/restore-core-node-modules runs it for a
# job that restores the group and finds no entry. One script, so the saved
# entry and a job's own install are the same.
#
#   scripts/ci/install-core-node-modules.sh
#
# Run it from the repository root. The two installs run in parallel; the
# script fails when either one fails.
set -euo pipefail

# Electron 42+ fetches its binary on first require instead of in npm ci; fetch
# it here so the cached node_modules carries it, as it did on Electron 41.
# Without it, every brain a test starts from source downloads Electron before
# it can listen.
(cd apps/desktop && npm ci && node scripts/ensure-electron.cjs) &
desktop=$!
(cd apps/ade-cli && npm ci) &
cli=$!

fail=0
wait "$desktop" || { echo "::error::npm ci failed in apps/desktop"; fail=1; }
wait "$cli" || { echo "::error::npm ci failed in apps/ade-cli"; fail=1; }
exit "$fail"
