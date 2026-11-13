#!/usr/bin/env bash
# What a dispatched CI run on a pins/* branch changes, so the runtime and iOS
# gates in ci.yml can treat it like the pull request it is.
#
# agent-tool-pins.yml opens one PR per tool or SDK update and starts ci.yml on
# its branch with workflow_dispatch (pushes made with GITHUB_TOKEN start no
# workflow). A dispatched run used to build all five runtime targets and the
# iOS suite, so about ten of them each night held every macOS slot for up to
# an hour. A pull request runs only what its diff needs; this prints that diff:
# the files changed between main and the dispatched commit, from GitHub's
# compare API (three dots, so from their merge base, as a PR diff is).
#
#   scripts/ci/pins-changed-files.sh
# Needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA. Prints one path per line and
# exits 0, or exits 1 whenever the answer is in doubt (API error, nothing
# listed, a list GitHub may have cut short). On exit 1 the caller runs
# everything, exactly as for any other dispatch.
set -euo pipefail

: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1

compare="$(gh api "repos/$GITHUB_REPOSITORY/compare/main...$GITHUB_SHA")" || exit 1
summary="$(jq -r '"\(.status)|\(.files | length)|\(.ahead_by)"' <<< "$compare")" || exit 1
IFS='|' read -r status file_count ahead_by <<< "$summary"
case "$status" in ahead | diverged) ;; *) exit 1 ;; esac
[[ "$file_count" =~ ^[0-9]+$ && "$ahead_by" =~ ^[0-9]+$ ]] || exit 1
# The compare API lists at most 300 files; a list that long may be cut short.
(( file_count > 0 && file_count < 300 && ahead_by > 0 )) || exit 1

# A rename counts at both its old and its new path.
jq -r '.files[] | .filename, (.previous_filename // empty)' <<< "$compare"
