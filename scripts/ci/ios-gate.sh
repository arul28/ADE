#!/usr/bin/env bash
# Decides whether a CI run must build and test the iOS app. Prints one line,
# `run=true` or `run=false`, for $GITHUB_OUTPUT, and the reason on stderr.
#
#   scripts/ci/ios-gate.sh
#
# Reads the same runner variables as scripts/ci/changed-files.sh, which gives
# it the diff. Needs a checkout with fetch-depth 2.
#
# The build runs when the diff touches:
# - the app (apps/ios/), or a file the Swift tests read from the desktop tree:
#   the shared chip fixtures and the activity case tables;
# - the iOS part of CI: the composite action under .github/actions/ios-*,
#   .github/workflows/ios-main.yml, this script, or changed-files.sh;
# - the iOS part of .github/workflows/ci.yml: the text before `jobs:` (the
#   triggers, permissions, concurrency) and every job whose id contains
#   "ios". The gate compares that text between the base and the head, so an
#   edit to another job of ci.yml does not start the build.
#
# If the gate cannot tell, the build runs. A wrong skip lets a broken app
# merge green; a wrong run costs only runner time. "Cannot tell" is a failed
# or missing diff (changed-files.sh exit 3), a ci.yml change with no
# readable base (a pins/* dispatch diffs against main's merge base, which a
# depth-2 checkout does not have), and a ci.yml with no iOS job at all.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_FILE=".github/workflows/ci.yml"
IOS_PATHS='^(apps/ios/|apps/desktop/src/shared/__fixtures__/|apps/desktop/src/shared/attention/[^/]+\.cases\.json$|\.github/actions/ios-|\.github/workflows/ios-main\.yml$|scripts/ci/(changed-files\.sh|ios-))'

decide() {
  echo "run=$1"
  echo "$2" >&2
  exit 0
}

# The text of ci.yml that the iOS jobs depend on: everything before `jobs:`,
# then each job whose id contains "ios", from its header to the next job.
ios_part() {
  awk '
    /^jobs:[[:space:]]*$/ { in_jobs = 1; next }
    !in_jobs { print; next }
    /^[^[:space:]#]/ { exit }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      id = $1; sub(/:$/, "", id)
      keep = (id ~ /ios/)
      if (keep) { print "@@job " id; jobs++ }
    }
    keep { print }
    END { if (jobs == 0) exit 4 }
  '
}

[ "$#" -eq 0 ] || { echo "usage: scripts/ci/ios-gate.sh (no arguments)" >&2; exit 2; }

changed="$("$here/changed-files.sh")"
status=$?
if [ "$status" -ne 0 ]; then
  decide true "Building iOS: the diff of this run is unknown (changed-files.sh exit $status)."
fi

hit="$(printf '%s\n' "$changed" | grep -m1 -E "$IOS_PATHS" || true)"
if [ -n "$hit" ]; then
  decide true "Building iOS: $hit changed."
fi

if ! printf '%s\n' "$changed" | grep -qxF "$CI_FILE"; then
  decide false "Skipping iOS: no iOS file changed."
fi

case "${GITHUB_EVENT_NAME:-}" in
  pull_request | push) ;;
  *) decide true "Building iOS: $CI_FILE changed and this event has no base commit to compare." ;;
esac

if ! base_text="$(git show "HEAD^1:$CI_FILE" 2>/dev/null)"; then
  decide true "Building iOS: $CI_FILE changed and the base has no readable copy of it."
fi
if ! base_part="$(printf '%s\n' "$base_text" | ios_part)"; then
  decide true "Building iOS: the base $CI_FILE has no iOS job to compare."
fi
if ! head_part="$(ios_part < "$CI_FILE")"; then
  decide true "Building iOS: the head $CI_FILE has no iOS job to compare."
fi

if [ "$base_part" != "$head_part" ]; then
  decide true "Building iOS: the iOS part of $CI_FILE changed (the text before jobs:, or a job whose id contains ios)."
fi
decide false "Skipping iOS: $CI_FILE changed, but not its iOS part."
