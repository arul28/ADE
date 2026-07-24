#!/usr/bin/env bash
# Internal TestFlight only: MARKETING_VERSION comes from Xcode project (no semver bump workflow).
# CFBundleVersion is always asc builds next-build-number for that marketing version.
# Distributes only to ASC internal beta groups (--internal). Matches release.md Phase 7e sequencing.
set -euo pipefail

prepend_interactive_shell_path() {
  local dir
  for dir in /opt/homebrew/bin /opt/homebrew/sbin /usr/local/bin /usr/local/sbin; do
    if [[ -d "$dir" && ":${PATH:-}:" != *":${dir}:"* ]]; then
      PATH="${dir}${PATH:+:$PATH}"
    fi
  done
  export PATH
}

prepend_interactive_shell_path

err() {
  printf '::error::%s\n' "$*" >&2
}

notice() {
  printf '::notice::%s\n' "$*" >&2
}

cleanup_posthog_xcconfig() {
  if [[ -n "${posthog_xcconfig:-}" ]]; then
    rm -f "${posthog_xcconfig}"
  fi
  unset ADE_POSTHOG_PROJECT_TOKEN_SECRET ADE_POSTHOG_HOST_SECRET || true
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    exit 1
  fi
}

extract_marketing_version() {
  local pbx="$1"
  grep -m1 'MARKETING_VERSION = ' "$pbx" | sed -E 's/^[^M]*MARKETING_VERSION = ([^;]+);/\1/' | xargs
}

resolve_next_build_number() {
  local app_id="$1" marketing="$2"
  local json
  json="$(asc builds next-build-number --app "$app_id" --version "$marketing" --platform IOS --output json)"
  local n
  n="$(printf '%s' "$json" | jq -r '.. | objects | select(has("nextBuildNumber")) | .nextBuildNumber' | tail -n1 | xargs)"
  if [[ -n "$n" && "$n" != "null" ]]; then
    printf '%s' "$n"
    return 0
  fi
  err "could not parse next build number from asc (raw: ${json:0:400})"
  exit 1
}

internal_group_summaries_for_log() {
  local json="$1"
  printf '%s' "$json" | jq -r '(.data // [])[] | "- \(.attributes.name // "unnamed") (\(.id))"'
}

testflight_whats_new() {
  local notes="${IOS_TESTFLIGHT_WHATS_NEW:-}"
  if [[ -z "${notes//[[:space:]]/}" ]]; then
    notes='Please test pairing with your ADE machine, browsing Work sessions, lanes, pull requests, and files, and report unexpected sync or UI behavior.'
  fi
  printf '%s' "$notes"
}

submit_for_app_review_if_requested() {
  local app_id="$1" marketing="$2" build_id="$3"
  local requested="${IOS_SUBMIT_FOR_APP_REVIEW:-false}"

  case "$requested" in
    false|'')
      notice 'App Store review submission was not requested; this build remains an internal TestFlight build only.'
      return 0
      ;;
    true)
      ;;
    *)
      err "IOS_SUBMIT_FOR_APP_REVIEW must be true or false (received: ${requested})"
      exit 1
      ;;
  esac

  notice "Validating and submitting ${marketing} build ${build_id} to App Store review."
  asc validate --app "${app_id}" --version "${marketing}" --platform IOS --output table
  asc review submit \
    --app "${app_id}" \
    --version "${marketing}" \
    --build "${build_id}" \
    --confirm \
    --output table
}

configure_api_key_for_xcode() {
  local key_path key_id issuer

  key_path="${ASC_AUTHENTICATION_KEY_PATH:-${ASC_AUTH_KEY_PATH:-}}"
  key_id="${ASC_AUTHENTICATION_KEY_ID:-${ASC_KEY_ID:-}}"
  issuer="${ASC_AUTHENTICATION_ISSUER_ID:-${ASC_ISSUER_ID:-}}"
  issuer="${issuer:-${ASC_ISSUER:-}}"

  if [[ -z "${key_path:-}" && -n "${APPLE_API_KEY_P8:-}" && -n "${APPLE_API_KEY_ID:-}" ]]; then
    local dest="${RUNNER_TEMP:-/tmp}/AuthKey_${APPLE_API_KEY_ID}.p8"
    printf '%s' "$APPLE_API_KEY_P8" >"$dest"
    chmod 600 "$dest"
    key_path="$dest"
    key_id="${key_id:-$APPLE_API_KEY_ID}"
    issuer="${issuer:-${APPLE_API_ISSUER:-}}"
  fi

  if [[ -z "${key_path:-}" && -f "${HOME}/.asc/config.json" ]]; then
    local cfg="${HOME}/.asc/config.json"
    key_path="${key_path:-$(jq -r '.privateKeyPath // .authenticationKeyPath // .key.path // empty' "$cfg")}"
    key_id="${key_id:-$(jq -r '.keyId // .keyID // .authenticationKeyID // empty' "$cfg")}"
    issuer="${issuer:-$(jq -r '.issuerId // .issuerID // empty' "$cfg")}"
    if [[ -n "${key_path}" && "${key_path}" != "/"* ]]; then
      key_path="${HOME}/${key_path#./}"
    fi
  fi

  key_path="$(printf '%s' "${key_path:-}" | xargs)"

  if [[ -z "${key_path}" || ! -r "${key_path}" ]]; then
    err 'missing readable App Store Connect API key (.p8): mirror your `/release` setup — ~/.asc/config.json + key path on this user, exported ASC_AUTHENTICATION_* / ASC_* overrides, or runner env APPLE_API_KEY_* (AuthKey *.p8 + id/s)'
    exit 1
  fi
  if [[ -z "${key_id}" ]]; then
    err 'missing API key id: ~/.asc/config.json keyId/KID exports, APPLE_API_KEY_* env, or ASC_AUTHENTICATION_* / ASC_KEY_ID'
    exit 1
  fi
  if [[ -z "${issuer}" ]]; then
    err 'missing issuer id: ~/.asc/config.json issuerId, APPLE_API_ISSUER env, or ASC_AUTHENTICATION_ISSUER_ID / ASC_ISSUER_ID'
    exit 1
  fi

  export ASC_KEY_PATH="$key_path"
  export ASC_KEY_ID="$key_id"
  export ASC_ISSUER_ID="$issuer"
}

