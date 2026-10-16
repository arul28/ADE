#!/usr/bin/env bash
# Prints what an ADE release needs to ship, and whether main's CI lets it tag.
#
#   bash scripts/release-tools/scope.sh
#
# Read-only. Prints one block per tier plus the ci-pass state of origin/main.
set -uo pipefail
REPO="${GH_REPO:-arul28/ADE}"

git fetch origin --tags --prune -q

# Desktop: product files changed since the newest v* tag.
DESKTOP_LAST_TAG="$(git tag --list 'v*' --sort=-v:refname | head -n 1)"
desktop_changes="$(git diff --name-only "$DESKTOP_LAST_TAG..origin/main" -- \
  apps/desktop apps/ade-cli packages \
  .github/workflows/release.yml .github/workflows/release-core.yml \
  .github/workflows/release-publish.yml .github/workflows/update-brew-tap.yml \
  .github/workflows/publish-runtime-packages.yml \
  package.json package-lock.json | wc -l | tr -d ' ')"
next_desktop="$(echo "${DESKTOP_LAST_TAG#v}" | awk -F. '{printf "v%d.%d.%d", $1, $2, $3 + 1}')"

# iOS: files changed since the newest ios-v*-build* tag.
IOS_LAST_TAG="$(git tag --list 'ios-v*-build*' --sort=-creatordate | head -n 1)"
ios_changes="$(git diff --name-only "$IOS_LAST_TAG..origin/main" -- apps/ios | wc -l | tr -d ' ')"

echo "desktop: changed_files=$desktop_changes since=$DESKTOP_LAST_TAG next=$next_desktop"
echo "ios:     changed_files=$ios_changes since=$IOS_LAST_TAG"

# Cloudflare: each surface's baseline is the newest deploy-web.yml run on main
# whose job for that surface succeeded. Unknown baseline counts as changed.
surfaces="webclient account-directory webhook-relay tunnel-relay push-relay"
found=""   # "name=sha" pairs; bash 3.2 (macOS) has no associative arrays
base_of() { for p in $found; do [ "${p%%=*}" = "$1" ] && { echo "${p#*=}"; return; }; done; }
for id in $(gh run list --repo "$REPO" --workflow deploy-web.yml --branch main \
  --json databaseId --limit 60 --jq '.[].databaseId'); do
  ok="$(gh run view "$id" --repo "$REPO" --json headSha,jobs \
    --jq '.headSha as $s | [.jobs[] | select(.conclusion=="success") | .name + "=" + $s] | join(" ")')"
  for pair in $ok; do
    name="${pair%%=*}"
    [ -z "$(base_of "$name")" ] && found="$found $pair"
  done
  all=1
  for s in $surfaces; do [ -z "$(base_of "$s")" ] && all=0; done
  [ "$all" = 1 ] && break
done
for s in $surfaces; do
  if [ "$s" = webclient ]; then
    paths="apps/desktop/src/renderer apps/desktop/src/shared apps/desktop/vite.webclient.config.ts"
  else
    paths="apps/$s"
  fi
  b="$(base_of "$s")"
  if [ -z "$b" ]; then
    echo "cloudflare $s: baseline=UNKNOWN -> reconcile (gh workflow run deploy-web.yml)"
  else
    n="$(git log --oneline "$b..origin/main" -- $paths | wc -l | tr -d ' ')"
    echo "cloudflare $s: baseline=${b:0:9} undeployed_commits=$n"
  fi
done

# The tag borrows the last code commit's ci-pass. Check it before writing notes.
main_sha="$(git rev-parse origin/main)"
ci="$(gh api "repos/$REPO/commits/$main_sha/check-runs" \
  --jq '[.check_runs[] | select(.name=="ci-pass")] | last | "\(.status) \(.conclusion)"' 2>/dev/null)"
echo "main ${main_sha:0:9} ci-pass: ${ci:-missing}"
