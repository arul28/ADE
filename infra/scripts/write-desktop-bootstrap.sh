#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: ./scripts/write-desktop-bootstrap.sh <dev|staging|prod> [project-root]"
  exit 1
fi

STAGE="$1"
PROJECT_ROOT="${2:-$(cd "$(dirname "$0")/../.." && pwd)}"
INFRA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUTS_PATH="${INFRA_ROOT}/.sst/outputs.json"

if [[ ! -f "${OUTPUTS_PATH}" ]]; then
  echo "Missing ${OUTPUTS_PATH}. Run 'npx sst deploy --stage ${STAGE}' first."
  exit 1
fi

echo "Reading SST outputs from ${OUTPUTS_PATH}..."
OUTPUTS_JSON="$(cat "${OUTPUTS_PATH}")"

SST_OUTPUTS_JSON="${OUTPUTS_JSON}" node - "${PROJECT_ROOT}" "${STAGE}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = process.argv[2];
const stageArg = process.argv[3];
const raw = process.env.SST_OUTPUTS_JSON ?? "";
if (!raw.trim()) {
  throw new Error("Missing SST outputs JSON");
}

const root = JSON.parse(raw);
if (!root || typeof root !== "object") {
  throw new Error("SST outputs file is not a JSON object");
}
if (!root.apiUrl) {
  throw new Error("Missing 'apiUrl' in .sst/outputs.json. Re-run deploy and try again.");
}
if (root.stage && String(root.stage) !== String(stageArg)) {
  throw new Error(
    `Stage mismatch: outputs are for stage '${String(root.stage)}', but '${String(stageArg)}' was requested. Re-run deploy for the requested stage.`
  );
}

const clerk = root.clerk ?? {};
const region = String(root.region ?? "");

const config = {
  stage: String(root.stage ?? stageArg ?? "unknown"),
  apiBaseUrl: String(root.apiUrl ?? ""),
  region,
  clerkPublishableKey: String(clerk.publishableKey ?? ""),
  clerkOauthClientId: String(clerk.oauthClientId ?? ""),
  clerkIssuer: String(clerk.issuer ?? ""),
  clerkFrontendApiUrl: String(clerk.frontendApiUrl ?? ""),
  clerkOauthMetadataUrl: String(clerk.oauthMetadataUrl ?? ""),
  clerkOauthAuthorizeUrl: String(clerk.oauthAuthorizeUrl ?? ""),
  clerkOauthTokenUrl: String(clerk.oauthTokenUrl ?? ""),
  clerkOauthRevocationUrl: String(clerk.oauthRevocationUrl ?? ""),
  clerkOauthUserInfoUrl: String(clerk.oauthUserInfoUrl ?? ""),
  clerkOauthScopes: String(clerk.oauthScopes ?? "openid profile email offline_access"),
  generatedAt: new Date().toISOString()
};

for (const [key, value] of Object.entries(config)) {
  if (key === "generatedAt" || key === "stage") continue;
  if (!String(value).trim()) {
    throw new Error(`Missing required bootstrap field: ${key}`);
  }
}

const outPath = path.join(projectRoot, ".ade", "hosted", "bootstrap.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log(`Wrote desktop bootstrap config: ${outPath}`);
console.log(`  stage: ${config.stage}`);
console.log(`  api:   ${config.apiBaseUrl}`);
NODE
