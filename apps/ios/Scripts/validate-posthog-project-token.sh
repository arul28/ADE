#!/bin/sh

set -eu

LC_ALL=C
export LC_ALL

if [ "${1-}" = "--stdin" ]; then
  IFS= read -r token || token=""
  IFS= read -r host || host=""
else
  token="${1-}"
  host="${2-}"
fi

# Analytics is intentionally inert until a public project token is supplied.
if [ -z "$token" ]; then
  if [ -n "$host" ]; then
    echo "error: ADEPostHogHost cannot be set without ADEPostHogProjectToken." >&2
    exit 1
  fi
  exit 0
fi

fail() {
  echo "error: ADEPostHogProjectToken must be empty or a public PostHog project token (phc_ followed by 8-252 ASCII letters, digits, underscores, or hyphens). Personal phx_ API keys must never be embedded in the app." >&2
  exit 1
}

case "$token" in
  phc_*) ;;
  *) fail ;;
esac

suffix="${token#phc_}"
case "$suffix" in
  *[!A-Za-z0-9_-]*) fail ;;
esac

suffix_length=${#suffix}
if [ "$suffix_length" -lt 8 ] || [ "$suffix_length" -gt 252 ]; then
  fail
fi

# An empty host deliberately selects the in-app US ingestion default.
if [ -z "$host" ]; then
  exit 0
fi

fail_host() {
  echo "error: ADEPostHogHost must be an HTTPS origin with no credentials, path, query, or fragment (for example https://us.i.posthog.com)." >&2
  exit 1
}

case "$host" in
  https://*) ;;
  *) fail_host ;;
esac

authority="${host#https://}"
authority="${authority%/}"
case "$authority" in
  ""|*/*|*\?*|*\#*|*@*|*[!A-Za-z0-9.:-]*) fail_host ;;
esac

hostname="$authority"
case "$authority" in
  *:*)
    hostname="${authority%:*}"
    port="${authority##*:}"
    case "$port" in
      ""|*[!0-9]*) fail_host ;;
    esac
    if [ "${#port}" -gt 5 ]; then
      fail_host
    fi
    if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
      fail_host
    fi
    ;;
esac

case "$hostname" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9]|*..*|*[!A-Za-z0-9.-]*) fail_host ;;
esac
