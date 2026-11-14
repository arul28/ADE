#!/usr/bin/env bash
# Prints the files a CI run changes, one path per line, so a gate in ci.yml
# can skip work that the change cannot affect. Each gate keeps its own path
# list and decides itself which events skip the diff and run everything.
#
#   scripts/ci/changed-files.sh
#
# Reads the runner's GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA,
# GITHUB_REPOSITORY and GITHUB_EVENT_PATH. A pins/* dispatch also needs
# GH_TOKEN. A pull request or a push needs a checkout with fetch-depth 2.
#
# - pull_request: actions/checkout checks out the PR merge commit, so its
#   first parent is the base and the diff is exactly what the PR changes.
# - push of one commit (its first parent is the push's `before`): a merge or
#   squash commit on main, so the diff is what the merged PR changed.
# - workflow_dispatch on a pins/* branch: agent-tool-pins.yml opens one PR per
#   tool or SDK update and starts ci.yml on its branch by dispatch, because a
#   push made with GITHUB_TOKEN starts no workflow. Such a run is gated like
#   its pull request. The diff is main...the commit, from GitHub's compare API
#   (three dots: from their merge base, as a PR diff is).
#
# A rename counts at its old path and at its new path, so a file moved out of
# a gated directory still counts for that directory.
#
# Exit 0: the list, which can be empty for a pull request or a push.
# Exit 3: run everything. That is any other event or dispatch, a push of
# several commits, a missing parent, a failed diff, or a pins list in doubt
# (an API error, no files, or a list GitHub may have cut short).
# Exit 2: a usage error.
set -uo pipefail

RUN_ALL=3
[ "$#" -eq 0 ] || { echo "usage: scripts/ci/changed-files.sh (no arguments)" >&2; exit 2; }

# The merge or squash commit against its first parent.
first_parent_diff() {
  local files
  files="$(git diff --no-renames --name-only HEAD^1 HEAD)" || exit "$RUN_ALL"
  [ -z "$files" ] || printf '%s\n' "$files"
  exit 0
}

pins_diff() {
  [ -n "${GH_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] || exit "$RUN_ALL"
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || exit "$RUN_ALL"
  local compare summary status file_count ahead_by
  compare="$(gh api "repos/$GITHUB_REPOSITORY/compare/main...$GITHUB_SHA")" || exit "$RUN_ALL"
  summary="$(jq -r '"\(.status)|\(.files | length)|\(.ahead_by)"' <<< "$compare")" || exit "$RUN_ALL"
  IFS='|' read -r status file_count ahead_by <<< "$summary"
  case "$status" in ahead | diverged) ;; *) exit "$RUN_ALL" ;; esac
  [[ "$file_count" =~ ^[0-9]+$ && "$ahead_by" =~ ^[0-9]+$ ]] || exit "$RUN_ALL"
  # The compare API lists at most 300 files; a list that long may be cut short.
  (( file_count > 0 && file_count < 300 && ahead_by > 0 )) || exit "$RUN_ALL"
  jq -r '.files[] | .filename, (.previous_filename // empty)' <<< "$compare" || exit "$RUN_ALL"
  exit 0
}

case "${GITHUB_EVENT_NAME:-}" in
  pull_request)
    first_parent_diff
    ;;
  push)
    before="$(jq -r '.before // empty' "${GITHUB_EVENT_PATH:-/dev/null}" 2>/dev/null)" || exit "$RUN_ALL"
    parent="$(git rev-parse --verify --quiet 'HEAD^1')" || exit "$RUN_ALL"
    [ -n "$before" ] && [ "$parent" = "$before" ] || exit "$RUN_ALL"
    first_parent_diff
    ;;
  workflow_dispatch)
    [[ "${GITHUB_REF:-}" == refs/heads/pins/* ]] || exit "$RUN_ALL"
    pins_diff
    ;;
  *)
    exit "$RUN_ALL"
    ;;
esac
