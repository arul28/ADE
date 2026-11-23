import { captureCloudSafety, type CloudWaitUntil } from "./analytics";
import { cancelAccountSubscription, savedCardFingerprints } from "./billing";
import { blockedUsersAmong, forgetNotBlocked, isCloudBlocked } from "./blocks";
import { constantTimeEqual } from "../githubApp/seal";
import { sha256Hex } from "../sinkUtils";
import { fail, json, readJson } from "./http";
import { OWNER_ACCOUNT_PATH, OWNER_SETTINGS_PATH, handleOwnerAccount, handleOwnerSettings } from "./ownerAccounts";
import { OWNER_PHONE_BETA_PATH, handleOwnerPhoneBeta } from "./phoneBeta";
import { stopAccountPhones } from "./phones";
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
 * - `POST /cloud/owner/phone-beta` `{ email? | userId?, enabled? }`: the ADE Cloud iPhone's beta list (`phoneBeta.ts`)
 * - `POST /cloud/owner/account` and `/cloud/owner/settings`: the account test tool and the instant switches (`ownerAccounts.ts`)
 */

const OWNER_BLOCK_PATH = "/cloud/owner/block";
const OWNER_UNBLOCK_PATH = "/cloud/owner/unblock";
/** Computers of blocked accounts the minute tick stops at most, so one tick stays short. */
const TICK_ENFORCE_LIMIT = 10;
/** A stopped computer whose network policy didn't land is tried again this often, not every minute. */
const STOPPED_DENY_RETRY_MS = 60 * 60_000;
const MAX_REASON = 200;

type BlockSummary = { computers: number; stopped: number; failed: number; subscriptionCancelled: boolean; alreadyBlocked: boolean };

/**
 * Cuts one computer off the internet, then stops it. A pending reservation
 * (no provider computer yet) is left to the create's own check. Throws when
 * the stop fails; the tick tries again a minute later. A policy that didn't
 * land leaves `network_denied_at` empty, so the tick tries that again too.
 */
