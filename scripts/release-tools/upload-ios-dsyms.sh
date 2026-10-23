#!/usr/bin/env bash
# Uploads an iOS archive's dSYMs to Sentry (org ade-app, project ade-ios) so
# crash and hang reports name ADE's own frames.
#
#   bash scripts/release-tools/upload-ios-dsyms.sh <path/to/ADE.xcarchive>
#
# The token is SENTRY_AUTH_TOKEN from the environment, else the ADE project
# secret SENTRY_AUTH_TOKEN, else (local runs only) ~/.sentryclirc; it must
# belong to the ade-app org. Never fails the caller: a missing token prints one
# "skipping" line, a missing archive or a failed upload one warning. Sentry
# keeps one copy per debug id, so reruns are safe.
set -uo pipefail
ARCHIVE="${1:?usage: upload-ios-dsyms.sh <archive>}"
DSYMS="$ARCHIVE/dSYMs"
SENTRY_CLI_VERSION=3.8.0
say() { echo "[ios-dsyms] $*" >&2; }
# In GitHub Actions a warning also annotates the run.
warn() { if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::warning::$*"; else say "WARNING: $*"; fi; }

if [ ! -d "$DSYMS" ]; then
  warn "no dSYMs at $DSYMS; this build will not be symbolicated in Sentry"
  exit 0
fi
if [ -z "${SENTRY_AUTH_TOKEN:-}" ] && command -v ade > /dev/null 2>&1; then
  token="$(ade secrets get SENTRY_AUTH_TOKEN --text 2> /dev/null || true)"
  [ -n "$token" ] && export SENTRY_AUTH_TOKEN="$token"
fi
# CI uses only its secret: a runner's own ~/.sentryclirc may belong to another org.
if [ -z "${SENTRY_AUTH_TOKEN:-}" ] && { [ "${GITHUB_ACTIONS:-}" = true ] || [ ! -f "$HOME/.sentryclirc" ]; }; then
  say "no Sentry token (SENTRY_AUTH_TOKEN or ADE secret); skipping the dSYM upload"
  exit 0
fi

log="$(mktemp)"
for attempt in 1 2; do
  if npx --yes "@sentry/cli@$SENTRY_CLI_VERSION" debug-files upload --org ade-app --project ade-ios \
      --type dsym --include-sources --wait "$DSYMS" > "$log" 2>&1; then
    say "dSYMs uploaded to Sentry"
    rm -f "$log"
    exit 0
  fi
  # Auth and org mistakes do not heal on a retry.
  grep -qiE "not found|unauthorized|forbidden|401|403" "$log" && break
  [ "$attempt" -lt 2 ] && sleep 30
done
warn "Sentry dSYM upload FAILED; this build stays unsymbolicated until it is rerun: $(tail -1 "$log")"
rm -f "$log"
exit 0
