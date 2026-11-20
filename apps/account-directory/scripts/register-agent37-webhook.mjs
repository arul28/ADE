#!/usr/bin/env node
/**
 * Registers the account directory's status webhook with the compute provider
 * (Agent 37), once per Worker environment, and prints the signing secret.
 *
 *   AGENT37_API_KEY=sk_live_... node scripts/register-agent37-webhook.mjs https://<worker-origin>
 *
 * The webhook covers every instance of the workspace the key belongs to, so
 * the Worker that holds the same key receives each `instance.status.updated`
 * at `POST /cloud/agent37/webhook` (src/cloud/computerStatus.ts).
 *
 * The provider returns the secret in this one answer only: store it right
 * away with `npx wrangler secret put AGENT37_WEBHOOK_SECRET [--env production]`.
 * Safe to rerun: a webhook already registered for the same URL is left as it
 * is and nothing new is made (its secret can't be read again; to rotate it,
 * delete that webhook in the provider's dashboard or API, then rerun).
 * A workspace holds at most 5 webhooks.
 */

const API = "https://api.agent37.com/v1";
const PATH = "/cloud/agent37/webhook";

const origin = (process.argv[2] ?? "").trim().replace(/\/+$/, "");
const key = (process.env.AGENT37_API_KEY ?? "").trim();
if (!/^https:\/\/[^/]+$/.test(origin)) {
  console.error("Pass the Worker's https origin, for example: node scripts/register-agent37-webhook.mjs https://directory.example.com");
  process.exit(2);
}
if (!key) {
  console.error("Set AGENT37_API_KEY (the same workspace key the Worker holds) in this shell.");
  process.exit(2);
}

const url = `${origin}${PATH}`;
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" };

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const code = parsed?.error?.code ?? parsed?.error ?? `http_${response.status}`;
    throw new Error(`${method} ${path} answered ${response.status} (${code})`);
  }
  return parsed;
}

const existing = await call("GET", "/webhooks");
const same = (existing?.data ?? []).find((hook) => hook?.url === url);
if (same) {
  console.log(`Already registered: ${same.id} -> ${url}`);
  if (same.last_failure) console.log(`Its last failed delivery: ${JSON.stringify(same.last_failure)}`);
  console.log("Nothing changed. Its secret can't be read again; delete it and rerun to get a new one.");
  process.exit(0);
}

const made = await call("POST", "/webhooks", { url });
if (!made?.secret) throw new Error("The provider made the webhook but sent no secret. Delete it and try again.");
console.log(`Registered ${made.id} -> ${url}`);
console.log("");
console.log("Signing secret (shown once, store it now):");
console.log(made.secret);
console.log("");
console.log("Store it on the Worker that serves this origin:");
console.log("  npx wrangler secret put AGENT37_WEBHOOK_SECRET            # development");
console.log("  npx wrangler secret put AGENT37_WEBHOOK_SECRET --env production");
