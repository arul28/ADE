#!/usr/bin/env node
// Reconciles Clerk accounts with PostHog `ade_signed_up` events, and with
// `--apply` sends the sign-ups PostHog is missing.
//
// The account-directory Worker records `ade_signed_up` from Clerk's
// `user.created` webhook (apps/account-directory/src/signupAnalytics.ts). This
// script is the check on that path and the backfill for accounts that signed
// up before it existed or while it was down. A backfilled event is built the
// same way as the webhook's: same distinct id, same uuid, same timestamp (the
// account's created_at), same properties, plus `backfilled: true`, so PostHog
// keeps one sign-up per account whichever path recorded it.
//
// Reads only ids, created_at, the OAuth provider name and the `ade_internal`
// metadata flag from Clerk. Never prints a secret, an email, or a Clerk user id.
//
// Exit codes: 0 ok; 1 a check run found more missing sign-ups than
// --max-missing; 2 a request or argument failed.
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_PROJECT_ID = "510983";
const DEFAULT_QUERY_HOST = "https://us.posthog.com";
const DEFAULT_CAPTURE_HOST = "https://us.i.posthog.com";
const CLERK_API = "https://api.clerk.com/v1";
const CLERK_PAGE_SIZE = 500;
const POSTHOG_PAGE_SIZE = 5_000;
const CAPTURE_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const SIGNUP_METHODS = new Set(["google", "github", "apple", "microsoft", "gitlab", "discord", "linear"]);

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/analytics/reconcile-signups.mjs [--apply] [--since <ISO date>] [--json] [--max-missing <n>]",
      "",
      "Compares Clerk accounts with PostHog `ade_signed_up` events.",
      "",
      "Environment:",
      "  CLERK_SECRET_KEY           Clerk Backend API key of the production instance (sk_live_...).",
      "  POSTHOG_PERSONAL_API_KEY   PostHog personal API key with query:read.",
      "  POSTHOG_PROJECT_TOKEN      Public project token (phc_...), needed only with --apply.",
      `  POSTHOG_PROJECT_ID         Default ${DEFAULT_PROJECT_ID}.`,
      `  POSTHOG_HOST               Query origin, default ${DEFAULT_QUERY_HOST}.`,
      `  POSTHOG_CAPTURE_HOST       Capture origin, default ${DEFAULT_CAPTURE_HOST}.`,
      "",
      "Options:",
      "  --apply            Send the missing sign-ups (same uuid as the webhook, backfilled: true).",
      "  --since <ISO>      Only accounts created (and events timestamped) at or after this time.",
      "  --json             Print the report as JSON.",
      "  --max-missing <n>  A check run exits 1 when more than n sign-ups are missing (default 0).",
      "",
    ].join("\n"),
  );
}

class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { apply: false, json: false, since: null, maxMissing: 0, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--since") {
      const raw = value();
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) throw new UsageError(`--since is not a date: ${raw}`);
      options.since = new Date(ms);
    } else if (arg === "--max-missing") {
      const raw = value();
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 0) throw new UsageError(`--max-missing must be a whole number: ${raw}`);
      options.maxMissing = count;
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return options;
}

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

// Copies of `accountDistinctId` and `signupEventUuid` in
// apps/account-directory/src/signupAnalytics.ts, the source of truth. The
// Worker is TypeScript bundled for Cloudflare, so the two short hashes are
// repeated here rather than imported; change both together.
export function accountDistinctId(userId) {
  return `ade_user_${sha256Hex(`ade-product-analytics-account-v1:${userId}`).slice(0, 32)}`;
}

export function signupEventUuid(userId) {
  const chars = sha256Hex(`ade-signed-up-v1:${userId}`).slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

// Copies of `signupMethod` and `isInternalAccount` in signupAnalytics.ts.
export function signupMethod(user) {
  const provider = user?.external_accounts?.[0]?.provider;
  if (typeof provider === "string") {
    const name = provider.replace(/^oauth_/, "").toLowerCase();
    return SIGNUP_METHODS.has(name) ? name : "other_oauth";
  }
  return "email";
}

export function isInternalAccount(user) {
  const flagged = (metadata) => typeof metadata === "object" && metadata !== null && metadata.ade_internal === true;
  return flagged(user?.private_metadata) || flagged(user?.public_metadata);
}

function requireEnv(name, pattern) {
  const value = process.env[name]?.trim();
  if (!value) throw new UsageError(`${name} is not set`);
  if (pattern && !pattern.test(value)) throw new UsageError(`${name} does not look right (expected ${pattern})`);
  return value;
}

function origin(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`${name} is not a URL`);
  }
  if (url.protocol !== "https:") throw new UsageError(`${name} must be https`);
  return url.origin;
}