create_posthog_xcconfig() {
  local root="$1"
  local token="${ADE_POSTHOG_PROJECT_TOKEN:-}"
  local host="${ADE_POSTHOG_HOST:-}"
  local validator="${root}/apps/ios/Scripts/validate-posthog-project-token.sh"

  if [[ ! -f "${validator}" ]]; then
    err "missing PostHog configuration validator at ${validator}"
    exit 1
  fi

  # Read the token over stdin so it never appears in a process argument or log.
  printf '%s\n%s\n' "${token}" "${host}" | /bin/sh "${validator}" --stdin

  umask 077
  posthog_xcconfig="$(mktemp "${RUNNER_TEMP:-/tmp}/ade-posthog.XXXXXX")"

  # Xcode imports these protected environment variables only when the
  # xcconfig references them. Keeping the values out of the file also keeps
  # xcodebuild's "Build settings from configuration file" log secret-free.
  export ADE_POSTHOG_PROJECT_TOKEN_SECRET="${token}"
  export ADE_POSTHOG_HOST_SECRET="${host}"
  {
    printf '%s\n' 'ADE_POSTHOG_PROJECT_TOKEN = $(ADE_POSTHOG_PROJECT_TOKEN_SECRET)'
    printf '%s\n' 'ADE_POSTHOG_HOST = $(ADE_POSTHOG_HOST_SECRET)'
  } >"${posthog_xcconfig}"

  if [[ -n "${token}" ]]; then
    notice 'PostHog product analytics is configured for this iOS archive.'
  else
    notice 'PostHog product analytics is not configured; this iOS archive will remain analytics-inert.'
  fi
}

