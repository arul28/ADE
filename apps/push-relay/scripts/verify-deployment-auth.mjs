import { execFileSync } from "node:child_process";

const REQUIRED_PRIMARY_SECRETS = [
  "CLERK_JWKS_URL",
  "CLERK_ISSUER",
  "CLERK_OAUTH_CLIENT_ID",
];
const REQUIRED_SECONDARY_SECRETS = [
  "CLERK_SECONDARY_JWKS_URL",
  "CLERK_SECONDARY_ISSUER",
  "CLERK_SECONDARY_OAUTH_CLIENT_ID",
];
// Proves a machine came from the account-directory worker rather than merely
// holding an account token. The machine re-pair route (the only route whose
// effect is to UN-revoke a machine) fails closed without it, so a deploy that
// forgets it silently breaks re-pairing — catch it here instead.
const REQUIRED_DIRECTORY_SECRETS = ["DIRECTORY_AUTH_SECRET"];
const DEFAULT_RELAY_URL = "https://ade-push-relay.arulsharma1028.workers.dev";

function fail(message) {
  console.error(`Push relay authentication preflight failed: ${message}`);
  process.exit(1);
}

function listedSecretNames() {
  let output;
  try {
    output = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["wrangler", "secret", "list", "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch {
    fail("could not read the deployed Worker secret bindings");
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("Wrangler returned an unreadable secret list");
  }
  return new Set(
    (Array.isArray(parsed) ? parsed : [])
      .map((entry) => typeof entry?.name === "string" ? entry.name : "")
      .filter(Boolean),
  );
}

function assertSecretsPresent(names, required) {
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    fail(`missing Worker secret bindings: ${missing.join(", ")}`);
  }
}

async function assertHealth() {
  const relayUrl = (process.env.ADE_PUSH_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${relayUrl}/health`, {
      headers: { "user-agent": "ade-push-relay-deploy-smoke" },
    });
  } catch {
    fail("the deployed /health endpoint was unreachable");
  }
  if (!response.ok) fail(`/health returned HTTP ${response.status}`);
  const health = await response.json().catch(() => null);
  if (
    health?.ok !== true
    || health?.accountAuthConfigured !== true
    || health?.primaryAccountAuthConfigured !== true
    || health?.secondaryAccountAuthConfigured !== true
  ) {
    fail("the deployed Worker does not report complete primary and secondary account authentication");
  }
}

function smokeToken(name) {
  const token = process.env[name]?.trim() ?? "";
  if (!token) {
    fail(
      `${name} is required so deployment proves each configured Clerk issuer can authenticate a real account endpoint`,
    );
  }
  return token;
}

async function assertAuthenticatedAccountEndpoint(label, tokenName) {
  const relayUrl = (process.env.ADE_PUSH_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${relayUrl}/attention/account/snapshot?since=0`, {
      headers: {
        authorization: `Bearer ${smokeToken(tokenName)}`,
        "user-agent": `ade-push-relay-${label}-authenticated-deploy-smoke`,
      },
    });
  } catch {
    fail(`the deployed account snapshot endpoint was unreachable for the ${label} issuer`);
  }
  if (!response.ok) {
    fail(`${label} authenticated account snapshot returned HTTP ${response.status}`);
  }
  const snapshot = await response.json().catch(() => null);
  if (snapshot?.ok !== true || snapshot?.contractVersion !== 1) {
    fail(`${label} authenticated account snapshot returned an invalid contract`);
  }
}

const mode = process.argv[2] ?? "bindings";
if (!["bindings", "preflight", "health", "account"].includes(mode)) {
  fail(`unknown mode ${JSON.stringify(mode)}`);
}
if (mode === "bindings" || mode === "preflight") {
  const names = listedSecretNames();
  assertSecretsPresent(names, REQUIRED_PRIMARY_SECRETS);
  assertSecretsPresent(names, REQUIRED_SECONDARY_SECRETS);
  assertSecretsPresent(names, REQUIRED_DIRECTORY_SECRETS);
  if (mode === "preflight") {
    smokeToken("ADE_PUSH_RELAY_SMOKE_TOKEN");
    smokeToken("ADE_PUSH_RELAY_SECONDARY_SMOKE_TOKEN");
  }
  console.log("Push relay authentication bindings are complete.");
} else if (mode === "health") {
  await assertHealth();
  console.log("Push relay account authentication health is ready.");
} else {
  await assertAuthenticatedAccountEndpoint("primary", "ADE_PUSH_RELAY_SMOKE_TOKEN");
  await assertAuthenticatedAccountEndpoint(
    "secondary",
    "ADE_PUSH_RELAY_SECONDARY_SMOKE_TOKEN",
  );
  console.log("Push relay primary and secondary authenticated account snapshot smokes passed.");
}
