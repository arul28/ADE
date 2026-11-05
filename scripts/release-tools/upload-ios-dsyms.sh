#!/usr/bin/env bash
# Uploads an iOS archive's dSYMs to Sentry (org ade-app, project ade-ios) and
# to PostHog error tracking, so crash and hang reports in both name ADE's own
# frames. The `$exception` events the app sends PostHog carry the same raw
# frames Sentry gets (ProductAnalyticsException.swift).
#
#   bash scripts/release-tools/upload-ios-dsyms.sh <path/to/ADE.xcarchive>
#
# Sentry: SENTRY_AUTH_TOKEN from the environment, else the ADE project secret
# SENTRY_AUTH_TOKEN, else (local runs only) ~/.sentryclirc; it must belong to
# the ade-app org. PostHog: POSTHOG_PERSONAL_API_KEY (error tracking write)
# and POSTHOG_PROJECT_ID from the environment, else (local runs only) the ADE
# secret ADE_POSTHOG_FULL_ACCESS_ACCOUNT_TOKEN and project 510983.
#
# Never fails the caller: a missing token prints one "skipping" line, a
# missing archive or a failed upload one warning. Both keep one copy per debug
# id, so reruns are safe.
set -uo pipefail
ARCHIVE="${1:?usage: upload-ios-dsyms.sh <archive>}"
DSYMS="$ARCHIVE/dSYMs"
SENTRY_CLI_VERSION=3.8.0
# Same pin as scripts/posthog/upload-sourcemaps.mjs.
POSTHOG_CLI_VERSION=0.19.0
say() { echo "[ios-dsyms] $*" >&2; }
# In GitHub Actions a warning also annotates the run.
warn() { if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::warning::$*"; else say "WARNING: $*"; fi; }
ade_secret() { command -v ade > /dev/null 2>&1 && ade secrets get "$1" --text 2> /dev/null || true; }

if [ ! -d "$DSYMS" ]; then
  warn "no dSYMs at $DSYMS; this build will not be symbolicated in Sentry or PostHog"
  exit 0
fi

upload_sentry() {
  if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
    local token
    token="$(ade_secret SENTRY_AUTH_TOKEN)"
    [ -n "$token" ] && export SENTRY_AUTH_TOKEN="$token"
  fi
  # CI uses only its secret: a runner's own ~/.sentryclirc may belong to another org.
  if [ -z "${SENTRY_AUTH_TOKEN:-}" ] && { [ "${GITHUB_ACTIONS:-}" = true ] || [ ! -f "$HOME/.sentryclirc" ]; }; then
    say "no Sentry token (SENTRY_AUTH_TOKEN or ADE secret); skipping the Sentry dSYM upload"
    return
  fi
  local log attempt
  log="$(mktemp)"
  for attempt in 1 2; do
    if npx --yes "@sentry/cli@$SENTRY_CLI_VERSION" debug-files upload --org ade-app --project ade-ios \
        --type dsym --include-sources --wait "$DSYMS" > "$log" 2>&1; then
      say "dSYMs uploaded to Sentry"
      rm -f "$log"
      return
    fi
    # Auth and org mistakes do not heal on a retry.
    grep -qiE "not found|unauthorized|forbidden|401|403" "$log" && break
    [ "$attempt" -lt 2 ] && sleep 30
  done
  warn "Sentry dSYM upload FAILED; this build stays unsymbolicated in Sentry until it is rerun: $(tail -1 "$log")"
  rm -f "$log"
}

upload_posthog() {
  local key="${POSTHOG_PERSONAL_API_KEY:-}" project="${POSTHOG_PROJECT_ID:-}"
  if [ -z "$key" ] && [ "${GITHUB_ACTIONS:-}" != true ]; then
    key="$(ade_secret ADE_POSTHOG_FULL_ACCESS_ACCOUNT_TOKEN)"
    [ -z "$project" ] && project=510983
  fi
  if [ -z "$key" ] || [ -z "$project" ]; then
    say "no PostHog key (POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID); skipping the PostHog dSYM upload"
    return
  fi
  local log
  log="$(mktemp)"
  # PostHog finds a symbol set by its dSYM's debug id, so no release is named.
  if POSTHOG_CLI_API_KEY="$key" POSTHOG_CLI_PROJECT_ID="$project" \
      npx --yes "@posthog/cli@$POSTHOG_CLI_VERSION" --host "${POSTHOG_HOST:-https://us.posthog.com}" \
      dsym upload --directory "$DSYMS" --skip-on-conflict > "$log" 2>&1; then
    say "dSYMs uploaded to PostHog"
  else
    warn "PostHog dSYM upload FAILED; this build stays unsymbolicated in PostHog until it is rerun: $(tail -1 "$log")"
  fi
  rm -f "$log"
}

upload_sentry
upload_posthog
exit 0
