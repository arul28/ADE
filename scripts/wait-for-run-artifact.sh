#!/usr/bin/env bash
# Waits until another job in this workflow run has uploaded an artifact.
#
# The release build jobs used to `need` every runtime binary job, so each one
# sat idle until the slowest runtime target (the Intel one, behind its runner
# queue) finished. Now they do their own setup first and wait here only for the
# one artifact they bundle. A failed or cancelled producer ends the wait at once
# instead of letting it run to the timeout.
#
#   scripts/wait-for-run-artifact.sh <artifact-name> <producer-job-name-substring>
#
# The producer substring matches the job's display name, which for a matrix job
# is "<job-id> (<matrix values>)" -- e.g. "build-runtime-binaries (win32-x64,".
# Renaming that job or reordering its matrix keys means updating the callers.
set -euo pipefail

artifact="$1"
producer="$2"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"
deadline=$(( $(date +%s) + ${WAIT_TIMEOUT_SECONDS:-2400} ))

while :; do
  count="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?name=$artifact" --jq '.total_count' 2>/dev/null || echo 0)"
  if [ "${count:-0}" -gt 0 ]; then
    echo "Artifact $artifact is ready."
    exit 0
  fi

  conclusion="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100" \
    --jq "[.jobs[] | select(.name | contains(\"$producer\")) | .conclusion // empty] | first // empty" 2>/dev/null || true)"
  case "$conclusion" in
    failure|cancelled|timed_out|skipped)
      echo "::error::$producer finished as $conclusion without uploading $artifact."
      exit 1
      ;;
  esac

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::Timed out waiting for $artifact from $producer."
    exit 1
  fi
  sleep 10
done
