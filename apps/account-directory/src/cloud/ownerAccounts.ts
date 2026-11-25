import { gravitySwitches, isSponsoredFormat, sponsoredAbReport, smallUsesNoHours, syncAllSmallRates, syncSmallRates, type GravityEnv } from "./gravity";
import { fail, json } from "./http";
import { CLOUD_SPONSORED_FORMATS, type CloudSponsoredFormat } from "./contract";
import { clerkUserIdsFor, handleOwnerPhoneBeta } from "./phoneBeta";
import { enforcePhoneAllowance, periodPhones, phoneAccess, phoneCreditsFor, phoneUsageOf } from "./phones";
import { CLOUD_PLANS, isPaidPlanId } from "./plans";
import {
  CLOUD_SETTINGS,
  isCloudSettingKey,
  isCloudSettingValue,
  ownerLogStatement,
  readCloudSettings,
  writeCloudSetting,
} from "./settings";
import {
  accountRules,
  boughtPlanIdOf,
  computerLimitOf,
  earnedBalanceMilli,
  extraActive,
  hasAccountTest,
  includedMilliOf,
  loadAccount,
  logCloud,
  reportCloudFailure,
  shownPlanIdOf,
  testPlanOf,
  type AccountRow,
  type CloudEnv,
} from "./store";

/**
 * The account test tool: the owner (and agents holding `CLOUD_OWNER_TOKEN`)
 * moves an account between plans, changes its limits, puts it on the
 * sponsored testers list, and flips the instant switches. Everything takes
 * effect on the account's next read, with no deploy. `scripts/cloud-owner.mjs`
 * wraps these routes; `docs/features/ade-cloud/account-test-tool.md` is the
 * guide.
 *
 * A test plan changes what the account may do and sees (the limits, the
 * hours meter, the computer limit, sponsored cards, Small's hours). It never
 * touches billing: Stripe, extra hours, the period and its roll keep the real
 * plan. It ends by itself at `test_until` (`expireAccountTests`).
 *
 * - `POST /cloud/owner/account` `{ email | userId, plan?, computers?, hours?, phone?, adFormat?, days?, note?, tester?, reset? }`:
 *   changes what is given, then answers the account as `show` does. Only an
 *   email or userId: just `show`. `plan: null` (and `computers`, `hours`)
 *   clears that one; `reset: true` clears every test field.
 *   `phone` (`on` or `off`) puts the account on the ADE Cloud iPhone's beta
 *   list, or takes it off (`phoneBeta.ts`): not a test, it stays until
 *   changed. A tester picks their phones' provider in an ADE beta app. The
 *   iPhone draws from the account's credits, so `hours` sets what it may use.
 *   `adFormat` (`below_reply`, `above_prompt`, `inline`, or null for the
 *   `gravity_format` switch's) is where the account's sponsored cards show:
 *   not a test either, it stays until changed.
 * - `POST /cloud/owner/ab` `{ days? }`: the sponsored formats' A/B scoreboard.
 * - `POST /cloud/owner/settings` `{ key?, value?, note? }`: sets one switch,
 *   or with no key lists them all with their deploy ceilings.
 */

export const OWNER_ACCOUNT_PATH = "/cloud/owner/account";
export const OWNER_SETTINGS_PATH = "/cloud/owner/settings";
export const OWNER_AB_PATH = "/cloud/owner/ab";

/** `POST /cloud/owner/ab` `{ days? }`: the sponsored formats' A/B scoreboard (`sponsoredAbReport`). */
export async function handleOwnerAb(env: GravityEnv, body: Record<string, unknown>, now: number): Promise<Response> {
  const days = body.days === undefined ? 14 : body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) return fail("bad_request", "days is a whole number from 1 to 365.", 400);
  return json({ ok: true, ...(await sponsoredAbReport(env, now, days)) });
}

/** How long a test lasts when the owner names no length, and the longest one. */
const DEFAULT_TEST_DAYS = 7;
const MAX_TEST_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
const MAX_NOTE = 200;
const LOG_ROWS = 10;
/** The most hours or computers a test may give: well past Max, never a typo's billion. */
const MAX_TEST_HOURS = 10_000;
const MAX_TEST_COMPUTERS = 100;
/** `phone`: on the beta list, or off it. */
const PHONE_CHOICES = ["on", "off"] as const;
type PhoneChoice = (typeof PHONE_CHOICES)[number];

type TestChange = {
  plan?: string | null;
  computers?: number | null;
  hoursMilli?: number | null;
};

