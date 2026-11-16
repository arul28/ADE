import { captureCloudSafety, type CloudWaitUntil } from "./analytics";
import { cancelAccountSubscription, savedCardFingerprints } from "./billing";
import { blockedUsersAmong, forgetNotBlocked, isCloudBlocked } from "./blocks";
import { fail, json, readJson } from "./http";
import { CloudProviderError, TRY_AGAIN_CODE, type CloudProvider } from "./provider";
import {
  isPendingId,
  listComputers,
  logCloud,
  reportCloudAbuse,
  reportCloudFailure,
  statusChangeStatements,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * The owner's block and unblock (README, "ADE Cloud safety").
 *
 * A block cuts each of the account's computers off the internet (the
 * provider's `deny-all` network policy, DNS included) and then stops it (not
 * sleep: a stopped computer doesn't wake on a request), deletes its timed
 * wakes, and cancels its Stripe subscription at once with no proration
 * credit. Its GitHub account and saved cards go on the block list with it, so
 * they can't come back on a new account. Every `/cloud` route then refuses the
 * account (`routes.ts`), and the cron jobs leave it alone.
 *
 * A computer made while the block lands (a launch mid-create) is caught twice:
 * the create checks the block when its row becomes a real computer, and the
 * minute tick stops any computer of a blocked account that isn't stopped.
 *
 * The owner routes take `Authorization: Bearer <CLOUD_OWNER_TOKEN>`:
 * - `POST /cloud/owner/block`   `{ userId?, githubUserId?, cardFingerprint?, reason }`
 * - `POST /cloud/owner/unblock` `{ userId?, githubUserId?, cardFingerprint? }`
 */

const OWNER_BLOCK_PATH = "/cloud/owner/block";
const OWNER_UNBLOCK_PATH = "/cloud/owner/unblock";
/** Computers of blocked accounts the minute tick stops at most, so one tick stays short. */
const TICK_ENFORCE_LIMIT = 10;
const MAX_REASON = 200;

export type BlockSummary = { computers: number; stopped: number; failed: number; subscriptionCancelled: boolean; alreadyBlocked: boolean };

/**
 * Cuts one computer off the internet, then stops it. A pending reservation
 * (no provider computer yet) is left to the create's own check. Throws when
 * the provider refuses; the tick tries again a minute later.
 */
export async function enforceBlockOnComputer(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, now: number): Promise<void> {
  if (isPendingId(computer.instance_id)) return;
  try {
    await provider.setNetworkPolicy(computer.instance_id, "deny-all");
  } catch (error) {
    // `try_again`: the policy is saved and lands within two minutes. Anything else: the stop below still runs.
    if (!(error instanceof CloudProviderError && error.code === TRY_AGAIN_CODE)) {
      reportCloudFailure("cloud.block_network_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }
  if (computer.status === "stopped") return;
  let status: string;
  try {
    status = await provider.stopInstance(computer.instance_id);
  } catch (error) {
    // Gone already: nothing left to stop.
    if (error instanceof CloudProviderError && error.status === 404) return;
    throw error;
  }
  const statements = statusChangeStatements(env, computer, status, now, "blocked");
  if (statements.length) await env.DB.batch(statements);
  logCloud("cloud.block_computer_stopped", { userId: computer.user_id, instanceId: computer.instance_id, status });
}

/**
 * The check a create runs once its row is a real computer: a block that
 * landed while the provider made it stops it now. Never throws (the tick
 * catches what this misses).
 */
export async function enforceBlockAfterCreate(env: CloudEnv, provider: CloudProvider, userId: string, instanceId: string, now: number): Promise<void> {
  try {
    if (!(await isCloudBlocked(env, userId))) return;
    const computer = await env.DB.prepare("select * from cloud_computers where instance_id = ? and deleted_at is null").bind(instanceId).first<ComputerRow>();
    if (computer) await enforceBlockOnComputer(env, provider, computer, now);
    await reportCloudAbuse(env, "blocked_computer_made", userId, { instanceId }, now);
  } catch (error) {
    reportCloudFailure("cloud.block_after_create_failed", { userId, instanceId, message: error instanceof Error ? error.message : "unknown" });
  }
}

/** The minute tick's sweep: computers of blocked accounts that aren't stopped, a few a tick. */
export async function enforceBlocksInTick(env: CloudEnv, provider: CloudProvider, computers: ComputerRow[], now: number): Promise<void> {
  const blocked = await blockedUsersAmong(env, computers.map((computer) => computer.user_id));
  if (blocked.size === 0) return;
  const due = computers.filter((computer) => blocked.has(computer.user_id) && !isPendingId(computer.instance_id) && computer.status !== "stopped");
  for (const computer of due.slice(0, TICK_ENFORCE_LIMIT)) {
    try {
      await enforceBlockOnComputer(env, provider, computer, now);
    } catch (error) {
      reportCloudFailure("cloud.block_tick_stop_failed", { userId: computer.user_id, instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }
}

/**
 * The account's GitHub id (its grant, else its free-plan claim) and its cards:
 * the ones that unlocked its free hours and the ones saved on its Stripe
 * customer (best effort: Stripe failing never stops a block).
 */
async function identityOf(env: CloudEnv, userId: string): Promise<{ githubUserId: number | null; cards: string[] }> {
  const [github, claimed, customer] = await Promise.all([
    env.DB.prepare(`
      select coalesce((select github_user_id from github_app_grants where user_id = ?), (select github_user_id from cloud_free_github_claims where user_id = ?)) as github_user_id
    `).bind(userId, userId).first<{ github_user_id: number | null }>(),
    env.DB.prepare("select card_fingerprint from cloud_free_card_claims where user_id = ?").bind(userId).all<{ card_fingerprint: string }>(),
    env.DB.prepare("select stripe_customer_id from cloud_accounts where user_id = ?").bind(userId).first<{ stripe_customer_id: string | null }>(),
  ]);
  const saved = customer?.stripe_customer_id
    ? await savedCardFingerprints(env, customer.stripe_customer_id).catch((error: unknown) => {
      reportCloudFailure("cloud.block_cards_read_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
      return [] as string[];
    })
    : [];
  const cards = [...new Set([...(claimed.results ?? []).map((row) => row.card_fingerprint), ...saved])];
  return { githubUserId: github?.github_user_id ?? null, cards };
}

/**
 * Blocks an account (see the top of this file). Safe to repeat: a second
 * block adds no rows and stops whatever still runs. A provider failure on one
 * computer is counted and left to the tick; a Stripe failure throws after the
 * computers are stopped, so the owner can send the block again.
 */
export async function blockAccount(env: CloudEnv, provider: CloudProvider | null, userId: string, reason: string, now: number, waitUntil?: CloudWaitUntil): Promise<BlockSummary> {
  const alreadyBlocked = await isCloudBlocked(env, userId);
  if (!alreadyBlocked) {
    const { githubUserId, cards } = await identityOf(env, userId);
    const rows = [
      env.DB.prepare("insert into cloud_blocks (user_id, github_user_id, card_fingerprint, reason, created_at) values (?, ?, ?, ?, ?)")
        .bind(userId, githubUserId, cards[0] ?? null, reason, now),
      ...cards.slice(1).map((card) => env.DB.prepare("insert into cloud_blocks (user_id, github_user_id, card_fingerprint, reason, created_at) values (?, null, ?, ?, ?)")
        .bind(userId, card, reason, now)),
    ];
    await env.DB.batch(rows);
  }
  forgetNotBlocked(userId);
  // Timed wakes would only knock on stopped computers; they go.
  await env.DB.prepare("delete from cloud_wakes where user_id = ?").bind(userId).run();

  const computers = (await listComputers(env, userId)).filter((computer) => !isPendingId(computer.instance_id));
  let stopped = 0;
  let failed = 0;
  if (computers.length && !provider) {
    failed = computers.length;
    reportCloudFailure("cloud.block_no_provider", { userId });
  }
  for (const computer of provider ? computers : []) {
    try {
      await enforceBlockOnComputer(env, provider!, computer, now);
      stopped += 1;
    } catch (error) {
      failed += 1;
      reportCloudFailure("cloud.block_stop_failed", { userId, instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }

  const account = await env.DB.prepare("select user_id, stripe_subscription_id from cloud_accounts where user_id = ?")
    .bind(userId).first<Pick<AccountRow, "user_id" | "stripe_subscription_id">>();
  const subscriptionCancelled = Boolean(account?.stripe_subscription_id);
  if (account) await cancelAccountSubscription(env, account, now, "blocked_account");

  if (!alreadyBlocked) {
    await reportCloudAbuse(env, "account_blocked", userId, { reason, computers: computers.length, stopped, failed, subscriptionCancelled }, now);
    captureCloudSafety(env, waitUntil, userId, "blocked", "block", now);
  }
  return { computers: computers.length, stopped, failed, subscriptionCancelled, alreadyBlocked };
}

/**
 * Takes the account off the block list. Its computers get the internet back
 * but stay stopped (the person starts them). A cancelled plan stays cancelled.
 */
export async function unblockAccount(env: CloudEnv, provider: CloudProvider | null, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<{ removed: number; reopened: number }> {
  const removed = await env.DB.prepare("delete from cloud_blocks where user_id = ?").bind(userId).run();
  let reopened = 0;
  for (const computer of provider ? (await listComputers(env, userId)).filter((row) => !isPendingId(row.instance_id)) : []) {
    try {
      await provider!.setNetworkPolicy(computer.instance_id, "allow-all");
      reopened += 1;
    } catch (error) {
      reportCloudFailure("cloud.unblock_network_failed", { userId, instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }
  logCloud("cloud.account_unblocked", { userId, removed: removed.meta.changes ?? 0, reopened });
  captureCloudSafety(env, waitUntil, userId, "unblocked", "unblock", now);
  return { removed: removed.meta.changes ?? 0, reopened };
}

/* ---- The owner routes ---- */

export const isCloudOwnerRequest = (path: string): boolean => path === OWNER_BLOCK_PATH || path === OWNER_UNBLOCK_PATH;

/** Compares the bearer with `CLOUD_OWNER_TOKEN` in constant time (both hashed first, so length leaks nothing). */
async function ownerTokenMatches(env: Pick<CloudEnv, "CLOUD_OWNER_TOKEN">, request: Request): Promise<boolean | null> {
  const expected = env.CLOUD_OWNER_TOKEN?.trim();
  if (!expected) return null;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

const textField = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null;

/**
 * `POST /cloud/owner/block` and `/cloud/owner/unblock`. Matched before the
 * account sign-in (the owner's token is the proof), so an account bearer
 * can never reach them. 503 while `CLOUD_OWNER_TOKEN` is unset.
 */
export async function handleCloudOwnerRequest(request: Request, env: CloudEnv, path: string, deps: { provider: CloudProvider | null; now: number; waitUntil?: CloudWaitUntil }): Promise<Response> {
  if (request.method !== "POST") return fail("not_found", "ADE Cloud has no such route.", 404);
  const allowed = await ownerTokenMatches(env, request);
  if (allowed == null) return fail("unavailable", "The owner routes aren't set up.", 503);
  if (!allowed) {
    logCloud("cloud.owner_route_refused", { path });
    return fail("unauthorized", "That owner token isn't valid.", 401);
  }
  const body = await readJson(request);
  if (!body) return fail("bad_request", "That request could not be read.", 400);
  const userId = textField(body.userId, 200);
  const githubUserId = typeof body.githubUserId === "number" && Number.isSafeInteger(body.githubUserId) && body.githubUserId > 0 ? body.githubUserId : null;
  const cardFingerprint = textField(body.cardFingerprint, 100);
  if (!userId && githubUserId == null && !cardFingerprint) return fail("bad_request", "Name a userId, githubUserId or cardFingerprint.", 400);
  const { provider, now, waitUntil } = deps;

  if (path === OWNER_UNBLOCK_PATH) {
    const account = userId ? await unblockAccount(env, provider, userId, now, waitUntil) : null;
    let identities = 0;
    if (githubUserId != null) identities += (await env.DB.prepare("delete from cloud_blocks where github_user_id = ?").bind(githubUserId).run()).meta.changes ?? 0;
    if (cardFingerprint) identities += (await env.DB.prepare("delete from cloud_blocks where card_fingerprint = ?").bind(cardFingerprint).run()).meta.changes ?? 0;
    return json({ ok: true, account, identitiesRemoved: identities });
  }

  const reason = textField(body.reason, MAX_REASON) ?? "owner";
  const account = userId ? await blockAccount(env, provider, userId, reason, now, waitUntil) : null;
  // A GitHub account or card alone: refused on any account that brings it from now on.
  if (githubUserId != null || cardFingerprint) {
    await env.DB.prepare("insert into cloud_blocks (user_id, github_user_id, card_fingerprint, reason, created_at) values (null, ?, ?, ?, ?)")
      .bind(githubUserId, cardFingerprint, reason, now).run();
    await reportCloudAbuse(env, "identity_blocked", null, { github: githubUserId != null, card: cardFingerprint != null, reason }, now);
  }
  return json({ ok: true, account });
}
