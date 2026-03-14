#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: ./scripts/deploy.sh <dev|staging|prod>"
  exit 1
fi

STAGE="$1"
export AWS_PROFILE="${AWS_PROFILE:-arulsharma}"

echo "Deploying ADE infra"
echo "  stage:   ${STAGE}"
echo "  profile: ${AWS_PROFILE}"

npx sst deploy --stage "${STAGE}"