/** The account the body names: one Clerk user for an email, or the userId as given. */
async function resolveUserId(env: CloudEnv, body: Record<string, unknown>): Promise<{ userId: string; email: string | null } | Response> {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (userId) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(userId)) return fail("bad_request", "That userId isn't valid.", 400);
    return { userId, email: email || null };
  }
  if (!email) return fail("bad_request", "Name an account: email or userId.", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("bad_request", "That email isn't valid.", 400);
  const found = await clerkUserIdsFor(env, email);
  if (found == null) return fail("unavailable", "Clerk could not be asked for that email. Try again, or pass userId.", 503);
  if (found.length === 0) return fail("not_found", "No ADE account has that email verified.", 404);
  if (found.length > 1) return fail("conflict", "More than one ADE account has that email. Pass userId.", 409, { userIds: found });
  return { userId: found[0]!, email };
}

/** A whole number in `[0, max]`, null to clear, undefined when not given, or false when invalid. */
function readCount(value: unknown, max: number): number | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : false;
}

function readChange(body: Record<string, unknown>): TestChange | string {
  const change: TestChange = {};
  if (body.plan !== undefined) {
    if (body.plan !== null && body.plan !== "free" && !isPaidPlanId(body.plan)) return "plan is free, plus, pro, max or null.";
    change.plan = body.plan as string | null;
  }
  const computers = readCount(body.computers, MAX_TEST_COMPUTERS);
  if (computers === false) return `computers is a whole number from 0 to ${MAX_TEST_COMPUTERS}, or null.`;
  if (computers !== undefined) change.computers = computers;
  const hours = readCount(body.hours, MAX_TEST_HOURS);
  if (hours === false) return `hours is a whole number from 0 to ${MAX_TEST_HOURS}, or null.`;
  if (hours !== undefined) change.hoursMilli = hours == null ? null : hours * 1000;
  return change;
}

const hoursOf = (milli: number): number => Math.round(milli / 100) / 10;

