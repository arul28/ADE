#!/usr/bin/env bash
# Builds one TestFlight build of the ADE Beta app in CI and gives it to its
# testers.
#
#   bash scripts/release-tools/ios-testflight-ci.sh --label <beta tag> --sha <commit> [--dry-run] [--build-number <n>]
#
# Run from the repo root with <commit> checked out, on macOS. ios-testflight.yml
# runs it after each beta that changed iOS. The ADE Beta app
# (com.ade.ios.beta, the `Beta` build configuration) is a second TestFlight app
# beside ADE (com.ade.ios), so a bad beta never replaces the normal app on a
# phone. The normal app is built only for stable releases, by
# ios-testflight.sh from the release skill. See docs/plans/ios-beta-app.md.
#
# Steps: API key → signing → build number → archive → export → check the IPA →
# validate → upload → dSYMs to Sentry → wait for processing → What to Test →
# Internal Testers (and the public group, after Apple's beta review) → tag
# ios-beta-v<mv>-build<n>.
#
# --dry-run stops after the IPA check: it validates, uploads and tags nothing.
# --build-number skips the App Store Connect lookup (needed for a dry run with
# no API access).
#
# Environment:
#   APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER
#       App Store Connect API key (the .p8 text). Xcode signs with it
#       (-allowProvisioningUpdates) and asc uploads and distributes with it.
#   IOS_SIGNING_P12_BASE64, IOS_SIGNING_P12_PASSWORD (optional)
#       A .p12 with an Apple Development and an Apple Distribution certificate
#       and their private keys. Without it the job uses cloud signing: Xcode
#       creates a development certificate on the runner and signs the export
#       with a cloud-managed distribution certificate. That needs an API key
#       with the Admin role. With the .p12, an App Manager key is enough.
#   ADE_POSTHOG_PROJECT_TOKEN, ADE_POSTHOG_HOST (optional) analytics config.
#   SENTRY_AUTH_TOKEN (optional) dSYM upload; never fails the run.
#   IOS_TESTFLIGHT_GROUP (default "Internal Testers") the internal group.
#   IOS_TESTFLIGHT_PUBLIC_GROUP (default "Public Beta") the external group with
#       the public link. Its builds wait for Apple's beta review; a missing
#       group or a refused submission is a warning, never a failure.
set -euo pipefail

BUNDLE_ID=com.ade.ios.beta
# The normal app. Both apps take build numbers from one sequence, because
# brains refuse an iPhone build below MIN_SUPPORTED_MOBILE_APP_BUILD whichever
# app it is (apps/desktop/src/shared/syncMobileCompatibility.ts).
STABLE_APP=6762759870
PROJECT=apps/ios/ADE.xcodeproj
SCHEME=ADE
CONFIGURATION=Beta
EXPORT_OPTIONS=apps/ios/ExportOptions.auto.plist
GROUP_NAME="${IOS_TESTFLIGHT_GROUP:-Internal Testers}"
PUBLIC_GROUP_NAME="${IOS_TESTFLIGHT_PUBLIC_GROUP:-Public Beta}"

LABEL=""
SHA=""
DRY_RUN=0
BN="${IOS_BUILD_NUMBER:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --sha) SHA="${2:?--sha needs a value}"; shift 2 ;;
    --build-number) BN="${2:?--build-number needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$LABEL" ] && [ -n "$SHA" ] || { echo "usage: ios-testflight-ci.sh --label <beta tag> --sha <commit> [--dry-run] [--build-number <n>]" >&2; exit 2; }

TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
log() { echo "[ios-ci $(date +%H:%M:%S)] $*" >&2; }
fail() { if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::error::$*" >&2; else log "ERROR: $*"; fi; exit 1; }

# retry <attempts> <cmd...>: reruns on any failure, 60 s apart. App Store
# Connect often answers with 5xx errors and timeouts.
retry() {
  local n="$1"; shift
  local i out
  for i in $(seq 1 "$n"); do
    if out="$("$@" 2>&1)"; then echo "$out"; return 0; fi
    log "attempt $i/$n failed: $(echo "$out" | tail -1 | cut -c1-160)"
    [ "$i" -lt "$n" ] && sleep "${RETRY_DELAY_SECONDS:-60}"
  done
  echo "$out"; return 1
}

[ "$(uname -s)" = Darwin ] || fail "iOS builds need macOS"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$SHA^{commit}")" ] || fail "check out $SHA first"
for cmd in xcodebuild jq git; do command -v "$cmd" > /dev/null || fail "missing $cmd"; done
[ "$DRY_RUN" = 1 ] || command -v asc > /dev/null || fail "missing asc"
# The Duo layout and the other iOS 27 code sit behind `#if compiler(>=6.4)`.
# An older Xcode still builds the app, but without them, so stop here.
swift_version="$(xcrun swift -version 2>&1 | sed -nE 's/.*Apple Swift version ([0-9]+\.[0-9]+).*/\1/p' | head -1)"
awk -v v="${swift_version:-0.0}" 'BEGIN { split(v, a, "."); exit !(a[1] > 6 || (a[1] == 6 && a[2] >= 4)) }' \
  || fail "Xcode builds with Swift ${swift_version:-?}; ADE needs Swift 6.4 or newer (Xcode 27). Older compilers leave out the Duo layout and the other iOS 27 code."

# --- API key ---------------------------------------------------------------
[ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_P8:-}" ] \
  || fail "APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER are required"
KEY_DIR="$TMP/ade-asc-key"
KEYCHAIN=""
POSTHOG_XCCONFIG=""
# The key, the signing keychain and the analytics xcconfig never outlive the run.
cleanup() {
  if [ -n "$KEYCHAIN" ]; then security delete-keychain "$KEYCHAIN" 2> /dev/null || true; fi
  if [ -n "$POSTHOG_XCCONFIG" ]; then rm -f "$POSTHOG_XCCONFIG"; fi
  rm -rf "$KEY_DIR" "$TMP/ade-signing.p12"
}
trap cleanup EXIT
mkdir -p "$KEY_DIR"; chmod 700 "$KEY_DIR"
KP="$KEY_DIR/AuthKey_${APPLE_API_KEY_ID}.p8"
printf '%s\n' "$APPLE_API_KEY_P8" > "$KP"
chmod 600 "$KP"
grep -q "BEGIN PRIVATE KEY" "$KP" || fail "APPLE_API_KEY_P8 is not a .p8 private key"
# asc reads these; the keychain bypass keeps a runner's (or a laptop's) stored
# asc profile from taking precedence.
export ASC_KEY_ID="$APPLE_API_KEY_ID" ASC_ISSUER_ID="$APPLE_API_ISSUER" ASC_PRIVATE_KEY_PATH="$KP"
export ASC_BYPASS_KEYCHAIN=1 ASC_TIMEOUT="${ASC_TIMEOUT:-120s}"
AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath "$KP"
  -authenticationKeyID "$APPLE_API_KEY_ID"
  -authenticationKeyIssuerID "$APPLE_API_ISSUER")

# --- Signing ---------------------------------------------------------------
if [ -n "${IOS_SIGNING_P12_BASE64:-}" ]; then
  SIGNING=certificate
  KEYCHAIN="$TMP/ade-signing.keychain-db"
  kc_pass="$(uuidgen)"
  p12="$TMP/ade-signing.p12"
  printf '%s' "$IOS_SIGNING_P12_BASE64" | base64 --decode > "$p12"
  security create-keychain -p "$kc_pass" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$kc_pass" "$KEYCHAIN"
  security import "$p12" -k "$KEYCHAIN" -P "${IOS_SIGNING_P12_PASSWORD:-}" -T /usr/bin/codesign -T /usr/bin/security
  rm -f "$p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pass" "$KEYCHAIN" > /dev/null
  # Search this keychain first, then whatever the runner already had.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  identities="$(security find-identity -v -p codesigning "$KEYCHAIN")"
  echo "$identities" | grep -q "Apple Development" || fail "IOS_SIGNING_P12_BASE64 has no Apple Development identity"
  echo "$identities" | grep -q "Apple Distribution" || fail "IOS_SIGNING_P12_BASE64 has no Apple Distribution identity"
else
  SIGNING=cloud
fi
log "signing: $SIGNING"

