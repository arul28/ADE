#!/usr/bin/env bash
# Deletes the cache entries that a new entry replaces, before that entry is
# saved, so the repository's 10 GB cache space never holds two copies.
#
#   GITHUB_REF=<ref> scripts/ci/prune-cache-entries.sh <prefix> <new-key>
#
# Deletes every entry of this run's ref ($GITHUB_REF: refs/heads/main on a
# push to main, refs/pull/<n>/merge on a pull request) whose key starts with
# <prefix> and is not <new-key>. Run it right before the save of <new-key>, in
# a job with `actions: write`. Needs GH_TOKEN, GITHUB_REPOSITORY and
# GITHUB_REF. A run never touches another ref's entries: a pull request prunes
# only its own older copies (a fork's read-only token only warns).
#
# Why: main's entries for the desktop and CLI node_modules (3.4 GB for Linux
# and Windows) and the five npm download caches (3.1 GB) are keyed on
# lockfiles, and nothing deleted the old ones. The cache space normally holds
# ~8.5 GB, so one lockfile change pushed it over 10 GB, and GitHub then evicted
# (or refused to save) the iOS build folder and the Swift packages, which only
# iOS runs touch. Once main's lockfile changed, no new run asks for the old
# key: a pull request runs on its merge with main. A pull request that changed
# its lockfile also kept a ~2 GB copy per such push until it closed.
#
# Why before the save: deleting first keeps the space from going over the
# limit at all. A failed request warns and stops; it never fails the job.
set -uo pipefail

[ "$#" -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] && [ -n "${GITHUB_REF:-}" ] || {
  echo "usage: GITHUB_REF=<ref> scripts/ci/prune-cache-entries.sh <prefix> <new-key>" >&2
  exit 2
}
prefix="$1"
keep="$2"
case "$keep" in
  "$prefix"*) ;;
  *) echo "::warning::$keep does not start with $prefix; nothing deleted."; exit 0 ;;
esac

# Runs on main overlap (a push does not cancel the run before it), so an older
# commit's slower run could delete the entry a newer lockfile just saved. Only
# the run of main's newest commit prunes; an older one leaves the cleanup to
# it. A pull request needs no check: its newer push cancels the older run.
if [ "$GITHUB_REF" = "refs/heads/main" ]; then
  if ! tip="$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)"; then
    echo "::warning::Could not read main's newest commit; nothing deleted."
    exit 0
  fi
  if [ "$tip" != "${GITHUB_SHA:-}" ]; then
    echo "main has moved on to ${tip:0:9}; its run prunes. Nothing deleted."
    exit 0
  fi
fi

# The list endpoint's `key` filter is a prefix match.
if ! stale="$(PREFIX="$prefix" KEEP="$keep" REF="$GITHUB_REF" gh api --paginate \
  "repos/$GITHUB_REPOSITORY/actions/caches?per_page=100&ref=$GITHUB_REF&key=$prefix" \
  --jq '.actions_caches[]
    | select(.ref == env.REF and (.key | startswith(env.PREFIX)) and .key != env.KEEP)
    | "\(.id) \(.size_in_bytes) \(.key)"')"; then
  echo "::warning::Could not list the cache entries under $prefix on $GITHUB_REF; nothing deleted."
  exit 0
fi

if [ -z "$stale" ]; then
  echo "No other entry under $prefix on $GITHUB_REF."
  exit 0
fi
while read -r id size key; do
  [ -n "$id" ] || continue
  if gh api -X DELETE "repos/$GITHUB_REPOSITORY/actions/caches/$id" >/dev/null; then
    echo "Deleted $key ($((size / 1000000)) MB), replaced by $keep"
  else
    echo "::warning::Could not delete $key"
  fi
done <<< "$stale"