async function request(url, init, label) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
        continue;
      }
      throw new Error(`${label}: ${error instanceof Error ? error.name : "request failed"}`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : attempt * 2_000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok) {
      // The body may echo request details; print only the status.
      throw new Error(`${label}: HTTP ${response.status}`);
    }
    return response.json();
  }
}

async function listClerkUsers(secretKey) {
  const users = [];
  for (let offset = 0; ; offset += CLERK_PAGE_SIZE) {
    const url = `${CLERK_API}/users?limit=${CLERK_PAGE_SIZE}&offset=${offset}&order_by=%2Bcreated_at`;
    const page = await request(url, { headers: { Authorization: `Bearer ${secretKey}` } }, "Clerk users");
    if (!Array.isArray(page)) throw new Error("Clerk users: unexpected response");
    for (const user of page) {
      if (typeof user?.id !== "string" || typeof user?.created_at !== "number") continue;
      users.push({
        id: user.id,
        createdAt: user.created_at,
        method: signupMethod(user),
        internal: isInternalAccount(user),
      });
    }
    if (page.length < CLERK_PAGE_SIZE) break;
  }
  return users;
}

async function hogql(env, query) {
  const body = JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "ade-reconcile-signups" });
  const result = await request(
    `${env.queryHost}/api/projects/${env.projectId}/query/`,
    { method: "POST", headers: { Authorization: `Bearer ${env.personalKey}`, "Content-Type": "application/json" }, body },
    "PostHog query",
  );
  if (!Array.isArray(result?.results)) throw new Error("PostHog query: unexpected response");
  return result.results;
}

/** distinct_id → event count, for every distinct id that has `event`, paged so no row limit truncates it. */
async function eventCountsByDistinctId(env, event, since) {
  const counts = new Map();
  const sinceClause = since ? ` AND timestamp >= toDateTime('${since.toISOString().slice(0, 19).replace("T", " ")}', 'UTC')` : "";
  // Keyset pages: PostHog refuses OFFSET on queries made with a personal API key.
  // Distinct ids are `ade_user_<hex>`, so they need no quoting beyond the guard below.
  let after = "";
  for (;;) {
    if (!/^[A-Za-z0-9_-]*$/.test(after)) throw new Error("PostHog query: unexpected distinct id");
    const rows = await hogql(
      env,
      `SELECT distinct_id, count() FROM events WHERE event = '${event}'${sinceClause} AND distinct_id > '${after}' `
        + `GROUP BY distinct_id ORDER BY distinct_id LIMIT ${POSTHOG_PAGE_SIZE}`,
    );
    for (const [distinctId, count] of rows) counts.set(String(distinctId), Number(count));
    if (rows.length < POSTHOG_PAGE_SIZE) break;
    after = String(rows[rows.length - 1][0]);
  }
  return counts;
}

/** The capture body the webhook sends for one account, plus `backfilled`. Keep in step with signupAnalytics.ts. */
export function backfillEvent(user) {
  const signedUpAt = new Date(user.createdAt).toISOString();
  return {
    event: "ade_signed_up",
    distinct_id: accountDistinctId(user.id),
    uuid: signupEventUuid(user.id),
    timestamp: signedUpAt,
    properties: {
      signup_method: user.method,
      client: "account",
      interactive: true,
      is_internal: user.internal,
      backfilled: true,
      $set: { is_internal: user.internal },
      $set_once: { clerk_user_id: user.id, signed_up_at: signedUpAt },
      $geoip_disable: true,
    },
  };
}