# --- Versions --------------------------------------------------------------
MV="$(grep -m1 'MARKETING_VERSION = ' "$PROJECT/project.pbxproj" | sed -E 's/^[^M]*MARKETING_VERSION = ([^;]+);/\1/' | xargs)"
[ -n "$MV" ] || fail "could not read MARKETING_VERSION from $PROJECT"
APP=""
if command -v asc > /dev/null; then
  apps_json="$(retry 5 asc apps list --bundle-id "$BUNDLE_ID" --output json)" || fail "asc apps list failed: $(echo "$apps_json" | tail -1)"
  APP="$(printf '%s' "$apps_json" | jq -r --arg b "$BUNDLE_ID" '(.data // [])[] | select(.attributes.bundleId == $b) | .id' | head -n1)"
fi
if [ -z "$APP" ]; then
  [ "$DRY_RUN" = 1 ] || fail "App Store Connect has no app for $BUNDLE_ID. Create the ADE Beta app first (docs/plans/ios-beta-app.md)."
  log "no App Store Connect app for $BUNDLE_ID yet; the dry run numbers the build from ADE only"
fi
next_build_number() {
  local json
  json="$(retry 5 asc builds next-build-number --app "$1" --version "$MV" --platform IOS --output json)" \
    || fail "asc builds next-build-number failed for app $1: $(echo "$json" | tail -1)"
  printf '%s' "$json" | jq -r '.. | objects | select(has("nextBuildNumber")) | .nextBuildNumber' | tail -n1 | xargs
}
if [ -z "$BN" ]; then
  # The higher of the two apps' next numbers for this marketing version.
  BN="$(next_build_number "$STABLE_APP")"
  if [ -n "$APP" ]; then
    beta_bn="$(next_build_number "$APP")"
    [[ "$beta_bn" =~ ^[0-9]+$ ]] && [[ "$BN" =~ ^[0-9]+$ ]] && [ "$beta_bn" -gt "$BN" ] && BN="$beta_bn"
  fi
fi
[[ "$BN" =~ ^[0-9]+$ ]] || fail "invalid build number: '$BN'"
OUT="$TMP/ade-ios-$MV-build$BN"
ARCHIVE="$OUT/ADE.xcarchive"
mkdir -p "$OUT"
log "building $MV ($BN) from ${SHA:0:9} for $LABEL"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "marketing_version=$MV"; echo "build_number=$BN"; echo "archive=$ARCHIVE"; } >> "$GITHUB_OUTPUT"
fi

# --- PostHog ---------------------------------------------------------------
# The same scheme as the internal bump script: the values stay in protected
# environment variables, and the xcconfig only names them.
POSTHOG_XCCONFIG="$(mktemp "$TMP/ade-posthog.XXXXXX")"
printf '%s\n%s\n' "${ADE_POSTHOG_PROJECT_TOKEN:-}" "${ADE_POSTHOG_HOST:-}" \
  | /bin/sh apps/ios/Scripts/validate-posthog-project-token.sh --stdin
export ADE_POSTHOG_PROJECT_TOKEN_SECRET="${ADE_POSTHOG_PROJECT_TOKEN:-}" ADE_POSTHOG_HOST_SECRET="${ADE_POSTHOG_HOST:-}"
# shellcheck disable=SC2016 # Xcode expands these, not the shell.
{
  printf '%s\n' 'ADE_POSTHOG_PROJECT_TOKEN = $(ADE_POSTHOG_PROJECT_TOKEN_SECRET)'
  printf '%s\n' 'ADE_POSTHOG_HOST = $(ADE_POSTHOG_HOST_SECRET)'
} > "$POSTHOG_XCCONFIG"

# --- Archive and export ----------------------------------------------------
log "archiving (log: $OUT/archive.log)"
if ! xcodebuild archive -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIGURATION" \
    -destination generic/platform=iOS -archivePath "$ARCHIVE" "${AUTH[@]}" \
    -xcconfig "$POSTHOG_XCCONFIG" \
    "CURRENT_PROJECT_VERSION=$BN" "MARKETING_VERSION=$MV" > "$OUT/archive.log" 2>&1; then
  grep -E "error:|Signing|certificate|provisioning" "$OUT/archive.log" | tail -20 >&2 || true
  fail "archive failed (signing: $SIGNING); see $OUT/archive.log"
