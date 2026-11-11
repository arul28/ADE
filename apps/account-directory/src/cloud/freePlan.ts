import { captureCloudFreePlan, type CloudWaitUntil } from "./analytics";
import {
  CLOUD_COMPUTER_HEADER,
  CLOUD_COMPUTER_PLATFORM_HEADER,
  CLOUD_COMPUTER_UNREADABLE,
  CLOUD_FREE_PLAN_REFUSED_SENTENCE,
  type CloudFreePlan,
} from "./contract";
import { FREE_INCLUDED_MILLI } from "./plans";
import { accountRules, logCloud, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

/**
 * One free plan per physical computer (README, "Referrals and the free plan").
 *
 * The desktop and a machine's brain send `x-ade-computer`: SHA-256 of a fixed
 * ADE-wide salt and the OS machine id (`IOPlatformUUID`, `MachineGuid`,
 * `/etc/machine-id`), the same for every account on that computer and
 * unrelated to the per-account `hardware_id` of migration 0008. The server
 * keys it once more with an HMAC derived from `CLOUD_CHAT_MASTER_KEY`, so the
 * stored value can't be matched against anything outside this Worker, and
 * keeps only that.
 *
 * The free plan is settled per account, not per chat or computer:
 * - The first time an account on the free plan's rules USES ADE Cloud from a
 *   computer (a create, a copy, a wake), that computer is claimed for it. A
 *   read (the dashboard) never claims, so a family member who only opened the
 *   page doesn't take the shared computer's free plan.
 * - An account with no claim that is seen on a computer already claimed by
 *   another account is refused: its free plan has 0 hours everywhere (CLI,
 *   phone, MCP) until it claims a computer of its own. Paid plans, earned
 *   hours and extra hours are untouched. Settled on any request carrying the
 *   header, reads included, so the dashboard says why before anything starts.
 * - An account holds at most one claim. Once it has one, using any other
 *   computer (a shared family one) changes nothing for it.
 * - Both keys of `cloud_free_plan_claims` are unique, so two accounts claiming
 *   one computer at once, or one account claiming two, settle to one claim.
 *
 * Edge cases, each logged: a reinstall is the same OS id, so the same claim; a
 * computer signing back into the account that holds its claim is that claim; a
 * computer that can't read its id sends `unreadable` and claims nothing
 * (logged, counted); an account used only from the phone or MCP never sends
 * the header and keeps the free plan, unclaimed, until a computer of its own
 * is seen (counted as `unclaimed_use`); a VM has its own OS id and is its own
 * computer (accepted); an ADE Cloud computer never sends the header.
 */

export type CloudComputerSignal =
  | { kind: "id"; clientHash: string; platform: string | null }
  | { kind: "unreadable"; platform: string | null }
  | null;

const CLIENT_HASH = /^[0-9a-f]{64}$/;
const PLATFORMS = new Set(["darwin", "win32", "linux"]);
/** The HKDF label that turns the existing Worker secret into this HMAC's key: no new secret. */
const COMPUTER_KEY_LABEL = "ade-cloud-free-plan-computer-hmac-v1";
/** Development only (no `CLOUD_CHAT_MASTER_KEY`): stored values are still keyed, just not secretly. */
const DEV_COMPUTER_KEY = "ade-cloud-free-plan-dev-key";
/** Accounts seen on one computer past which a refusal is reported as abuse-shaped. */
const MANY_ACCOUNTS_ON_ONE_COMPUTER = 4;

const encoder = new TextEncoder();

/** What the request says about the computer it came from; null when it says nothing (phone, MCP, an ADE Cloud computer). */
export function readComputerSignal(request: Request): CloudComputerSignal {
  const raw = request.headers.get(CLOUD_COMPUTER_HEADER)?.trim().toLowerCase();
  if (!raw) return null;
  const platformHeader = request.headers.get(CLOUD_COMPUTER_PLATFORM_HEADER)?.trim().toLowerCase() ?? "";
  const platform = PLATFORMS.has(platformHeader) ? platformHeader : null;
  if (raw === CLOUD_COMPUTER_UNREADABLE) return { kind: "unreadable", platform };
  return CLIENT_HASH.test(raw) ? { kind: "id", clientHash: raw, platform } : null;
}

let keyCache: { secret: string; key: Promise<CryptoKey> } | null = null;
let devKeyLogged = false;

function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(secret);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.length >= 16) return bytes;
  } catch {
    // Not base64: the text itself is the key material.
  }
  return encoder.encode(secret) as Uint8Array<ArrayBuffer>;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", decodeSecret(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(COMPUTER_KEY_LABEL) },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** The server's key for computer ids, from `CLOUD_CHAT_MASTER_KEY` (a dev constant without it). */