main() {
  require_cmd asc
  require_cmd jq

  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    notice "GITHUB_ACTIONS run as $(id -un) (${HOME}); asc=$(command -v asc)"
  fi

  local root="${GITHUB_WORKSPACE:-}"
  if [[ -z "${root}" ]]; then
    err 'GITHUB_WORKSPACE is not set'
    exit 1
  fi

  local pbx="${root}/apps/ios/ADE.xcodeproj/project.pbxproj"
  if [[ ! -f "${pbx}" ]]; then
    err "missing Xcode project at ${pbx}"
    exit 1
  fi

  local app_id="${ASC_APP_ID:-}"
  app_id="$(printf '%s' "${APPLE_IOS_APP_ID:-$app_id}" | xargs)"
  if [[ -z "${app_id}" ]]; then
    err 'missing App Store Connect app id: export ASC_APP_ID (preferred) or APPLE_IOS_APP_ID in the runner service environment ~/.env shell block so Phase 7 matches `/release`.'
    exit 1
  fi

  local scheme="${IOS_XCODE_SCHEME:-ADE}"
  local project_rel="${IOS_XCODE_PROJECT:-apps/ios/ADE.xcodeproj}"
  local export_rel="${IOS_EXPORT_OPTIONS_PLIST:-apps/ios/ExportOptions.auto.plist}"
  local timeout="${ASC_PUBLISH_WAIT_TIMEOUT:-60m}"

  local marketing
  marketing="$(extract_marketing_version "${pbx}")"
  if [[ -z "${marketing}" ]]; then
    err 'could not read MARKETING_VERSION from Xcode project (apps/ios/ADE.xcodeproj)'
    exit 1
  fi

  configure_api_key_for_xcode

  local build_number
  build_number="$(resolve_next_build_number "$app_id" "$marketing")"
  if ! [[ "${build_number}" =~ ^[0-9]+$ ]]; then
    err "asc returned invalid build number: '${build_number}'"
    exit 1
  fi

  local groups_json group_csv
  groups_json="$(asc testflight groups list --app "$app_id" --internal --paginate --output json)"
  group_csv="$(printf '%s' "$groups_json" | jq -r '(.data // [])[] | .id' | paste -sd, - || true)"
  group_csv="$(printf '%s' "${group_csv}" | xargs)"
  if [[ -z "${group_csv}" ]]; then
    err 'no internal TestFlight groups found (asc testflight groups list --internal). Create at least one internal group in App Store Connect.'
    exit 1
  fi

  local work_dir="${RUNNER_TEMP:-/tmp}/ade-ios-internal-bump-${build_number}"
  mkdir -p "${work_dir}"
  local archive_path="${work_dir}/ADE.xcarchive"
  local ipa_path="${work_dir}/ADE.ipa"
  rm -rf "${archive_path}" "${ipa_path}"

  create_posthog_xcconfig "${root}"

  asc doctor

  notice "Building marketing_version=${marketing} (from Xcode project); new build_number=${build_number} (from asc); internal groups: ${group_csv}"

  asc publish testflight \
    --app "${app_id}" \
    --project "${root}/${project_rel}" \
    --scheme "${scheme}" \
    --version "${marketing}" \
    --export-options "${root}/${export_rel}" \
    --initial-build-number "${build_number}" \
    --archive-path "${archive_path}" \
    --ipa-path "${ipa_path}" \
    --wait \
    --timeout "${timeout}" \
    --pretty \
    --archive-xcodebuild-flag "-allowProvisioningUpdates" \
    --archive-xcodebuild-flag "-authenticationKeyPath" \
    --archive-xcodebuild-flag "${ASC_KEY_PATH}" \
    --archive-xcodebuild-flag "-authenticationKeyID" \
    --archive-xcodebuild-flag "${ASC_KEY_ID}" \
    --archive-xcodebuild-flag "-authenticationKeyIssuerID" \
    --archive-xcodebuild-flag "${ASC_ISSUER_ID}" \
    --archive-xcodebuild-flag "-xcconfig" \
    --archive-xcodebuild-flag "${posthog_xcconfig}" \
    --archive-xcodebuild-flag "CURRENT_PROJECT_VERSION=${build_number}" \
    --archive-xcodebuild-flag "MARKETING_VERSION=${marketing}"

  cleanup_posthog_xcconfig
  posthog_xcconfig=""

  local builds_json build_id test_notes test_notes_json test_notes_id
  builds_json="$(asc builds list --app "${app_id}" --platform IOS --version "${marketing}" --build-number "${build_number}" --limit 25 --output json)"
  build_id="$(printf '%s' "$builds_json" | jq -r --arg bn "${build_number}" '(.data // [])[] | select((.attributes.version | tostring) == $bn) | .id' | head -n1 || true)"

  if [[ -z "${build_id}" || "${build_id}" == 'null' ]]; then
    err "could not resolve asc build id for marketing=${marketing} build=${build_number}"
    printf '%s\n' "$builds_json" >&2
    exit 1
  fi

  asc builds update --build-id "${build_id}" --uses-non-exempt-encryption=false

  test_notes="$(testflight_whats_new)"
  test_notes_json="$(asc builds test-notes list --build-id "${build_id}" --locale en-US --output json)"
  test_notes_id="$(printf '%s' "${test_notes_json}" | jq -r '(.data // [])[] | select(.attributes.locale == "en-US") | .id' | head -n1 || true)"
  if [[ -n "${test_notes_id}" && "${test_notes_id}" != 'null' ]]; then
    asc builds test-notes update --localization-id "${test_notes_id}" --whats-new "${test_notes}"
  else
    asc builds test-notes create --build-id "${build_id}" --locale en-US --whats-new "${test_notes}"
  fi
  asc validate testflight --app "${app_id}" --build "${build_id}" --output table

  asc builds add-groups --build-id "${build_id}" --group "${group_csv}" --submit --confirm
  submit_for_app_review_if_requested "${app_id}" "${marketing}" "${build_id}"

  local summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
  {
    printf '## Internal-only TestFlight build bump\n\n'
    printf '- **Marketing version** comes from Xcode only (**%s**). Bump it only when you deliberately ship a new user-facing App Store version.\n' "${marketing}"
    printf '- **Build number** always comes from `asc builds next-build-number` (**%s**).\n\n' "${build_number}"
    printf '- asc build id: `%s`\n' "${build_id}"
    printf '- IPA: `%s`\n\n' "${ipa_path}"
    printf '- **What to Test:** %s\n\n' "${test_notes}"
    printf '- **App Store review:** %s\n\n' "${IOS_SUBMIT_FOR_APP_REVIEW:-false}"
    printf '### Internal beta groups (all)\n\n'
    internal_group_summaries_for_log "${groups_json}"
    printf '\n\n'
  } >>"${summary}"

  if [[ -n "${GITHUB_ENV:-}" ]]; then
    {
      printf 'ADE_IOS_IPA_PATH=%s\n' "${ipa_path}"
      printf 'ADE_IOS_ASC_BUILD_ID=%s\n' "${build_id}"
      printf 'ADE_IOS_BUILD_NUMBER=%s\n' "${build_number}"
      printf 'ADE_IOS_MARKETING_VERSION=%s\n' "${marketing}"
    } >>"${GITHUB_ENV}"
  fi
}

posthog_xcconfig=""
trap cleanup_posthog_xcconfig EXIT

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