fi
rm -f "$POSTHOG_XCCONFIG"; POSTHOG_XCCONFIG=""
unset ADE_POSTHOG_PROJECT_TOKEN_SECRET ADE_POSTHOG_HOST_SECRET

log "exporting (log: $OUT/export.log)"
if ! xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$EXPORT_OPTIONS" \
    -exportPath "$OUT/export" "${AUTH[@]}" > "$OUT/export.log" 2>&1; then
  grep -E "error:|Cloud|certificate|permission|provisioning" "$OUT/export.log" | tail -20 >&2 || true
  fail "export failed (signing: $SIGNING); see $OUT/export.log"
fi
IPA="$OUT/export/ADE.ipa"
[ -s "$IPA" ] || fail "export wrote no $IPA"

# --- Check the IPA ---------------------------------------------------------
log "inspecting the IPA"
T="$OUT/ipa-check"; rm -rf "$T"; mkdir -p "$T"; ditto -x -k "$IPA" "$T"
for entry in "Payload/ADE.app $BUNDLE_ID" "Payload/ADE.app/PlugIns/ADEWidgets.appex $BUNDLE_ID.widgets"; do
  p="${entry% *}"; want_id="${entry#* }"
  [ -f "$T/$p/Info.plist" ] || fail "IPA is missing $p"
  got="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$T/$p/Info.plist") $(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$T/$p/Info.plist")"
  [ "$got" = "$MV $BN" ] || fail "$p is $got, expected $MV $BN"
  got_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$T/$p/Info.plist")"
  [ "$got_id" = "$want_id" ] || fail "$p is $got_id, expected $want_id"
done
# The App Clip belongs to the normal app only.
[ ! -e "$T/Payload/ADE.app/AppClips" ] || fail "the ADE Beta app must not embed the App Clip"
rm -rf "$T"

if [ "$DRY_RUN" = 1 ]; then
  log "DRY RUN: $MV ($BN) archived and exported to $IPA. Stopping before validate, upload, dSYMs, distribution and tag."
  exit 0
fi

# --- Validate and upload ---------------------------------------------------
validate() {
  API_PRIVATE_KEYS_DIR="$KEY_DIR" xcrun altool --validate-app --type ios \
    --file "$IPA" --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER"
}
log "validating with Apple"
retry 5 validate > "$OUT/validate.log" || { tail -20 "$OUT/validate.log" >&2; fail "Apple rejected the IPA"; }

log "uploading"
retry 8 asc builds upload --app "$APP" --ipa "$IPA" | tail -2

bash scripts/release-tools/upload-ios-dsyms.sh "$ARCHIVE"

# --- Processing ------------------------------------------------------------
find_build() {
  asc builds list --app "$APP" --version "$MV" --build-number "$BN" --platform IOS \
      --processing-state all --limit 20 --output json \
    | jq -r --arg b "$BN" '(.data // [])[] | select((.attributes.version | tostring) == $b) | "\(.id) \(.attributes.processingState)"' | head -n 1
}
log "waiting for processing"
existing=""
for _ in $(seq 1 60); do
  existing="$(find_build 2> /dev/null || true)"
  case "$existing" in
    *" VALID") break ;;
    *INVALID|*FAILED) fail "build $BN processing: $existing" ;;
  esac
  sleep 45
done
case "$existing" in *" VALID") ;; *) fail "build $BN not VALID after 45 min: '$existing'" ;; esac
BID="${existing%% *}"
log "build $BN is VALID ($BID)"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "build_id=$BID" >> "$GITHUB_OUTPUT"

retry 10 asc builds update --build-id "$BID" --uses-non-exempt-encryption=false > /dev/null

# --- What to Test ----------------------------------------------------------
notes="ADE $LABEL ($(git rev-parse --short=9 HEAD)). Please report sync or UI problems."
notes_json="$(retry 5 asc builds test-notes list --build-id "$BID" --locale en-US --output json)"
notes_id="$(printf '%s' "$notes_json" | jq -r '(.data // [])[] | select(.attributes.locale == "en-US") | .id' | head -n1 || true)"
if [ -n "$notes_id" ] && [ "$notes_id" != null ]; then
  retry 5 asc builds test-notes update --localization-id "$notes_id" --whats-new "$notes" > /dev/null
