#!/usr/bin/env bash
# Builds, uploads and distributes one TestFlight build of ADE, then tags it.
#
#   bash scripts/release-tools/ios-testflight.sh <marketing-version> <build-number> <release-sha>
#
# Run from the repo root with <release-sha> checked out, on macOS. Uploads the
# archive's dSYMs to Sentry (upload-ios-dsyms.sh says where the token comes
# from). Safe to rerun:
# an IPA already exported for this build is reused, and a build already in App
# Store Connect is not uploaded again. App Store Connect often answers with 5xx
# errors and timeouts; every ASC call is retried, so do not wrap this in
# `timeout` (macOS has none) and do not retype its steps by hand.
set -euo pipefail
MV="${1:?usage: ios-testflight.sh <marketing-version> <build-number> <release-sha>}"
BN="${2:?build number}"
SHA="${3:?release sha}"
APP=6762759870
OUT=".ade/tmp/ios-testflight-$MV-build$BN"
export ASC_TIMEOUT="${ASC_TIMEOUT:-120s}"
log() { echo "[ios $(date +%H:%M:%S)] $*" >&2; }

# retry <attempts> <cmd...>: reruns on any failure, 60 s apart. Output of the
# last attempt goes to stdout.
retry() {
  local n="$1"; shift
  local i out
  for i in $(seq 1 "$n"); do
    if out="$("$@" 2>&1)"; then echo "$out"; return 0; fi
    log "attempt $i/$n failed: $(echo "$out" | tail -1 | cut -c1-160)"
    [ "$i" -lt "$n" ] && sleep 60
  done
  echo "$out"; return 1
}

[ "$(uname -s)" = Darwin ] || { echo "iOS releases need a macOS host"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$SHA")" ] || { echo "check out $SHA first"; exit 1; }
# The Duo layout and the other iOS 27 code sit behind `#if compiler(>=6.4)`.
# An older Xcode still builds the app, but without them, so stop here.
swift_version="$(xcrun swift -version 2>&1 | sed -nE 's/.*Apple Swift version ([0-9]+\.[0-9]+).*/\1/p' | head -1)"
awk -v v="${swift_version:-0.0}" 'BEGIN { split(v, a, "."); exit !(a[1] > 6 || (a[1] == 6 && a[2] >= 4)) }' \
  || { echo "Xcode builds with Swift ${swift_version:-?}; ADE needs Swift 6.4 or newer (Xcode 27). Older compilers leave out the Duo layout and the other iOS 27 code."; exit 1; }

C=~/.asc/config.json
KP="$(jq -r '.profiles.ade.keyPath // .keyPath // .privateKeyPath // .private_key_path // empty' "$C")"
KI="$(jq -r '.profiles.ade.keyId // .keyId // .key_id // empty' "$C")"
IS="$(jq -r '.profiles.ade.issuerId // .profiles.ade.issuer_id // .issuerId // .issuer_id // empty' "$C")"
[ -n "$KP" ] && [ -n "$KI" ] && [ -n "$IS" ] || { echo "ASC key path/id/issuer missing from $C"; exit 1; }
AUTH=(--xcodebuild-flag=-allowProvisioningUpdates
  --xcodebuild-flag=-authenticationKeyPath "--xcodebuild-flag=$KP"
  --xcodebuild-flag=-authenticationKeyID "--xcodebuild-flag=$KI"
  --xcodebuild-flag=-authenticationKeyIssuerID "--xcodebuild-flag=$IS")
mkdir -p "$OUT"

find_build() {
  asc builds list --app "$APP" --version "$MV" --platform IOS --limit 20 \
    | jq -r --arg b "$BN" '.data[] | select(.attributes.version == $b) | "\(.id) \(.attributes.processingState)"' | head -n 1
}
existing="$(retry 5 find_build || true)"