/** What the owner reads about an account: the real plan, the test, and what is in force. */
async function describeAccount(env: CloudEnv, account: AccountRow, email: string | null, now: number) {
  const [tester, consent, log, phoneRow, phoneUse, phone, adFormat] = await Promise.all([
    env.DB.prepare("select 1 as listed from cloud_sponsored_testers where user_id = ?").bind(account.user_id).first<{ listed: number }>(),
    env.DB.prepare("select consent, decided_at from cloud_sponsored_consent where user_id = ?").bind(account.user_id).first<{ consent: string; decided_at: number }>(),
    env.DB.prepare("select at, action, detail from cloud_owner_log where user_id = ? order by at desc, id desc limit ?")
      .bind(account.user_id, LOG_ROWS).all<{ at: number; action: string; detail: string }>(),
    env.DB.prepare("select provider from cloud_phone_beta where user_id = ?").bind(account.user_id).first<{ provider: string | null }>(),
    periodPhones(env, account.user_id, account.period_start),
    phoneAccess(env, account.user_id),
    env.DB.prepare("select format, source from cloud_sponsored_formats where user_id = ?").bind(account.user_id).first<{ format: string; source: string }>(),
  ]);
  const phoneUsage = phoneUsageOf(account, phoneUse, now, await phoneCreditsFor(env, account, now));
  const testing = hasAccountTest(account);
  return {
    userId: account.user_id,
    email,
    real: {
      plan: boughtPlanIdOf(account),
      rules: accountRules(account),
      stripeStatus: account.stripe_status,
      periodEnd: account.period_end,
      hours: hoursOf(account.included_milli),
      computers: CLOUD_PLANS[boughtPlanIdOf(account)].computerLimit,
    },
    test: testing
      ? {
        plan: testPlanOf(account),
        computers: account.test_computers ?? null,
        hours: account.test_hours_milli == null ? null : hoursOf(account.test_hours_milli),
        until: account.test_until ?? null,
        note: account.test_note ?? null,
      }
      : null,
    inForce: {
      plan: shownPlanIdOf(account),
      computers: computerLimitOf(account),
      hours: hoursOf(includedMilliOf(account)),
      usedHours: hoursOf(account.used_milli),
      smallUsesHours: !(await smallUsesNoHours(env, account)),
    },
    // The iPhone draws from the credits (`credits.ts`): what they still run it for, and what it used.
    phone: {
      access: phone.access,
      // On the beta list: the tester's own provider pick (`auto`: NoMac, then Revyl on a paid plan); off it: null.
      listed: phoneRow ? phoneRow.provider ?? "auto" : null,
      minutesLeft: phoneUsage.left,
      usedMinutes: phoneUsage.used,
    },
    sponsored: {
      mode: (await gravitySwitches(env)).mode,
      tester: Boolean(tester),
      consent: consent?.consent ?? null,
      // The owner's choice for this account, or null: the `gravity_format` switch's.
      format: adFormat?.source === "owner" ? adFormat.format : null,
      // Its arm of the A/B test, once ads reached it under `split`.
      abArm: adFormat?.source === "split" ? adFormat.format : null,
    },
    log: (log.results ?? []).map((row) => ({ at: row.at, action: row.action, detail: safeJson(row.detail) })),
  };
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** `POST /cloud/owner/account`. The owner token was checked before this runs (`safety.ts`). */
export async function handleOwnerAccount(env: CloudEnv, body: Record<string, unknown>, now: number): Promise<Response> {
  const who = await resolveUserId(env, body);
  if (who instanceof Response) return who;
  const change = readChange(body);
  if (typeof change === "string") return fail("bad_request", change, 400);
  const days = body.days === undefined ? DEFAULT_TEST_DAYS : body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_TEST_DAYS) {
    return fail("bad_request", `days is a whole number from 1 to ${MAX_TEST_DAYS}.`, 400);
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE) : null;
  const tester = typeof body.tester === "boolean" ? body.tester : undefined;
  if (body.phone !== undefined && !(PHONE_CHOICES as readonly unknown[]).includes(body.phone)) {
    return fail("bad_request", `phone is one of ${PHONE_CHOICES.join(", ")}.`, 400);
  }
  const phoneChoice = body.phone as PhoneChoice | undefined;
  if (body.adFormat !== undefined && body.adFormat !== null && !isSponsoredFormat(body.adFormat)) {
    return fail("bad_request", `adFormat is one of ${CLOUD_SPONSORED_FORMATS.join(", ")}, or null.`, 400);
  }
  const adFormat = body.adFormat as CloudSponsoredFormat | null | undefined;
  const reset = body.reset === true;

  // A userId must name an account ADE Cloud knows (a typo makes no row); an
  // email Clerk verified may create it (on Free), as its first read would.
  if (!who.email && !(await env.DB.prepare("select 1 as known from cloud_accounts where user_id = ?").bind(who.userId).first())) {
    return fail("not_found", "ADE Cloud has no account with that userId.", 404);
  }
  let account = await loadAccount(env, who.userId, now);
  const statements: D1PreparedStatement[] = [];
  if (reset) {
    statements.push(env.DB.prepare(`update cloud_accounts set test_plan = null, test_computers = null, test_hours_milli = null,
      test_until = null, test_note = null, updated_at = ? where user_id = ?`).bind(now, who.userId));
  } else if (Object.keys(change).length || (note && hasAccountTest(account))) {
    const next = {
      plan: change.plan !== undefined ? change.plan : account.test_plan ?? null,
      computers: change.computers !== undefined ? change.computers : account.test_computers ?? null,
      hoursMilli: change.hoursMilli !== undefined ? change.hoursMilli : account.test_hours_milli ?? null,
    };
    const any = next.plan != null || next.computers != null || next.hoursMilli != null;
    // Billing counts the real hours: more test hours than that would draw real
    // earned hours, or bill extra hours, for what the meter shows as included.
    const raises = includedMilliOf({ ...account, test_plan: next.plan, test_hours_milli: next.hoursMilli }) > account.included_milli;
    if (raises && (earnedBalanceMilli(account) > 0 || extraActive(account))) {
      return fail("conflict", "This account has earned credits or extra credits on, so a test with more credits than its plan would use them for real. Test fewer credits, or use another account.", 409);
    }
    statements.push(env.DB.prepare(`update cloud_accounts set test_plan = ?, test_computers = ?, test_hours_milli = ?,
      test_until = ?, test_note = ?, updated_at = ? where user_id = ?`)
      .bind(next.plan, next.computers, next.hoursMilli, any ? now + days * DAY_MS : null, any ? note ?? account.test_note ?? null : null, now, who.userId));
  }
  if (tester === true) {
    statements.push(env.DB.prepare("insert into cloud_sponsored_testers (user_id, added_at) values (?, ?) on conflict (user_id) do nothing").bind(who.userId, now));
  }
  if (tester === false) statements.push(env.DB.prepare("delete from cloud_sponsored_testers where user_id = ?").bind(who.userId));
  if (adFormat) {
    // Over the account's A/B arm too: an account the owner set leaves the test.
    statements.push(env.DB.prepare(`insert into cloud_sponsored_formats (user_id, format, source, set_at) values (?, ?, 'owner', ?)
      on conflict (user_id) do update set format = excluded.format, source = excluded.source, set_at = excluded.set_at`).bind(who.userId, adFormat, now));
  }
  if (adFormat === null) statements.push(env.DB.prepare("delete from cloud_sponsored_formats where user_id = ? and source = 'owner'").bind(who.userId));
  const testChanged = statements.length > 0;
  if (testChanged) {
    const detail = {
      ...(reset ? {} : { ...change, ...(Object.keys(change).length ? { days } : {}) }),
      ...(tester === undefined ? {} : { tester }),
      ...(adFormat === undefined ? {} : { adFormat }),
      ...(note ? { note } : {}),
    };
    statements.push(env.DB.prepare("insert into cloud_owner_log (at, action, user_id, detail) values (?, ?, ?, ?)")
      .bind(now, reset ? "account_reset" : "account_test", who.userId, JSON.stringify(detail)));
    await env.DB.batch(statements);
    // Small's hours follow the plan and the testers list at once.
    await syncSmallRates(env, await loadAccount(env, who.userId, now), now);
    // A running phone is held to the new credits at once: fewer stop it sooner, more let it run on.
    if (reset || change.plan !== undefined || change.hoursMilli !== undefined) await holdPhoneToAllowance(env, who.userId, now);
    logCloud("cloud.owner_account_changed", { userId: who.userId, reset, tester: tester ?? null, plan: change.plan ?? null });
  }
  // The beta list keeps its own rules (a removal stops a running phone): its route does it, after the test's write.
  if (phoneChoice !== undefined) {
    // The email too: the list keeps the address, and a removal drops its waiting invite (else the invite sweep adds it back).
    const ref = { userId: who.userId, ...(who.email ? { email: who.email } : {}) };
    // Its log entry is written with the list change.
    const logged = [ownerLogStatement(env, now, "account_phone", who.userId, { phone: phoneChoice })];
    const listed = await handleOwnerPhoneBeta(env, phoneChoice === "off" ? { ...ref, enabled: false } : ref, now, logged);
    if (!listed.ok) return listed;
  }
  if (testChanged || phoneChoice !== undefined) account = await loadAccount(env, who.userId, now);
  return json({ ok: true, account: await describeAccount(env, account, who.email, now) });
}