else
  retry 5 asc builds test-notes create --build-id "$BID" --locale en-US --whats-new "$notes" > /dev/null
fi

# --- Internal Testers only -------------------------------------------------
groups="$(retry 10 asc testflight groups list --app "$APP" --internal --paginate --output json)"
gid="$(printf '%s' "$groups" | jq -r --arg n "$GROUP_NAME" '(.data // [])[] | select(.attributes.name == $n) | .id' | head -n1)"
[ -n "$gid" ] || fail "no internal TestFlight group named '$GROUP_NAME'"
group_has_build() {
  asc testflight groups links view --group-id "$gid" --type builds --paginate --output json 2> /dev/null \
    | jq --arg b "$BID" '[(.data // [])[] | select(.id == $b)] | length' 2> /dev/null || echo 0
}
has="$(group_has_build)"
if [ "${has:-0}" -lt 1 ]; then
  # An internal group that receives every build refuses an explicit add; that
  # is fine. No --submit: an internal group needs no beta app review.
  for i in $(seq 1 10); do
    out="$(asc builds add-groups --build-id "$BID" --group "$gid" 2>&1 || true)"
    echo "$out" | grep -qE '"action":"added"|Cannot add internal group' && break
    log "add $GROUP_NAME attempt $i: $(echo "$out" | tail -1 | cut -c1-160)"; sleep 45
  done
  for _ in $(seq 1 10); do
    has="$(group_has_build)"; [ "${has:-0}" -ge 1 ] && break; sleep 30
  done
fi
[ "${has:-0}" -ge 1 ] || fail "group $GROUP_NAME does not have build $BN"
log "group $GROUP_NAME has build $BN"

# --- Public link -------------------------------------------------------------
# The external group behind the public link. Apple reviews its builds first, so
# testers get this build once Apple approves it. Never fails the run.
external="$(retry 5 asc testflight groups list --app "$APP" --paginate --output json 2> /dev/null || true)"
pid="$(printf '%s' "$external" | jq -r --arg n "$PUBLIC_GROUP_NAME" '(.data // [])[] | select(.attributes.name == $n and (.attributes.isInternalGroup | not)) | .id' 2> /dev/null | head -n1 || true)"
if [ -z "$pid" ]; then
  log "no external group named '$PUBLIC_GROUP_NAME'; the build stays with $GROUP_NAME"
else
  out="$(retry 5 asc builds add-groups --build-id "$BID" --group "$pid" --submit --confirm 2>&1 || true)"
  if echo "$out" | grep -qiE '"action":"added"|already'; then
    log "group $PUBLIC_GROUP_NAME has build $BN; it reaches testers after Apple's beta review"
  else
    [ "${GITHUB_ACTIONS:-}" = true ] && echo "::warning::could not give build $BN to $PUBLIC_GROUP_NAME: $(echo "$out" | tail -1 | cut -c1-200)"
    log "WARNING: $PUBLIC_GROUP_NAME did not take build $BN: $(echo "$out" | tail -1 | cut -c1-200)"
  fi
fi

# --- Tag -------------------------------------------------------------------
# ios-testflight.yml reads the newest ios-beta-v*-build* tag as the last ADE
# Beta build. The prefix keeps it out of scope.sh's `ios-v*` tags, which count
# the normal app's stable builds. A failed push is a warning: the build is
# already with testers.
TAG="ios-beta-v$MV-build$BN"
git rev-parse -q --verify "refs/tags/$TAG" > /dev/null || git tag -a "$TAG" "$SHA" -m "ADE Beta iOS $MV build $BN ($LABEL)"
git push -q origin "refs/tags/$TAG" 2>&1 | grep -v '^remote' || true
git ls-remote --exit-code --tags origin "refs/tags/$TAG" > /dev/null 2>&1 \
  || { [ "${GITHUB_ACTIONS:-}" = true ] && echo "::warning::could not push $TAG"; log "WARNING: $TAG not on origin"; }
log "IOS DONE: $MV ($BN) build $BID for $LABEL, tagged $TAG"