if [ -z "$existing" ]; then
  if [ ! -s "$OUT/ADE.ipa" ]; then
    log "archiving (logs: $OUT/archive.log)"
    asc xcode archive --project apps/ios/ADE.xcodeproj --scheme ADE --configuration Release --clean \
      --archive-path "$OUT/ADE.xcarchive" --overwrite --output json \
      --xcodebuild-flag=-destination --xcodebuild-flag=generic/platform=iOS "${AUTH[@]}" \
      "--xcodebuild-flag=CURRENT_PROJECT_VERSION=$BN" "--xcodebuild-flag=MARKETING_VERSION=$MV" \
      > "$OUT/archive.log" 2>&1
    log "exporting (logs: $OUT/export.log)"
    asc xcode export --archive-path "$OUT/ADE.xcarchive" --export-options apps/ios/ExportOptions.auto.plist \
      --ipa-path "$OUT/ADE.ipa" --overwrite --output json "${AUTH[@]}" > "$OUT/export.log" 2>&1
  fi

  log "inspecting the IPA"
  T="$OUT/ipa-check"; rm -rf "$T"; mkdir -p "$T"; ditto -x -k "$OUT/ADE.ipa" "$T"
  for p in Payload/ADE.app Payload/ADE.app/AppClips/ADEClip.app Payload/ADE.app/PlugIns/ADEWidgets.appex; do
    [ -f "$T/$p/Info.plist" ] || { echo "IPA is missing $p"; exit 1; }
    got="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$T/$p/Info.plist") $(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$T/$p/Info.plist")"
    [ "$got" = "$MV $BN" ] || { echo "$p is $got, expected $MV $BN"; exit 1; }
  done
  rm -rf "$T"

  log "validating with Apple"
  validate() {
    API_PRIVATE_KEYS_DIR="$(dirname "$KP")" xcrun altool --validate-app --type ios \
      --file "$OUT/ADE.ipa" --apiKey "$KI" --apiIssuer "$IS"
  }
  retry 5 validate > "$OUT/validate.log" || { tail -20 "$OUT/validate.log"; exit 1; }

  log "uploading"
  retry 8 asc builds upload --app "$APP" --ipa "$OUT/ADE.ipa" | tail -2
fi

# Every rerun uploads again: that is how a failed upload is retried.
bash scripts/release-tools/upload-ios-dsyms.sh "$OUT/ADE.xcarchive"

log "waiting for processing"
for i in $(seq 1 60); do
  existing="$(find_build 2>/dev/null || true)"
  case "$existing" in
    *" VALID") break ;;
    *INVALID|*FAILED) echo "build $BN processing: $existing"; exit 1 ;;
  esac
  sleep 45
done
case "$existing" in *" VALID") ;; *) echo "build $BN not VALID after 45 min: '$existing'"; exit 1 ;; esac
BID="${existing%% *}"
log "build $BN is VALID ($BID)"

retry 10 asc builds update --build-id "$BID" --uses-non-exempt-encryption=false > /dev/null

groups="$(retry 10 asc testflight groups list --app "$APP" --paginate)"
for gid in $(echo "$groups" | jq -r '.data[].id'); do
  name="$(echo "$groups" | jq -r --arg g "$gid" '.data[] | select(.id == $g) | .attributes.name')"
  group_has_build() {
    asc testflight groups links view --group-id "$gid" --type builds --paginate 2>/dev/null \
      | jq --arg b "$BID" '[.data[] | select(.id == $b)] | length' 2>/dev/null || echo 0
  }
  has="$(group_has_build)"
  if [ "${has:-0}" -lt 1 ]; then
    # An internal group that receives every build refuses an explicit add; that is fine.
    for i in $(seq 1 10); do
      out="$(asc builds add-groups --build-id "$BID" --group "$gid" --submit --confirm 2>&1 || true)"
      echo "$out" | grep -qE '"action":"added"|Cannot add internal group' && break
      log "add $name attempt $i: $(echo "$out" | tail -1 | cut -c1-160)"; sleep 45
    done
    for i in $(seq 1 10); do
      has="$(group_has_build)"; [ "${has:-0}" -ge 1 ] && break; sleep 30
    done
  fi
  testers="$(retry 5 asc testflight groups links view --group-id "$gid" --type betaTesters --paginate | jq '.data | length')"
  [ "${has:-0}" -ge 1 ] || { echo "group $name does not have build $BN"; exit 1; }
  log "group $name: testers=$testers has build"
done
retry 5 asc builds build-beta-detail view --build-id "$BID" | jq -c '.data.attributes'

TAG="ios-v$MV-build$BN"
git rev-parse -q --verify "refs/tags/$TAG" > /dev/null || git tag -a "$TAG" "$SHA" -m "iOS $MV build $BN"
git push -q origin "$TAG" 2>&1 | grep -v '^remote' || true
log "IOS DONE: $MV ($BN) build $BID, tagged $TAG"
