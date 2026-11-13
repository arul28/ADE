#!/usr/bin/env bash
# Runs a wrangler command again when Cloudflare's API had a short outage.
#
# Two of 100 Deploy Web runs (2026-11-12 and 11-13) failed on a 503 from
# Cloudflare's API ("Received a malformed response from the API ... -> 503
# Service Unavailable"), not on anything in ADE. This runs the command up to
# three times, 20 s and then 60 s apart, but only while its output names such
# a failure. Any other failure (a refused token, a bad config, a build error)
# ends at once with the command's own exit code, as before.
#
# Use it only for a command that is safe to repeat: a Worker or Pages deploy
# uploads the same bundle again. Never wrap a D1 migration: a retry after a
# migration that failed part-way could apply it twice.
#
#   scripts/ci/retry-cloudflare.sh <command> [args...]
set -uo pipefail

[ "$#" -gt 0 ] || { echo "usage: retry-cloudflare.sh <command> [args...]" >&2; exit 2; }

# Cloudflare's own transient answers, as wrangler prints them.
TRANSIENT='-> 5[0-9][0-9] |Received a malformed response from the API|upstream connect error|disconnect/reset before headers|\[code: 10013\]|Service Unavailable|Bad Gateway|Gateway Time-?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed'

log="$(mktemp "${RUNNER_TEMP:-/tmp}/retry-cloudflare.XXXXXX")"
trap 'rm -f "$log"' EXIT

delays=(20 60)
attempt=1
while :; do
  "$@" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  [ "$status" -eq 0 ] && exit 0
  if [ "$attempt" -gt "${#delays[@]}" ] || ! grep -Eq -- "$TRANSIENT" "$log"; then
    exit "$status"
  fi
  delay="${delays[$((attempt - 1))]}"
  echo "::warning::Cloudflare's API had a transient failure (attempt $attempt of $(( ${#delays[@]} + 1 ))); trying again in ${delay}s."
  sleep "$delay"
  attempt=$((attempt + 1))
done
