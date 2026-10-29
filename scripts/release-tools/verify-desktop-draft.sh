#!/usr/bin/env bash
# Checks a desktop release draft before it is made public. Exits non-zero and
# names every problem; prints "DRAFT OK" when the draft is safe to publish.
#
#   bash scripts/release-tools/verify-desktop-draft.sh 1.2.108
set -uo pipefail
V="${1:?usage: verify-desktop-draft.sh <version without v>}"
REPO="${GH_REPO:-arul28/ADE}"
DIR=".ade/tmp/release-v$V-verify"
fail=0
bad() { echo "FAIL: $*"; fail=1; }

rm -rf "$DIR" && mkdir -p "$DIR"
assets="$(gh release view "v$V" --repo "$REPO" --json assets --jq '.assets[] | "\(.name) \(.size)"')" \
  || { echo "FAIL: no release v$V"; exit 1; }
has() { echo "$assets" | awk '{print $1}' | grep -qx "$1"; }

gate="$(gh variable get ADE_WINDOWS_PUBLIC_RELEASE_ENABLED --repo "$REPO" 2>/dev/null || echo unset)"
required="ADE-$V-arm64.dmg ADE-$V-arm64.zip ADE-$V-x64.dmg ADE-$V-x64.zip latest-mac.yml install.sh SHA256SUMS release-manifest.json"
for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do required="$required ade-$t ade-$t.native.tar.gz"; done
win="ADE-$V-win-x64.exe ADE-$V-win-x64.exe.blockmap latest.yml install.ps1 ade-win32-x64.exe ade-win32-x64.native.tar.gz"
[ "$gate" = 1 ] && required="$required $win"
for a in $required; do has "$a" || bad "missing asset $a"; done

win_count="$(echo "$assets" | awk '{print $1}' | grep -cE 'win-x64|win32-x64|^latest\.yml$|^install\.ps1$')"
[ "$gate" != 1 ] && [ "$win_count" -gt 0 ] && bad "Windows gate is '$gate' but the draft carries $win_count Windows assets"

# Updater ZIPs over ~900 MB have crashed Squirrel.Mac.
echo "$assets" | awk '$1 ~ /\.zip$/ && $2 > 900*1024*1024 {print $1}' | while read -r z; do echo "FAIL: $z is over 900 MB"; done | grep . && fail=1

gh release download "v$V" --repo "$REPO" --pattern 'latest*.yml' --pattern release-manifest.json --dir "$DIR" --clobber
# Machines read this before installing (docs/plans/beta-track.md); it must
# describe this exact stable release.
if [ -f "$DIR/release-manifest.json" ]; then
  manifest="$(jq -r '"\(.tag) \(.track) \(.dbCompat|type) \(.syncProtocol.version|type)"' "$DIR/release-manifest.json" 2>/dev/null)"
  [ "$manifest" = "v$V stable number number" ] || bad "release-manifest.json does not describe stable v$V (got: ${manifest:-unreadable})"
fi
mac_refs="$(grep -E '^\s*(- )?(url|path):' "$DIR/latest-mac.yml" | awk '{print $NF}' | sort -u)"
echo "$mac_refs" | grep -q universal && bad "latest-mac.yml references a universal ZIP"
echo "$mac_refs" | grep -q "ADE-$V-arm64.zip" || bad "latest-mac.yml does not reference the arm64 ZIP"
echo "$mac_refs" | grep -q "ADE-$V-x64.zip" || bad "latest-mac.yml does not reference the x64 ZIP"
for r in $mac_refs; do has "$r" || bad "latest-mac.yml references missing $r"; done
if [ "$gate" = 1 ]; then
  for r in $(grep -E '^\s*(- )?(url|path):' "$DIR/latest.yml" | awk '{print $NF}' | sort -u); do
    has "$r" || bad "latest.yml references missing $r"
  done
fi

echo "gate=$gate windows_assets=$win_count assets=$(echo "$assets" | wc -l | tr -d ' ')"
[ "$fail" = 0 ] && echo "DRAFT OK" || exit 1
