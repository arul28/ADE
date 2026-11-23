/**
 * The owner's beta list for the ADE Cloud iPhone (`cloud_phone_beta`): who may
 * use it while `CLOUD_PHONE_ACCESS` is `beta` (`phones.ts` reads the list),
 * the emails still waiting for an account (`cloud_phone_beta_pending`), and
 * the provider a tester is locked to (`routeOf` in `phones.ts`).
 */

import { CLOUD_PHONE_PROVIDERS, isCloudPhoneProvider } from "./contract";
import { fail, json } from "./http";
import { phoneAccessSetting, stopAccountPhones } from "./phones";
import { providerSetting } from "./phoneRoute";
import { logCloud, phoneBetaAddStatement, reportCloudFailure, type CloudEnv } from "./store";

/** Clerk's lookups wait this long. */
const REQUEST_TIMEOUT_MS = 20_000;

export const OWNER_PHONE_BETA_PATH = "/cloud/owner/phone-beta";

const CLERK_USERS_URL = "https://api.clerk.com/v1/users";

/**
 * The Clerk user ids that have this address verified, or null when Clerk
 * can't be asked. Verified only, as `readClerkUser`: an address someone
 * added but never proved is not theirs, so it must not put them on the list.
 */
export async function clerkUserIdsFor(env: Pick<CloudEnv, "CLERK_SECRET_KEY">, email: string): Promise<string[] | null> {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return null;
  const response = await fetch(`${CLERK_USERS_URL}?email_address=${encodeURIComponent(email)}&limit=10`, {
    headers: { authorization: `Bearer ${secretKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const users = await response.json().catch(() => null) as unknown;
  if (!Array.isArray(users)) return null;
  const wanted = email.trim().toLowerCase();
  return users.flatMap((user) => {
    const { id, email_addresses: addresses } = (user ?? {}) as { id?: unknown; email_addresses?: unknown };
    const verified = Array.isArray(addresses) && addresses.some((address: { email_address?: unknown; verification?: { status?: unknown } | null } | null) =>
      typeof address?.email_address === "string" && address.email_address.trim().toLowerCase() === wanted && address.verification?.status === "verified");
    return typeof id === "string" && verified ? [id] : [];
  });
}

/** How many waiting tester emails one run asks Clerk about, and how long one waits before it is asked again. */
const PENDING_BETA_BATCH = 10;
const PENDING_BETA_RECHECK_MS = 60 * 60_000;

/**
 * The owner check's retry for waiting tester emails (`cloud_phone_beta_pending`):
 * an account's own claim (`claimPhoneBetaInvite` in `store.ts`) runs once,
 * when its row is made, so a Clerk read that failed then, or an address
 * verified later, would leave the email waiting for good. Each email is asked
 * again about once an hour, at most `PENDING_BETA_BATCH` a run, oldest asked
 * first; an empty table costs one read. Clerk not answering stops the run,
 * and that batch is asked again next hour.
 */
export async function resolvePendingPhoneBeta(env: CloudEnv, now: number): Promise<void> {
  // No Clerk key (a development Worker): nothing can be looked up.
  if (!env.CLERK_SECRET_KEY?.trim()) return;
  const due = await env.DB.prepare(`
    select email from cloud_phone_beta_pending where coalesce(checked_at, 0) < ? order by coalesce(checked_at, 0), added_at limit ?
  `).bind(now - PENDING_BETA_RECHECK_MS, PENDING_BETA_BATCH).all<{ email: string }>();
  for (const { email } of due.results ?? []) {
    let failure: string | null = null;
    const found = await clerkUserIdsFor(env, email).catch((error: unknown) => {
      failure = error instanceof Error ? error.message : "unknown";
      return null;
    });
    if (found == null) {
      // The whole batch waits its hour, so a Clerk outage is reported once a run, never once a minute.
      const emails = (due.results ?? []).map((row) => row.email);
      await env.DB.prepare("update cloud_phone_beta_pending set checked_at = ? where email in (select value from json_each(?))").bind(now, JSON.stringify(emails)).run();
      reportCloudFailure("cloud.phone_beta_pending_check_failed", { waiting: emails.length, message: failure ?? "Clerk did not answer" });
      return;
    }
    if (!found.length) {
      await env.DB.prepare("update cloud_phone_beta_pending set checked_at = ? where email = ?").bind(now, email).run();
      continue;
    }
    await env.DB.batch([
      ...found.map((userId) => phoneBetaAddStatement(env.DB, userId, email, now, { whilePending: true })),
      env.DB.prepare("delete from cloud_phone_beta_pending where email = ?").bind(email),
    ]);
    logCloud("cloud.phone_beta_claimed", { count: found.length, retried: true });
  }
}

/**
 * `POST /cloud/owner/phone-beta` `{ email? | userId?, enabled?, provider? }`
 * adds (or with `enabled: false` removes) an account; `{}` lists the list and
 * the emails still waiting. `provider`: `nomac` or `revyl` locks the account
 * to that one; `both` (or null) lets the router pick; left out, it stays. `safety.ts` checked the owner's token before this runs. An
 * email is looked up in Clerk once; the list keeps the user id (and the
 * address the owner typed, for the owner's own reading). An email no ADE
 * account has yet waits (`pending: true`, `cloud_phone_beta_pending`) until
 * an account with it first appears (`claimPhoneBetaInvite` in `store.ts`), or
 * the owner check finds it in Clerk (`resolvePendingPhoneBeta`).
 * Removing an email removes a waiting one too. With `CLOUD_PHONE_ACCESS=all`
 * the list no longer matters.
 */
export async function handleOwnerPhoneBeta(env: CloudEnv, body: Record<string, unknown>, now: number): Promise<Response> {
  const typedEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const typedUserId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!typedEmail && !typedUserId) {
    const rows = await env.DB.prepare("select user_id, email, added_at, provider from cloud_phone_beta order by added_at").all<{ user_id: string; email: string | null; added_at: number; provider: string | null }>();
    const pending = await env.DB.prepare("select email, added_at, provider from cloud_phone_beta_pending order by added_at").all<{ email: string; added_at: number; provider: string | null }>();
    const shown = <T extends { provider: string | null }>(row: T) => ({ ...row, provider: row.provider ?? "both" });
    return json({ ok: true, access: phoneAccessSetting(env), defaultProvider: providerSetting(env), users: (rows.results ?? []).map(shown), pending: (pending.results ?? []).map(shown) });
  }
  // `provider`: the tester is locked to one (`nomac`, `revyl`); `both` or null: the router picks.
  const provider = body.provider === null || body.provider === "both" ? null : body.provider === undefined ? undefined : isCloudPhoneProvider(body.provider) ? body.provider : false;
  if (provider === false) return fail("bad_request", `provider is ${CLOUD_PHONE_PROVIDERS.join(", ")} or both.`, 400);
  if (typedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail)) return fail("bad_request", "That email isn't valid.", 400);
  if (typedUserId && !/^[A-Za-z0-9_-]{1,100}$/.test(typedUserId)) return fail("bad_request", "That userId isn't valid.", 400);
  let userIds = typedUserId ? [typedUserId] : [];
  if (!userIds.length) {
    const found = await clerkUserIdsFor(env, typedEmail);
    if (found == null) return fail("unavailable", "Clerk could not be asked for that email. Try again, or pass userId.", 503);
    if (!found.length) {
      // No ADE account has it yet: the email waits for the account that signs up with it.
      if (body.enabled === false) {
        const removed = await env.DB.prepare("delete from cloud_phone_beta_pending where email = ?").bind(typedEmail).run();
        if ((removed.meta?.changes ?? 0) === 0) return fail("not_found", "No ADE account or waiting tester has that email.", 404);
        logCloud("cloud.phone_beta_pending_removed");
        return json({ ok: true, removed: [], pending: true });
      }
      // A waiting email keeps its provider until its account appears (`phoneBetaAddStatement`). `both` is
      // stored as the word, so it replaces an older lock on that account's row (null there keeps it).
      await env.DB.prepare(provider === undefined
        ? "insert into cloud_phone_beta_pending (email, added_at) values (?, ?) on conflict(email) do nothing"
        : "insert into cloud_phone_beta_pending (email, added_at, provider) values (?, ?, ?) on conflict(email) do update set provider = excluded.provider")
        .bind(...(provider === undefined ? [typedEmail, now] : [typedEmail, now, provider ?? "both"])).run();
      logCloud("cloud.phone_beta_pending_added", provider !== undefined ? { provider: provider ?? "both" } : {});
      return json({ ok: true, added: [], pending: true, ...(provider !== undefined ? { provider: provider ?? "both" } : {}) });
    }
    userIds = found;
  }
  // The account exists now: no email of it needs to wait.
  if (typedEmail) await env.DB.prepare("delete from cloud_phone_beta_pending where email = ?").bind(typedEmail).run();
  if (body.enabled === false) {
    for (const userId of userIds) {
      await env.DB.prepare("delete from cloud_phone_beta where user_id = ?").bind(userId).run();
      // Off the list is off now: a running phone stops (under `all`, the list doesn't matter).
      if (phoneAccessSetting(env) === "beta") await stopAccountPhones(env, userId, now, "access_removed");
    }
    logCloud("cloud.phone_beta_removed", { count: userIds.length });
    return json({ ok: true, removed: userIds });
  }
  for (const userId of userIds) {
    // The grant and its provider in one write: a start in between never sees one without the other.
    // A provider change reaches the next phone; the live one keeps its own.
    await env.DB.batch([
      phoneBetaAddStatement(env.DB, userId, typedEmail || null, now),
      ...(provider !== undefined ? [env.DB.prepare("update cloud_phone_beta set provider = ? where user_id = ?").bind(provider, userId)] : []),
    ]);
  }
  logCloud("cloud.phone_beta_added", { count: userIds.length, ...(provider !== undefined ? { provider: provider ?? "both" } : {}) });
  return json({ ok: true, added: userIds, ...(provider !== undefined ? { provider: provider ?? "both" } : {}) });
}