export async function enforceBlockOnComputer(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, now: number): Promise<void> {
  if (isPendingId(computer.instance_id)) return;
  // Read now, not from the caller's list: an unblock since then must not be undone.
  if (!(await isCloudBlocked(env, computer.user_id))) return;
  if (computer.network_denied_at == null) {
    let denied = false;
    try {
      await provider.setNetworkPolicy(computer.instance_id, "deny-all");
      denied = true;
      // An unblock that landed while the deny was on its way: the internet goes back on.
      if (!(await isCloudBlocked(env, computer.user_id))) {
        await reopenComputer(env, provider, computer, now);
        return;
      }
    } catch (error) {
      // `try_again`: the policy is saved and lands within two minutes. Anything else: the stop below still runs.
      if (error instanceof CloudProviderError && error.code === TRY_AGAIN_CODE) denied = true;
      else reportCloudFailure("cloud.block_network_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
    // A failed note of the try must not skip the stop below.
    try {
      await env.DB.prepare("update cloud_computers set network_deny_tried_at = ?, network_denied_at = ? where instance_id = ?")
        .bind(now, denied ? now : null, computer.instance_id).run();
    } catch (error) {
      reportCloudFailure("cloud.block_network_note_failed", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : String(error) });
    }
    computer.network_deny_tried_at = now;
    if (denied) computer.network_denied_at = now;
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

/**
 * The minute tick's sweep, a few a tick: computers of blocked accounts that
 * aren't stopped first, then stopped ones whose network policy didn't land
 * (each tried again at most every `STOPPED_DENY_RETRY_MS`).
 */
export async function enforceBlocksInTick(env: CloudEnv, provider: CloudProvider, computers: ComputerRow[], now: number): Promise<void> {
  const real = computers.filter((computer) => !isPendingId(computer.instance_id));
  const blocked = await blockedUsersAmong(env, real.map((computer) => computer.user_id));
  const retryDue = (computer: ComputerRow) => computer.network_deny_tried_at == null || now - computer.network_deny_tried_at >= STOPPED_DENY_RETRY_MS;
  const mine = real.filter((computer) => blocked.has(computer.user_id));
  const running = mine.filter((computer) => computer.status !== "stopped");
  const stoppedOpen = mine.filter((computer) => computer.status === "stopped" && computer.network_denied_at == null && retryDue(computer));
  // Longest since its last try first, so computers that keep failing don't hold the others' turn.
  const lastTry = (computer: ComputerRow) => computer.network_deny_tried_at ?? 0;
  const due = [...running.sort((a, b) => lastTry(a) - lastTry(b)), ...stoppedOpen.sort((a, b) => lastTry(a) - lastTry(b))];
  for (const computer of due.slice(0, TICK_ENFORCE_LIMIT)) {
    try {
      await enforceBlockOnComputer(env, provider, computer, now);
    } catch (error) {
      reportCloudFailure("cloud.block_tick_stop_failed", { userId: computer.user_id, instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      await env.DB.prepare("update cloud_computers set network_deny_tried_at = ? where instance_id = ?").bind(now, computer.instance_id).run()
        .catch((noteError: unknown) => reportCloudFailure("cloud.block_network_note_failed", { instanceId: computer.instance_id, message: noteError instanceof Error ? noteError.message : String(noteError) }));
    }
  }
  // An unblock whose `allow-all` didn't land: its computers still carry the deny mark, so they get the internet back here (hourly).
  const reopen = real.filter((computer) => !blocked.has(computer.user_id) && (computer.network_denied_at != null || computer.network_deny_tried_at != null) && retryDue(computer));
  for (const computer of reopen.slice(0, TICK_ENFORCE_LIMIT)) {
    await reopenComputer(env, provider, computer, now);
  }
}

/**
 * Gives an unblocked account's computer the internet back and clears its deny
 * marks. A failure keeps the marks (with the try's time), so the tick tries
 * again an hour later. Never throws. True when the policy is back.
 */
async function reopenComputer(env: CloudEnv, provider: CloudProvider, computer: ComputerRow, now: number): Promise<boolean> {
  try {
    // Read now: a block that came back since the caller looked keeps the internet off.
    if (await isCloudBlocked(env, computer.user_id)) return false;
    try {
      await provider.setNetworkPolicy(computer.instance_id, "allow-all");
    } catch (error) {
      // `try_again`: the policy is saved and lands within two minutes, as with the block's deny.
      if (!(error instanceof CloudProviderError && error.code === TRY_AGAIN_CODE)) {
        reportCloudFailure("cloud.unblock_network_failed", { userId: computer.user_id, instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
        await env.DB.prepare("update cloud_computers set network_deny_tried_at = ? where instance_id = ?").bind(now, computer.instance_id).run();
        return false;
      }
    }
    await env.DB.prepare("update cloud_computers set network_denied_at = null, network_deny_tried_at = null where instance_id = ?").bind(computer.instance_id).run();
    computer.network_denied_at = null;
    computer.network_deny_tried_at = null;
    return true;
  } catch (error) {
    reportCloudFailure("cloud.unblock_network_note_failed", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : String(error) });
    return false;
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

/** One block list row: an account, a GitHub account, a card, or several of them. */
function blockRowStatement(env: CloudEnv, row: { userId: string | null; githubUserId: number | null; card: string | null; reason: string; now: number }): D1PreparedStatement {
  return env.DB.prepare("insert into cloud_blocks (user_id, github_user_id, card_fingerprint, reason, created_at) values (?, ?, ?, ?, ?)")
    .bind(row.userId, row.githubUserId, row.card, row.reason, row.now);
}

/**
 * Blocks an account (see the top of this file). Safe to repeat: a second
 * block adds no rows and stops whatever still runs. A provider failure on one
 * computer is counted and left to the tick. The block rows, the abuse row and
 * the safety event are written before Stripe is called, so a Stripe failure
 * loses none of them; it throws, and the owner can send the block again.
 */
export async function blockAccount(env: CloudEnv, provider: CloudProvider | null, userId: string, reason: string, now: number, waitUntil?: CloudWaitUntil): Promise<BlockSummary> {
  const alreadyBlocked = await isCloudBlocked(env, userId);
  if (!alreadyBlocked) {
    const { githubUserId, cards } = await identityOf(env, userId);
    await env.DB.batch([
      blockRowStatement(env, { userId, githubUserId, card: cards[0] ?? null, reason, now }),
      ...cards.slice(1).map((card) => blockRowStatement(env, { userId, githubUserId: null, card, reason, now })),
    ]);
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
  if (provider) {
    for (const computer of computers) {
      try {
        await enforceBlockOnComputer(env, provider, computer, now);
        stopped += 1;
      } catch (error) {
        failed += 1;
        reportCloudFailure("cloud.block_stop_failed", { userId, instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      }
    }
  }

  // Its ADE Cloud iPhone stops too: a phone token still drives it at NoMac otherwise.
  await stopAccountPhones(env, userId, now, "account_blocked").catch((error: unknown) => {
    reportCloudFailure("cloud.block_phone_stop_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
  });

  const account = await env.DB.prepare("select user_id, stripe_subscription_id from cloud_accounts where user_id = ?")
    .bind(userId).first<Pick<AccountRow, "user_id" | "stripe_subscription_id">>();
  const subscriptionCancelled = Boolean(account?.stripe_subscription_id);
  if (!alreadyBlocked) {
    await reportCloudAbuse(env, "account_blocked", userId, { reason, computers: computers.length, stopped, failed, subscriptionCancelled }, now);
    captureCloudSafety(env, waitUntil, userId, "blocked", "block", now);
  }
  // Last: a Stripe failure throws, and the block sent again only retries the cancel.
  if (account) await cancelAccountSubscription(env, account, now, "blocked_account");
  return { computers: computers.length, stopped, failed, subscriptionCancelled, alreadyBlocked };
}

/**
 * Takes the account off the block list. Its computers get the internet back
 * but stay stopped (the person starts them). A cancelled plan stays cancelled.
 */
export async function unblockAccount(env: CloudEnv, provider: CloudProvider | null, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<{ removed: number; reopened: number }> {
  const removed = await env.DB.prepare("delete from cloud_blocks where user_id = ?").bind(userId).run();
  let reopened = 0;
  if (provider) {
    // One that fails keeps its deny marks: the minute tick tries it again.
    for (const computer of (await listComputers(env, userId)).filter((row) => !isPendingId(row.instance_id))) {
      if (await reopenComputer(env, provider, computer, now)) reopened += 1;
    }
  }
  logCloud("cloud.account_unblocked", { userId, removed: removed.meta.changes ?? 0, reopened });
  captureCloudSafety(env, waitUntil, userId, "unblocked", "unblock", now);
  return { removed: removed.meta.changes ?? 0, reopened };
}

/* ---- The owner routes ---- */

export const isCloudOwnerRequest = (path: string): boolean =>
  path === OWNER_BLOCK_PATH || path === OWNER_UNBLOCK_PATH || path === OWNER_PHONE_BETA_PATH || path === OWNER_ACCOUNT_PATH || path === OWNER_SETTINGS_PATH;

/** Compares the bearer with `CLOUD_OWNER_TOKEN` in constant time (both hashed first, so length leaks nothing). */
async function ownerTokenMatches(env: Pick<CloudEnv, "CLOUD_OWNER_TOKEN">, request: Request): Promise<boolean | null> {
  const expected = env.CLOUD_OWNER_TOKEN?.trim();
  if (!expected) return null;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return false;
  const [left, right] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  return constantTimeEqual(left, right);
}

/**
 * Takes one GitHub account or card off the block list. A blocked account's
 * own row only loses that column (the account stays blocked); a row that
 * blocked identities alone goes once it names none. How many rows changed.
 */
async function unblockIdentity(env: CloudEnv, column: "github_user_id" | "card_fingerprint", value: number | string): Promise<number> {
  const [cleared] = await env.DB.batch([
    env.DB.prepare(`update cloud_blocks set ${column} = null where ${column} = ?`).bind(value),
    env.DB.prepare("delete from cloud_blocks where user_id is null and github_user_id is null and card_fingerprint is null"),
  ]);
  return cleared?.meta.changes ?? 0;
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
  // The ADE Cloud iPhone's beta list (`phoneBeta.ts`).
  if (path === OWNER_PHONE_BETA_PATH) return handleOwnerPhoneBeta(env, body, deps.now);
  // The account test tool and the instant switches (`ownerAccounts.ts`).
  if (path === OWNER_ACCOUNT_PATH) return handleOwnerAccount(env, body, deps.now);
  if (path === OWNER_SETTINGS_PATH) return handleOwnerSettings(env, body, deps.now);
  const userId = textField(body.userId, 200);
  const githubUserId = typeof body.githubUserId === "number" && Number.isSafeInteger(body.githubUserId) && body.githubUserId > 0 ? body.githubUserId : null;
  const cardFingerprint = textField(body.cardFingerprint, 100);
  if (!userId && githubUserId == null && !cardFingerprint) return fail("bad_request", "Name a userId, githubUserId or cardFingerprint.", 400);
  const { provider, now, waitUntil } = deps;

  if (path === OWNER_UNBLOCK_PATH) {
    const account = userId ? await unblockAccount(env, provider, userId, now, waitUntil) : null;
    let identities = 0;
    if (githubUserId != null) identities += await unblockIdentity(env, "github_user_id", githubUserId);
    if (cardFingerprint) identities += await unblockIdentity(env, "card_fingerprint", cardFingerprint);
    return json({ ok: true, account, identitiesRemoved: identities });
  }

  const reason = textField(body.reason, MAX_REASON) ?? "owner";
  const account = userId ? await blockAccount(env, provider, userId, reason, now, waitUntil) : null;
  // A GitHub account or card alone: refused on any account that brings it from now on.
  if (githubUserId != null || cardFingerprint) {
    await blockRowStatement(env, { userId: null, githubUserId, card: cardFingerprint, reason, now }).run();
    await reportCloudAbuse(env, "identity_blocked", null, { github: githubUserId != null, card: cardFingerprint != null, reason }, now);
  }
  return json({ ok: true, account });
}
