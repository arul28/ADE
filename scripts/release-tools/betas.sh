#!/usr/bin/env bash
# Lists the newest published betas, the candidates a stable release promotes.
#
#   bash scripts/release-tools/betas.sh [count]      # default 5
#
# Read-only. One block per beta, newest first: tag, age, commit, whether a
# stable release already ships that commit, and the PRs its notes list. The
# last line names the recommended beta: the newest one at least 3 hours old
# that no stable ships yet. Promote it with release.yml, tag_name=vX.Y.Z (the
# beta's X.Y.Z) and target_sha=<its commit>; see the release skill.
set -uo pipefail
REPO="${GH_REPO:-arul28/ADE}"
COUNT="${1:-5}"

# tag -> commit for every tag; annotated tags list their commit on ^{}.
tags="$(git ls-remote --tags origin | awk '{ sub("refs/tags/", "", $2); print $2, $1 }' \
  | awk '{ name = $1; peeled = sub(/\^\{\}$/, "", name); if (peeled || !(name in c)) c[name] = $2 }
         END { for (n in c) print n, c[n] }')"
commit_of() { echo "$tags" | awk -v t="$1" '$1 == t { print $2; exit }'; }
stable_commits="$(echo "$tags" | awk '$1 ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ { print $2 }')"

releases="$(gh api "repos/$REPO/releases?per_page=100" --paginate \
  --jq '.[] | select(.draft | not) | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+$")) | [.tag_name, .published_at] | @tsv' \
  | sort -t "$(printf '\t')" -k2,2r | head -n "$COUNT")"
[ -n "$releases" ] || { echo "no published betas"; exit 0; }

now="$(date -u +%s)"
recommended=""
while IFS="$(printf '\t')" read -r tag published; do
  [ -n "$tag" ] || continue
  # BSD date (macOS) and GNU date (Linux) parse ISO timestamps differently.
  ts="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$published" +%s 2>/dev/null || date -u -d "$published" +%s)"
  age=$(( (now - ts) / 60 ))
  sha="$(commit_of "$tag")"
  promoted=""
  if [ -n "$sha" ] && echo "$stable_commits" | grep -qx "$sha"; then promoted=" (already shipped as stable)"; fi
  # A beta of a base that is already a stable version cannot be promoted: its
  # vX.Y.Z tag exists. The next beta of the new base can.
  [ -n "$(commit_of "${tag%-beta.*}")" ] && [ -z "$promoted" ] && promoted=" (${tag%-beta.*} already released)"
  prs="$(gh release view "$tag" --repo "$REPO" --json body --jq '.body' \
    | grep -oE '\(#[0-9]+\)[[:space:]]*$' | grep -oE '#[0-9]+' | tr '\n' ' ')"
  printf '%s  age=%dh%02dm  commit=%s%s\n  PRs: %s\n' \
    "$tag" $((age / 60)) $((age % 60)) "${sha:-unknown}" "$promoted" "${prs:-none}"
  if [ -z "$recommended" ] && [ "$age" -ge 180 ] && [ -z "$promoted" ] && [ -n "$sha" ]; then
    recommended="$tag $sha"
  fi
done <<< "$releases"

if [ -n "$recommended" ]; then
  echo "recommended: $recommended"
else
  echo "recommended: none (no unshipped beta is 3 h old yet)"
fi