function computerKey(env: Pick<CloudEnv, "CLOUD_CHAT_MASTER_KEY">): Promise<CryptoKey> {
  let secret = env.CLOUD_CHAT_MASTER_KEY?.trim() ?? "";
  if (!secret) {
    if (!devKeyLogged) {
      devKeyLogged = true;
      logCloud("cloud.free_plan.dev_key", { note: "CLOUD_CHAT_MASTER_KEY unset: computer ids are keyed with the development constant" });
    }
    secret = DEV_COMPUTER_KEY;
  }
  if (keyCache?.secret !== secret) keyCache = { secret, key: deriveKey(secret) };
  return keyCache.key;
}

/** The stored id of a computer: the HMAC of the client's hash. */
export async function serverComputerHash(env: Pick<CloudEnv, "CLOUD_CHAT_MASTER_KEY">, clientHash: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await computerKey(env), encoder.encode(clientHash));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ClaimView = { seen: number | null; holder: string | null; own: string | null };

async function readClaims(env: CloudEnv, userId: string, hash: string): Promise<ClaimView> {
  const row = await env.DB.prepare(`
    select
      (select 1 from cloud_account_computers where user_id = ? and computer_hash = ?) as seen,
      (select user_id from cloud_free_plan_claims where computer_hash = ?) as holder,
      (select computer_hash from cloud_free_plan_claims where user_id = ?) as own
  `).bind(userId, hash, hash, userId).first<ClaimView>();
  return row ?? { seen: null, holder: null, own: null };
}

/** SQL: the account runs on the free plan's rules (free, or a paid plan whose payment failed). */
const FREE_RULES_SQL = "(plan = 'free' or coalesce(stripe_status, '') = 'past_due')";

type Ctx = { now: number; waitUntil: CloudWaitUntil };

/** Refuses the free plan to `userId`: its hours go to 0 now while it runs on the free plan's rules. */
async function refuse(env: CloudEnv, account: AccountRow, hash: string, platform: string | null, { now, waitUntil }: Ctx): Promise<AccountRow> {
  const result = await env.DB.prepare(`
    update cloud_accounts set free_refused_at = ?, included_milli = case when ${FREE_RULES_SQL} then 0 else included_milli end, updated_at = ?
    where user_id = ? and free_refused_at is null
  `).bind(now, now, account.user_id).run();
  if ((result.meta.changes ?? 0) === 1) {
    logCloud("cloud.free_plan.refused", { userId: account.user_id, platform });
    captureCloudFreePlan(env, waitUntil, account.user_id, "refused", platform, now);
    const seen = await env.DB.prepare("select count(*) as accounts from cloud_account_computers where computer_hash = ?").bind(hash).first<{ accounts: number }>();
    if ((seen?.accounts ?? 0) >= MANY_ACCOUNTS_ON_ONE_COMPUTER) {
      // Abuse-shaped: many accounts made on one computer to get free hours again.
      reportCloudFailure("cloud.free_plan.many_accounts_one_computer", { userId: account.user_id, accounts: seen?.accounts }, "cloud-free-plan");
    }
  }
  return {
    ...account,
    free_refused_at: account.free_refused_at ?? now,
    included_milli: accountRules(account) === "free" ? 0 : account.included_milli,
  };
}

/** An account refused before now holds a computer of its own: the free plan's hours come back for this period. */
async function restore(env: CloudEnv, account: AccountRow, platform: string | null, { now, waitUntil }: Ctx): Promise<AccountRow> {
  await env.DB.prepare(`
    update cloud_accounts set free_refused_at = null, included_milli = case when ${FREE_RULES_SQL} then ? else included_milli end,
      warned_zero_at = null, hours_restored_at = case when warned_zero_at is not null then ? else hours_restored_at end, updated_at = ?
    where user_id = ? and free_refused_at is not null
  `).bind(FREE_INCLUDED_MILLI, now, now, account.user_id).run();
  logCloud("cloud.free_plan.restored", { userId: account.user_id, platform });
  captureCloudFreePlan(env, waitUntil, account.user_id, "restored", platform, now);
  return { ...account, free_refused_at: null, included_milli: accountRules(account) === "free" ? FREE_INCLUDED_MILLI : account.included_milli };
}