async function sendBackfill(env, events) {
  let sent = 0;
  for (let index = 0; index < events.length; index += CAPTURE_BATCH_SIZE) {
    const batch = events.slice(index, index + CAPTURE_BATCH_SIZE);
    const result = await request(
      `${env.captureHost}/batch/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `historical_migration` routes old timestamps through PostHog's import path.
        body: JSON.stringify({ api_key: env.projectToken, historical_migration: true, batch }),
      },
      "PostHog capture",
    );
    if (Array.isArray(result?.quota_limited) && result.quota_limited.length > 0) {
      throw new Error("PostHog capture: quota limited, events dropped");
    }
    sent += batch.length;
  }
  return sent;
}

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

export function buildReport({ users, signups, deletions, since }) {
  const inScope = since ? users.filter((user) => user.createdAt >= since.getTime()) : users;
  const clerkIds = new Set(users.map((user) => accountDistinctId(user.id)));
  const missing = [];
  const byMonth = new Map();
  for (const user of inScope) {
    const month = monthOf(user.createdAt);
    const row = byMonth.get(month) ?? { month, clerk: 0, posthog: 0, missing: 0 };
    row.clerk += 1;
    if (signups.has(accountDistinctId(user.id))) row.posthog += 1;
    else {
      row.missing += 1;
      missing.push(user);
    }
    byMonth.set(month, row);
  }
  // In PostHog but not in Clerk: an account deleted since (it has
  // `ade_account_deleted`, or was deleted before that event existed) or an id
  // that does not match the Clerk hash.
  const extra = [...signups.keys()].filter((distinctId) => !clerkIds.has(distinctId));
  const extraDeleted = extra.filter((distinctId) => deletions.has(distinctId)).length;
  const internal = inScope.filter((user) => user.internal);
  return {
    since: since ? since.toISOString() : null,
    clerkTotal: inScope.length,
    posthogTotal: signups.size,
    matched: inScope.length - missing.length,
    missing: missing.length,
    extra: extra.length,
    extraWithAccountDeleted: extraDeleted,
    duplicates: [...signups.values()].filter((count) => count > 1).length,
    internal: {
      clerk: internal.length,
      missing: missing.filter((user) => user.internal).length,
    },
    excludingInternal: {
      clerk: inScope.length - internal.length,
      missing: missing.filter((user) => !user.internal).length,
    },
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    missingUsers: missing,
  };
}

export function formatReport(report, { applied }) {
  const lines = [
    `## Sign-up reconciliation${report.since ? ` since ${report.since}` : ""}`,
    "",
    "| | Count |",
    "|---|---:|",
    `| Clerk accounts | ${report.clerkTotal} |`,
    `| PostHog accounts with \`ade_signed_up\` | ${report.posthogTotal} |`,
    `| Matched | ${report.matched} |`,
    `| Missing from PostHog | ${report.missing} |`,
    `| Missing, excluding internal | ${report.excludingInternal.missing} |`,
    `| In PostHog, not in Clerk | ${report.extra} (${report.extraWithAccountDeleted} with \`ade_account_deleted\`) |`,
    `| Accounts with more than one \`ade_signed_up\` | ${report.duplicates} |`,
    `| Internal accounts (\`ade_internal\`) | ${report.internal.clerk} (${report.internal.missing} missing) |`,
    `| External accounts | ${report.excludingInternal.clerk} |`,
  ];
  if (applied !== null) lines.push(`| Backfilled this run | ${applied} |`);
  lines.push("", "| Month (UTC) | Clerk | PostHog | Missing |", "|---|---:|---:|---:|");
  for (const row of report.byMonth) lines.push(`| ${row.month} | ${row.clerk} | ${row.posthog} | ${row.missing} |`);
  lines.push("");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  const env = {
    clerkKey: requireEnv("CLERK_SECRET_KEY", /^sk_(live|test)_\S+$/),
    personalKey: requireEnv("POSTHOG_PERSONAL_API_KEY"),
    projectToken: options.apply ? requireEnv("POSTHOG_PROJECT_TOKEN", /^phc_[A-Za-z0-9_-]{8,}$/) : null,
    projectId: process.env.POSTHOG_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID,
    queryHost: origin(process.env.POSTHOG_HOST?.trim() || DEFAULT_QUERY_HOST, "POSTHOG_HOST"),
    captureHost: origin(process.env.POSTHOG_CAPTURE_HOST?.trim() || DEFAULT_CAPTURE_HOST, "POSTHOG_CAPTURE_HOST"),
  };
  if (!/^\d+$/.test(env.projectId)) throw new UsageError("POSTHOG_PROJECT_ID must be numeric");

  const users = await listClerkUsers(env.clerkKey);
  const [signups, deletions] = await Promise.all([
    eventCountsByDistinctId(env, "ade_signed_up", options.since),
    eventCountsByDistinctId(env, "ade_account_deleted", null),
  ]);
  const report = buildReport({ users, signups, deletions, since: options.since });

  let applied = null;
  if (options.apply) applied = await sendBackfill(env, report.missingUsers.map(backfillEvent));

  const { missingUsers, ...printable } = report;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ...printable,
      applied,
      // Hashed ids only, never the Clerk user id.
      missingDistinctIds: missingUsers.map((user) => accountDistinctId(user.id)),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report, { applied }));
  }
  if (!options.apply && report.missing > options.maxMissing) {
    process.stderr.write(`${report.missing} sign-up(s) missing from PostHog (allowed: ${options.maxMissing}).\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof UsageError ? "Usage error" : "Failed"}: ${error.message}\n`);
      process.exit(2);
    },
  );
}
