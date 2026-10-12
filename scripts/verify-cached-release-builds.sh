#!/usr/bin/env bash
# Trusts a cached native build only when warm-release-caches.yml built it.
#
# The release signs, notarizes and ships the transcribe-cli binary and the Swift
# helpers it restores from the Actions cache. A cache entry on main can be
# written by any job that runs there, so a restored file is used only when it
# carries a build-provenance attestation from warm-release-caches.yml for this
# repository. Anything else is deleted, and the build compiles it from source:
# a bad cache costs time, never a signed binary nobody built.
#
#   scripts/verify-cached-release-builds.sh <env-flag-or-"-"> <file>...
# All files must verify; then <env-flag>=1 is written to GITHUB_ENV (pass "-"
# for none). Otherwise every listed file is removed.
set -uo pipefail

flag="$1"
shift
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?}"
signer="$GITHUB_REPOSITORY/.github/workflows/warm-release-caches.yml"

all_verified=1
for file in "$@"; do
  if [ ! -f "$file" ]; then
    all_verified=0
    continue
  fi
  name="$(basename "$file")"
  # Only main, only GitHub-hosted runners: a dispatch of the warm workflow on a
  # branch must not be able to vouch for a binary.
  if ! out="$(gh attestation verify "$file" --repo "$GITHUB_REPOSITORY" --signer-workflow "$signer" \
      --source-ref refs/heads/main --deny-self-hosted-runners --format json 2>&1)"; then
    echo "::warning::Cached $name was not verified as built by $signer on main; building it from source. ${out//$'\n'/ }"
    all_verified=0
    continue
  fi
  # The digest alone would accept any binary this workflow ever attested (an
  # older build, or another helper restored under this path): the attested
  # subject must also carry this file's name.
  # Collect the names first: `grep -q` stops reading early, and under pipefail
  # that can fail the pipeline even on a match.
  subjects="$(printf '%s' "$out" | jq -r '.[].verificationResult.statement.subject[].name' 2>/dev/null || true)"
  if ! printf '%s\n' "$subjects" | grep -qxF "$name"; then
    echo "::warning::Cached $name matches an attestation for a different file; building it from source."
    all_verified=0
    continue
  fi
  echo "Verified cached $name against $signer."
done

if [ "$all_verified" = 1 ]; then
  [ "$flag" = "-" ] || echo "$flag=1" >> "$GITHUB_ENV"
else
  rm -f "$@"
fi
