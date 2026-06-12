#!/usr/bin/env bash
# Bump the arul28/homebrew-ade cask to a published ADE release.
#
# Run after the GitHub release is PUBLISHED (not draft) — the cask download
# URL only resolves for published releases. Requires `gh` authenticated as an
# account with push access to arul28/homebrew-ade.
#
# Usage:
#   scripts/update-brew-tap.sh v1.2.3
#   scripts/update-brew-tap.sh latest
set -euo pipefail

tag="${1:?usage: update-brew-tap.sh <vX.Y.Z|latest>}"
repo="arul28/ADE"
tap_repo="arul28/homebrew-ade"

if [ "$tag" = "latest" ]; then
  tag="$(gh api "repos/$repo/releases/latest" --jq .tag_name)"
fi
version="${tag#v}"

release_json="$(gh api "repos/$repo/releases/tags/$tag")"
if [ "$(printf '%s' "$release_json" | jq -r .draft)" = "true" ]; then
  echo "error: $tag is still a draft release — publish it first." >&2
  exit 1
fi

asset_name="ADE-$version-universal.dmg"
digest="$(printf '%s' "$release_json" | jq -r --arg name "$asset_name" \
  '.assets[] | select(.name == $name) | .digest // empty')"
case "$digest" in
  sha256:*) sha="${digest#sha256:}" ;;
  *)
    echo "error: no sha256 digest found for $asset_name on $tag." >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
gh repo clone "$tap_repo" "$tmp_dir/tap" -- -q --depth 1
cask="$tmp_dir/tap/Casks/ade.rb"

sed -i '' -E "s|^  version \".*\"$|  version \"$version\"|" "$cask"
sed -i '' -E "s|^  sha256 \".*\"$|  sha256 \"$sha\"|" "$cask"

if git -C "$tmp_dir/tap" diff --quiet; then
  echo "Cask already at ADE $version — nothing to do."
  exit 0
fi

git -C "$tmp_dir/tap" commit -aqm "ade $version"
git -C "$tmp_dir/tap" push -q
echo "Updated $tap_repo cask to ADE $version (sha256 $sha)."