/** `POST /cloud/owner/settings`. The owner token was checked before this runs (`safety.ts`). */
export async function handleOwnerSettings(env: GravityEnv, body: Record<string, unknown>, now: number): Promise<Response> {
  if (body.key !== undefined) {
    if (!isCloudSettingKey(body.key)) return fail("bad_request", `key is one of ${Object.keys(CLOUD_SETTINGS).join(", ")}.`, 400);
    const key = body.key;
    if (!isCloudSettingValue(key, body.value)) return fail("bad_request", `${key} is one of ${CLOUD_SETTINGS[key].join(", ")}.`, 400);
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE) : null;
    await writeCloudSetting(env, key, body.value, note, now);
    logCloud("cloud.owner_setting_changed", { key, value: body.value });
    // Small's hours follow the ad switch at once for every account; what a time budget leaves, the tick's sweep finishes.
    if (key === "gravity_ads") await syncAllSmallRates(env, now, { force: true });
  }
  const settings = await readCloudSettings(env);
  const switches = await gravitySwitches(env, settings);
  return json({
    ok: true,
    settings,
    ceilings: { gravity_ads: env.GRAVITY_ADS?.trim() || "off", gravity_live: env.GRAVITY_LIVE?.trim() === "1" ? "on" : "off" },
    inForce: { ...settings, gravity_ads: switches.mode, gravity_live: switches.live ? "on" : "off" },
  });
}

/** The account's running phone, held to its credits now (`enforcePhoneAllowance`); a failure waits for the ten-minute check. */
async function holdPhoneToAllowance(env: CloudEnv, userId: string, now: number): Promise<void> {
  try {
    await enforcePhoneAllowance(env, userId, now);
  } catch (error) {
    reportCloudFailure("cloud.owner_phone_enforce_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * The minute tick: tests whose time is up end, and the account's Small
 * computers go back to the rate of its real plan. One indexed read when none is due.
 */
export async function expireAccountTests(env: CloudEnv, now: number): Promise<number> {
  const due = await env.DB.prepare("select user_id from cloud_accounts where test_until is not null and test_until <= ? limit 50")
    .bind(now).all<{ user_id: string }>();
  let ended = 0;
  for (const { user_id: userId } of due.results ?? []) {
    const cleared = await env.DB.prepare(`update cloud_accounts set test_plan = null, test_computers = null, test_hours_milli = null, test_until = null, test_note = null,
      updated_at = ? where user_id = ? and test_until is not null and test_until <= ?`).bind(now, userId, now).run();
    if ((cleared.meta.changes ?? 0) !== 1) continue;
    await ownerLogStatement(env, now, "account_test_ended", userId, {}).run();
    ended += 1;
    const account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
    if (account) await syncSmallRates(env, account, now);
    // The real plan's credits again: a running phone is held to them.
    await holdPhoneToAllowance(env, userId, now);
  }
  if (ended) logCloud("cloud.account_tests_ended", { count: ended });
  return ended;
}