/**
 * Settles the free plan for the computer a request came from (see the top of
 * this file). `use` is a create, copy or wake; `read` is anything else. Runs
 * before the request's own hours check, so a claim or refusal counts at once.
 * Returns the account as it is after. Never throws: a failure here is logged
 * and the request goes on as it would have.
 */
export async function settleFreePlanComputer(
  env: CloudEnv,
  account: AccountRow,
  signal: CloudComputerSignal,
  moment: "read" | "use",
  ctx: Ctx,
): Promise<AccountRow> {
  try {
    return await settle(env, account, signal, moment, ctx);
  } catch (error) {
    reportCloudFailure("cloud.free_plan.settle_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" }, "cloud-free-plan");
    return account;
  }
}

async function settle(env: CloudEnv, account: AccountRow, signal: CloudComputerSignal, moment: "read" | "use", ctx: Ctx): Promise<AccountRow> {
  const freeRules = accountRules(account) === "free";
  if (!signal) {
    if (moment === "use" && freeRules && account.free_refused_at == null) {
      const claim = await env.DB.prepare("select 1 as held from cloud_free_plan_claims where user_id = ?").bind(account.user_id).first();
      if (!claim) captureCloudFreePlan(env, ctx.waitUntil, account.user_id, "unclaimed_use", null, ctx.now);
    }
    return account;
  }
  if (signal.kind === "unreadable") {
    if (moment === "use") {
      logCloud("cloud.free_plan.id_unreadable", { userId: account.user_id, platform: signal.platform });
      captureCloudFreePlan(env, ctx.waitUntil, account.user_id, "id_unreadable", signal.platform, ctx.now);
    }
    return account;
  }
  const hash = await serverComputerHash(env, signal.clientHash);
  let view = await readClaims(env, account.user_id, hash);
  if (!view.seen) {
    await env.DB.prepare(`
      insert into cloud_account_computers (user_id, computer_hash, first_seen_at, platform) values (?, ?, ?, ?)
      on conflict (user_id, computer_hash) do nothing
    `).bind(account.user_id, hash, ctx.now, signal.platform).run();
  }
  if (view.own) {
    // This account holds a claim: its own computer (a reinstall, a sign-in again) or another one (a shared computer).
    return account.free_refused_at != null ? await restore(env, account, signal.platform, ctx) : account;
  }
  if (view.holder && view.holder !== account.user_id) return await refuse(env, account, hash, signal.platform, ctx);
  // Unclaimed computer, account without a claim. Paid accounts don't use free hours, so they claim nothing.
  if (!freeRules) return account;
  // A read claims only to give a refused account its hours back on a computer of its own.
  if (moment === "read" && account.free_refused_at == null) return account;
  await env.DB.prepare(`
    insert into cloud_free_plan_claims (computer_hash, user_id, claimed_at, platform) values (?, ?, ?, ?)
    on conflict do nothing
  `).bind(hash, account.user_id, ctx.now, signal.platform).run();
  view = await readClaims(env, account.user_id, hash);
  if (view.own === hash) {
    logCloud("cloud.free_plan.claimed", { userId: account.user_id, platform: signal.platform });
    captureCloudFreePlan(env, ctx.waitUntil, account.user_id, "claimed", signal.platform, ctx.now);
    return account.free_refused_at != null ? await restore(env, account, signal.platform, ctx) : account;
  }
  // Lost a race: another account took this computer at the same moment.
  if (view.holder && view.holder !== account.user_id && !view.own) return await refuse(env, account, hash, signal.platform, ctx);
  // Or this account claimed another computer at the same moment: that one is its claim.
  return account.free_refused_at != null && view.own ? await restore(env, account, signal.platform, ctx) : account;
}

/** The dashboard's free-plan state for an account; `hasClaim` from `cloud_free_plan_claims`. */
export function freePlanOf(account: Pick<AccountRow, "plan" | "stripe_status" | "free_refused_at">, hasClaim: boolean): CloudFreePlan {
  if (account.free_refused_at != null && !hasClaim) {
    return { state: "refused", sentence: accountRules(account) === "free" ? CLOUD_FREE_PLAN_REFUSED_SENTENCE : null };
  }
  return { state: hasClaim ? "claimed" : "unclaimed", sentence: null };
}
