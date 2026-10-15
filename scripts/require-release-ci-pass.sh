#!/usr/bin/env bash
# Fails unless the release commit has green CI, its own or borrowed.
#
# release-core.yml's verify job runs this for the commit a tag points at.
#
#   GH_REPO=owner/repo scripts/require-release-ci-pass.sh <target-ref>
TARGET_REF="${1:?usage: require-release-ci-pass.sh <target-ref>}"
: "${GH_REPO:?GH_REPO is required}"

set -euo pipefail

ci_pass_for() {
  gh api "repos/$GH_REPO/commits/$1/check-runs" \
    --method GET \
    -H "Accept: application/vnd.github+json" \
    -f per_page=100 \
    --paginate \
    --jq '[.check_runs[] | select(.name == "ci-pass")] | sort_by(.completed_at // "") | last // empty'
}

validate_docs_failed() {
  local conclusion
  conclusion="$(gh api "repos/$GH_REPO/commits/$1/check-runs" \
    --method GET \
    -H "Accept: application/vnd.github+json" \
    -f per_page=100 \
    --paginate \
    --jq '[.check_runs[] | select(.name == "validate-docs")] | sort_by(.completed_at // "") | last | .conclusion // empty' | tail -n 1)" || return 0
  [ -n "$conclusion" ] && [ "$conclusion" != "success" ] && [ "$conclusion" != "cancelled" ] && [ "$conclusion" != "skipped" ]
}

# A release commit that only adds release notes cannot change the
# code that ships: these files reach the app only as data, the
# version's notes embedded as a string by bundle-release-notes.mjs.
# The release skill runs validate-docs on them before pushing. Waiting 15-50 minutes
# for CI on it is what used to hold every tag, so a commit whose CI
# has not finished may borrow the green ci-pass of the nearest
# ancestor, provided every commit in between touches only these
# paths. On such a commit only validate-docs can catch anything the
# parent's CI did not, so a failed ci-pass blocks only when its
# validate-docs failed. Any other failure (a cancelled run, which
# ci-pass reports as failure, or a flaky code test) counts as
# unfinished. A failed ci-pass on any other commit always blocks.
release_notes_only() {
  local files
  files="$(git diff-tree --no-commit-id --name-only -r --root "$1")"
  [ -n "$files" ] || return 1
  ! printf '%s\n' "$files" | grep -qvE '^(CHANGELOG\.md|docs\.json|changelog/[^/]+\.mdx)$'
}

target_sha="$(git rev-parse "$TARGET_REF^{commit}")"
candidate="$target_sha"
# The target, up to five notes-only commits, then the parent below them.
for _ in 1 2 3 4 5 6; do
  ci_pass_json="$(ci_pass_for "$candidate")"
  status="$(printf '%s' "${ci_pass_json:-null}" | jq -r '.status // ""')"
  conclusion="$(printf '%s' "${ci_pass_json:-null}" | jq -r '.conclusion // ""')"
  url="$(printf '%s' "${ci_pass_json:-null}" | jq -r '.html_url // ""')"

  if [ "$status" = "completed" ] && [ "$conclusion" = "success" ]; then
    if [ "$candidate" = "$target_sha" ]; then
      echo "ci-pass succeeded for $TARGET_REF: $url"
    else
      echo "ci-pass succeeded for $candidate, and every commit from there to $TARGET_REF only changes release notes: $url"
    fi
    exit 0
  fi
  if [ "$status" = "completed" ]; then
    if ! release_notes_only "$candidate" || validate_docs_failed "$candidate"; then
      echo "::error::ci-pass for $candidate is $status/$conclusion. Release packaging requires green CI. $url"
      exit 1
    fi
  fi
  if ! release_notes_only "$candidate"; then
    if [ -z "$ci_pass_json" ]; then
      echo "::error::No ci-pass check run was found for $candidate. Run CI before releasing."
    else
      echo "::error::ci-pass for $candidate is ${status}${conclusion:+/$conclusion}, not green. Release packaging requires green CI. $url"
    fi
    exit 1
  fi
  echo "$candidate only changes release notes and its CI has not finished (${status:-not started}${conclusion:+/$conclusion}); checking its parent."
  candidate="$(git rev-parse "$candidate^")"
done

echo "::error::No green ci-pass within five release-notes-only commits of $TARGET_REF."
exit 1
