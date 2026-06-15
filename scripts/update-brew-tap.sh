#!/usr/bin/env bash
# Bump the arul28/homebrew-ade cask to a published ADE release.
#
# ADE ships per-architecture macOS DMGs (arm64 + x64), so the cask is
# arch-conditional. This script regenerates Casks/ade.rb from the published
# release's two DMG digests — regenerating (rather than sed-patching) means the
# cask self-heals if its shape drifts and the universal->per-arch transition is
# atomic (the old universal cask stays valid until the per-arch release exists).
#
# Run after the GitHub release is PUBLISHED (not draft) — the cask download
# URLs only resolve for published releases. Requires `gh` authenticated as an
# account with push access to arul28/homebrew-ade.
#
# Usage:
#   scripts/update-brew-tap.sh v1.2.5
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

# Resolve the sha256 for a named release asset from its `digest` field.
read_sha() {
  local asset_name="$1"
  local digest
  digest="$(printf '%s' "$release_json" | jq -r --arg name "$asset_name" \
    '.assets[] | select(.name == $name) | .digest // empty')"
  case "$digest" in
    sha256:*) printf '%s' "${digest#sha256:}" ;;
    *)
      echo "error: no sha256 digest found for $asset_name on $tag." >&2
      exit 1
      ;;
  esac
}

arm_sha="$(read_sha "ADE-$version-arm64.dmg")"
intel_sha="$(read_sha "ADE-$version-x64.dmg")"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
# CI (update-brew-tap.yml) sets ADE_TAP_GIT_URL + GIT_SSH_COMMAND (deploy key);
# locally fall back to `gh repo clone` using the user's gh auth.
if [ -n "${ADE_TAP_GIT_URL:-}" ]; then
  git clone -q --depth 1 "$ADE_TAP_GIT_URL" "$tmp_dir/tap"
else
  gh repo clone "$tap_repo" "$tmp_dir/tap" -- -q --depth 1
fi
cask="$tmp_dir/tap/Casks/ade.rb"

# Regenerate the cask. $version/$arm_sha/$intel_sha are shell-interpolated;
# #{version} and #{arch} stay literal (no leading $) so Homebrew resolves them
# per-machine at install time (arch -> arm64 | x64).
cat > "$cask" <<EOF
cask "ade" do
  arch arm: "arm64", intel: "x64"

  version "$version"
  sha256 arm: "$arm_sha", intel: "$intel_sha"

  url "https://github.com/arul28/ADE/releases/download/v#{version}/ADE-#{version}-#{arch}.dmg"
  name "ADE"
  desc "Agent development environment for orchestrating coding agents, lanes, and PRs"
  homepage "https://github.com/arul28/ADE"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :ventura

  app "ADE.app"

  zap trash: [
    "~/Library/Application Support/ADE",
    "~/Library/Caches/com.ade.desktop",
    "~/Library/Caches/com.ade.desktop.ShipIt",
    "~/Library/LaunchAgents/com.ade.runtime.plist",
    "~/Library/Preferences/com.ade.desktop.plist",
    "~/Library/Saved Application State/com.ade.desktop.savedState",
  ]
end
EOF

if git -C "$tmp_dir/tap" diff --quiet; then
  echo "Cask already at ADE $version — nothing to do."
  exit 0
fi

git -C "$tmp_dir/tap" \
  -c user.name="ade-release-bot" \
  -c user.email="release-bot@users.noreply.github.com" \
  commit -aqm "ade $version"
git -C "$tmp_dir/tap" push -q
echo "Updated $tap_repo cask to ADE $version (arm64 $arm_sha, x64 $intel_sha)."
