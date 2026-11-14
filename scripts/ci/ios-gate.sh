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
# - the iOS part of .github/workflows/ci.yml: every line outside the bodies
#   of the other jobs. That is the text before and after the `jobs:` block
#   (triggers, permissions, concurrency, a top-level env or defaults) and
#   every job whose id contains "ios", which includes the jobs in IOS_JOBS.
#   The gate compares that text between the base and the head, so an edit
#   to another job of ci.yml does not start the build.
#
# If the gate cannot tell, the build runs. A wrong skip lets a broken app
# merge green; a wrong run costs only runner time. "Cannot tell" is:
# - a failed or missing diff (changed-files.sh exit 3);
# - a ci.yml change with no readable base (a pins/* dispatch diffs against
#   main's merge base, which a depth-2 checkout does not have);
# - a base or head ci.yml that lacks a job of IOS_JOBS (so a rename builds
#   on every change until this list follows it);
# - a base or head ci.yml with a YAML anchor or alias, because an alias can
#   pull text from another job into an iOS job.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_FILE=".github/workflows/ci.yml"
IOS_JOBS="ios-gate test-ios"
IOS_PATHS='^(apps/ios/|apps/desktop/src/shared/__fixtures__/|apps/desktop/src/shared/attention/[^/]+\.cases\.json$|\.github/actions/ios-|\.github/workflows/ios-main\.yml$|scripts/ci/(changed-files\.sh|ios-))'
YAML_ANCHOR_OR_ALIAS='[:-][[:space:]]+[&*][A-Za-z0-9_-]+'

decide() {
  echo "run=$1"
  echo "$2" >&2
  exit 0
}

# The text of ci.yml that the iOS jobs depend on: every line except the
# bodies of the jobs that are not iOS jobs. A job header may carry a
# trailing comment. A top-level key after the jobs block ends it, and its
# lines count again. Exits 4 when a job of IOS_JOBS is missing.
ios_part() {
  awk -v required="$IOS_JOBS" '
    BEGIN { keep = 1 }
    /^jobs:[[:space:]]*(#.*)?$/ { in_jobs = 1; keep = 1; print; next }
    in_jobs && /^[^[:space:]#]/ { in_jobs = 0; keep = 1 }
    in_jobs && /^  [A-Za-z0-9_-]+:[[:space:]]*(#.*)?$/ {
      id = $1; sub(/:.*$/, "", id)
      keep = (id ~ /ios/ || (" " required " ") ~ (" " id " "))
      if (keep) { print "@@job " id; found[id] = 1 }
    }
    keep { print }
    END {
      n = split(required, names, " ")
      for (i = 1; i <= n; i++) if (!(names[i] in found)) exit 4
    }
  '
}

[ "$#" -eq 0 ] || { echo "usage: scripts/ci/ios-gate.sh (no arguments)" >&2; exit 2; }

changed="$("$here/changed-files.sh")"
status=$?
if [ "$status" -ne 0 ]; then
  decide true "Building iOS: the diff of this run is unknown (changed-files.sh exit $status)."
fi

# Here-strings, not pipes: under pipefail, `printf | grep -q` fails with
# SIGPIPE when grep stops at the first match of a long list.
hit="$(grep -m1 -E "$IOS_PATHS" <<< "$changed" || true)"
if [ -n "$hit" ]; then
  decide true "Building iOS: $hit changed."
fi

if ! grep -qxF "$CI_FILE" <<< "$changed"; then
  decide false "Skipping iOS: no iOS file changed."
fi

case "${GITHUB_EVENT_NAME:-}" in
  pull_request | push) ;;
  *) decide true "Building iOS: $CI_FILE changed and this event has no base commit to compare." ;;
esac

if ! base_text="$(git show "HEAD^1:$CI_FILE" 2>/dev/null)"; then
  decide true "Building iOS: $CI_FILE changed and the base has no readable copy of it."
fi
if ! head_text="$(cat "$CI_FILE" 2>/dev/null)"; then
  decide true "Building iOS: $CI_FILE changed and the head has no readable copy of it."
fi
if grep -qE "$YAML_ANCHOR_OR_ALIAS" <<< "$base_text" || grep -qE "$YAML_ANCHOR_OR_ALIAS" <<< "$head_text"; then
  decide true "Building iOS: $CI_FILE changed and uses a YAML anchor or alias, so its iOS part cannot be separated."
fi
if ! base_part="$(ios_part <<< "$base_text")"; then
  decide true "Building iOS: the base $CI_FILE lacks a job of: $IOS_JOBS."
fi
if ! head_part="$(ios_part <<< "$head_text")"; then
  decide true "Building iOS: the head $CI_FILE lacks a job of: $IOS_JOBS."
fi

if [ "$base_part" != "$head_part" ]; then
  decide true "Building iOS: the iOS part of $CI_FILE changed (a line outside the bodies of the other jobs)."
fi
decide false "Skipping iOS: $CI_FILE changed, but not its iOS part."
