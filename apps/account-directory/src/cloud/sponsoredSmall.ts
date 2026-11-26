import { captureCloudFreePlan, type CloudWaitUntil } from "./analytics";
import { blockCommand, sendOwnerAlert } from "./blocks";
import type { CloudSponsoredState } from "./contract";
import type { GravityEnv } from "./gravity";
import { SMALL_NO_CARDS_RATE_MILLI, SMALL_SHAPE, cloudSizeFor, type CloudSize } from "./plans";
import { readCloudSettings, type CloudSettings } from "./settings";
import { readConsent, type ConsentRow, type SponsoredRequester } from "./sponsoredConsent";
import { gravitySwitches, switchReaches } from "./sponsoredSwitch";
import { logCloud, reportCloudFailure, restartStretchStatements, shownPlanIdOf, statusGuard, type AccountRow, type ComputerRow } from "./store";

// Free's Small computers: unlimited with sponsored cards, in the US. Where
// the ad switch reaches a Free account, its Small computers use no credits
// only while it said yes to the cards and someone opened one of its ADE Cloud
// chats (or terminals) from the US in the last week; otherwise they run at
// `SMALL_NO_CARDS_RATE_MILLI`. `gravity.ts` saves the answers and the looks;
// this module decides the rate, puts computers on it and tells the clients.
//
// The tripwire: a look (or a yes) comes from the person's app, but a script on
// their own ADE Cloud computer (a US datacenter, signed in to the account)
// could send one every hour with nobody watching. Such a look still counts; it
// is caught by its network (the AS number of the computer's own calls) and the
// owner is told: an email and a Sentry error once a week per account, a
// PostHog `ade_cloud_safety` step, and a line in the daily report.

/**
 * The one country where sponsored cards keep Free's Small computers free.
 * Elsewhere (Gravity's other countries included) Small uses credits, cards or
 * not. Settings and the question say "the US", so this is one code, not a list.
 */
const SMALL_FREE_COUNTRY = "US";
/**
 * How long a yes keeps Free's Small free after the person last opened an
 * ADE Cloud chat from the US (`looked_at`, refreshed by
 * `/cloud/sponsored/seen`). Covers a week's trip; after it, Small uses
 * credits until the next such look. So a yes given once (from a VPN, say)
 * can't keep Small free for someone who never sees a card in the US.
 */
const SMALL_FREE_LOOK_MS = 7 * 24 * 60 * 60_000;
/**
 * A look refreshes `looked_at` at most this often: one write an hour per
 * account, not one every few minutes. So `looked_at` can trail the last look
 * by up to this much, and the window allows for it (`freeLookSince`).
 */
export const LOOK_REFRESH_MS = 60 * 60_000;

/** A request from where cards keep Small free; one with no Cloudflare data (a test, a local run) counts, as the country checks do. */
export const smallFreeFrom = (country: string | null): boolean => country == null || country === SMALL_FREE_COUNTRY;

/** The oldest `looked_at` that still keeps Small free at `now`: a week, plus the refresh's lag, never less. */
const freeLookSince = (now: number): number => now - SMALL_FREE_LOOK_MS - LOOK_REFRESH_MS;

/** Whether the account's yes still keeps Small free: given, or seen holding, from the US within `SMALL_FREE_LOOK_MS`. */
export const lookKeepsSmallFree = (consent: ConsentRow | null, now: number): boolean =>
  consent?.consent === "granted" && consent.looked_at != null && consent.looked_at >= freeLookSince(now);

/**
 * What Free's Small costs this person, for the question and Settings. Only
 * Free (or acting as it) has the deal; a paid account's Small is unlimited
 * either way. Read from where the request comes from: cards keep Small free
 * only from the US, and a trip keeps it free for `SMALL_FREE_LOOK_MS`.
 */
export function smallStateOf(account: AccountRow, consent: ConsentRow | null, who: SponsoredRequester, now: number): Pick<CloudSponsoredState, "smallNeedsCards" | "smallNeedsLook" | "smallOutsideUS"> {
  if (shownPlanIdOf(account) !== "free") return {};
  const free = lookKeepsSmallFree(consent, now);
  if (!free && !smallFreeFrom(who.country)) return { smallOutsideUS: true };
  return {
    // Cards keep (or would keep) Small free: a no has it use credits.
    smallNeedsCards: true,
    // A yes whose looks lapsed: Small uses credits until the next ADE Cloud chat opened here.
    ...(!free && consent?.consent === "granted" ? { smallNeedsLook: true } : {}),
  };
}

/**
 * Whether the account's Small computers use no hours now. Always, unless the
 * account is on Free (or acts as it, `shownPlanIdOf`) and the ad switch
 * reaches it: then only while it said yes to sponsored cards and opened one
 * of its ADE Cloud chats from the US in the last `SMALL_FREE_LOOK_MS`. One
 * switch is the deal: where ads reach Free, Small is unlimited with cards in
 * the US and uses hours otherwise; ads off is Small unlimited for everyone.
 */
export async function smallUsesNoHours(env: GravityEnv, account: AccountRow, settings?: CloudSettings, now = Date.now()): Promise<boolean> {
  return (await smallRule(env, account, settings, now)).free;
}

/**
 * `smallUsesNoHours` with its reason: not on Free, the ad switch doesn't reach
 * the account, a recent US look (`look`), a yes whose looks lapsed
 * (`lapsed`), or no yes at all.
 */
async function smallRule(env: GravityEnv, account: AccountRow, settings: CloudSettings | undefined, now: number): Promise<{ free: boolean; why: "not_free" | "unreached" | "look" | "lapsed" | "no_yes" }> {
  if (shownPlanIdOf(account) !== "free") return { free: true, why: "not_free" };
  const { mode } = await gravitySwitches(env, settings ?? (await readCloudSettings(env)));
  if (!(await switchReaches(env, account, mode))) return { free: true, why: "unreached" };
  const consent = await readConsent(env, account.user_id);
  if (lookKeepsSmallFree(consent, now)) return { free: true, why: "look" };
  return { free: false, why: consent?.consent === "granted" ? "lapsed" : "no_yes" };
}

/**
 * A look at one of the account's ADE Cloud chats or terminals found its yes
 * holding (`/cloud/sponsored/seen`). From the US it keeps Small free: saved at
 * most once an hour, only over the yes it read (a no saved meanwhile wins),
 * and never moved back by a slower request, with the network it came from
 * (`asn`). Back from a lapse, Small is free again from this look. A look from
 * the network of the account's own ADE Cloud computers trips the tripwire.
 */
export async function noteSmallLook(env: GravityEnv, account: AccountRow, consent: ConsentRow, country: string | null, asn: number | null, now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  if (!smallFreeFrom(country)) return;
  if (consent.looked_at != null && now - consent.looked_at < LOOK_REFRESH_MS) return;
  // Both sides read the row as it was: the network moves only with a look that moves `looked_at`.
  await env.DB.prepare(`
    update cloud_sponsored_consent set looked_at = max(coalesce(looked_at, 0), ?),
      looked_asn = case when ? >= coalesce(looked_at, 0) then ? else looked_asn end
    where user_id = ? and consent = 'granted' and decided_at = ?
  `).bind(now, now, asn, account.user_id, consent.decided_at).run();
  if (!lookKeepsSmallFree(consent, now) && await syncSmallRates(env, account, now)) {
    captureCloudFreePlan(env, waitUntil, account.user_id, "small_restored", null, now);
  }
  await smallLookTripwire(env, account, asn, now, waitUntil);
}

/**
 * The tripwire at a US look or yes (`gravity.ts`): one from the network the
 * account's own ADE Cloud computers call from. Told once a week per account
 * (`sendOwnerAlert`: an email, a `cloud_abuse_events` row, a Sentry error and
 * a PostHog step). Never fails the look: a failure here is a Sentry issue of
 * its own.
 */
export async function smallLookTripwire(env: GravityEnv, account: AccountRow, asn: number | null, now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  // Only Free's Small costs anything without a look.
  if (asn == null || shownPlanIdOf(account) !== "free") return;
  try {
    const own = await env.DB.prepare("select count(*) as computers from cloud_computers where user_id = ? and deleted_at is null and net_asn = ?")
      .bind(account.user_id, asn).first<{ computers: number }>();
    if (!own?.computers) return;
    logCloud("cloud.sponsored.small_cloud_look", { userId: account.user_id, asn });
    await sendOwnerAlert(env, {
      key: `small_cloud_look:${account.user_id}:${Math.floor(now / SMALL_FREE_LOOK_MS)}`,
      kind: "small_cloud_look",
      userId: account.user_id,
      subject: "ADE Cloud: free Small kept free from its own cloud computer's network",
      reason: "A US view of a cloud chat (or a turn-on of sponsored cards) that keeps this Free account's Small computers free came from the same network as its own ADE Cloud computers, not from a phone or laptop. It may be a script on the computer keeping Small free with nobody watching. Nothing was refused: it still counts.",
      counts: { Network: `AS${asn}`, "Its computers on that network": own.computers },
      step: "small_cloud_look",
      abuse: true,
    }, now, waitUntil);
  } catch (error) {
    reportCloudFailure("cloud.sponsored.small_tripwire_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * Keeps the network an ADE Cloud computer's brain calls from (its activity
 * report, `routes.ts`), for the tripwire. Written only when it changed.
 */
export async function noteComputerNetwork(env: Pick<GravityEnv, "DB">, computer: Pick<ComputerRow, "instance_id" | "net_asn">, asn: number | null): Promise<void> {
  if (asn == null || computer.net_asn === asn) return;
  await env.DB.prepare("update cloud_computers set net_asn = ? where instance_id = ?").bind(asn, computer.instance_id).run();
}

/** Accounts the daily report names at most. */
const TRIPWIRE_REPORT_LIMIT = 25;

/**
 * The daily report's tripwire alarms: Free accounts whose Small is free now
 * through a look whose network is their own ADE Cloud computers'. One line
 * each, with its block command. Empty on a quiet day.
 */
export async function smallCloudLookAlarms(env: GravityEnv, now: number): Promise<string[]> {
  const rows = await env.DB.prepare(`
    select s.user_id, s.looked_asn from cloud_sponsored_consent s
    where s.consent = 'granted' and s.looked_at >= ? and s.looked_asn is not null
      and exists (select 1 from cloud_computers c where c.user_id = s.user_id and c.deleted_at is null and c.net_asn = s.looked_asn)
    limit ?
  `).bind(freeLookSince(now), TRIPWIRE_REPORT_LIMIT).all<{ user_id: string; looked_asn: number }>();
  const settings = await readCloudSettings(env);
  const alarms: string[] = [];
  for (const row of rows.results ?? []) {
    const account = await env.DB.prepare("select * from cloud_accounts where user_id = ? and deleted_at is null").bind(row.user_id).first<AccountRow>();
    if (!account || (await smallRule(env, account, settings, now)).why !== "look") continue;
    alarms.push(`Free account ${row.user_id}: its Small stays free through a view from its own ADE Cloud computer's network (AS${row.looked_asn}), not a phone or laptop. Block it: ${blockCommand(env, row.user_id, "small_cloud_look")}`);
  }
  return alarms;
}

/** The rate a computer of `size` runs at for this account: Small's is 0, or `SMALL_NO_CARDS_RATE_MILLI`. */
export const rateMilliFor = (size: Pick<CloudSize, "tier" | "multiplierMilli">, smallFree: boolean): number =>
  size.tier === "small" && !smallFree ? SMALL_NO_CARDS_RATE_MILLI : size.multiplierMilli;

/**
 * Puts the account's Small computers on the rate they run at now
 * (`rateMilliFor`): the time so far is charged at the old rate and the new
 * one starts there, as a resize does. Run after anything that changes the
 * answer (a yes or no, a test plan, a tester), and by the tick for every
 * account after a switch flips. The number of computers re-rated.
 */
export async function syncSmallRates(env: GravityEnv, account: AccountRow, now: number, settings?: CloudSettings, waitUntil?: CloudWaitUntil): Promise<number> {
  const { free: smallFree, why } = await smallRule(env, account, settings, now);
  const rows = await env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null").bind(account.user_id).all<ComputerRow>();
  const statements: D1PreparedStatement[] = [];
  let changed = 0;
  for (const computer of rows.results ?? []) {
    const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
    if (size?.tier !== "small") continue;
    const rate = rateMilliFor(size, smallFree);
    if (rate === computer.multiplier_milli) continue;
    // The new rate first, held to the row as read; then the stretch so far is
    // charged at the old rate (bound now) and a new one starts.
    // A rate that uses hours is never written over a yes saved meanwhile (a no
    // and a yes racing): the yes's own sync, or the next tick, has the say.
    const guard = statusGuard(computer);
    const yesSince = smallFree ? "" : ` and not exists (select 1 from cloud_sponsored_consent where user_id = cloud_computers.user_id and consent = 'granted' and looked_at >= ?)`;
    statements.push(env.DB.prepare(`update cloud_computers set multiplier_milli = ? where instance_id = ? and multiplier_milli = ? and ${guard.sql}${yesSince}`)
      .bind(rate, computer.instance_id, computer.multiplier_milli, ...guard.binds, ...(smallFree ? [] : [freeLookSince(now)])));
    if (computer.awake_since != null && computer.awake_since <= now) statements.push(...restartStretchStatements(env, computer, now));
    changed += 1;
  }
  if (statements.length) await env.DB.batch(statements);
  if (changed) logCloud("cloud.small_rate_synced", { userId: account.user_id, smallFree, why, changed });
  if (changed && why === "lapsed") captureCloudFreePlan(env, waitUntil, account.user_id, "small_lapsed", null, now);
  return changed;
}

/** Accounts one page re-rates, and how long a forced sync keeps paging. */
const SMALL_SYNC_PAGE = 100;
const SMALL_SYNC_BUDGET_MS = 20_000;

/**
 * Accounts with a Small computer on the wrong rate (the rule of
 * `smallUsesNoHours` in SQL), re-rated a page at a time. The minute tick runs
 * one page (a single read when none is wrong), so a switch flip, a hard off
 * in the deploy variable, a missing key or a lapsed look reaches every
 * account within minutes; the owner route pages on for up to 20 s (`force`).
 * Only wrong rows are picked, so the pages always move on.
 */
export async function syncAllSmallRates(env: GravityEnv, now: number, { force = false, waitUntil }: { force?: boolean; waitUntil?: CloudWaitUntil } = {}): Promise<number> {
  const settings = await readCloudSettings(env);
  const { mode } = await gravitySwitches(env, settings);
  const started = Date.now();
  let changed = 0;
  for (;;) {
    const users = await env.DB.prepare(`
      select distinct c.user_id from cloud_computers c join cloud_accounts a on a.user_id = c.user_id
      where c.deleted_at is null and c.type = 'default' and c.cpu = ? and c.memory_gb = ?
        and c.multiplier_milli != (case when
          coalesce(case when a.test_plan in ('free', 'plus', 'pro', 'max') then a.test_plan end, case when a.plan = 'paid' then 'paid' else 'free' end) != 'free'
          or not (? = 'all' or (? = 'testers' and exists (select 1 from cloud_sponsored_testers t where t.user_id = a.user_id)))
          or exists (select 1 from cloud_sponsored_consent s where s.user_id = a.user_id and s.consent = 'granted' and s.looked_at >= ?)
        then 0 else ? end)
      limit ?
    `).bind(SMALL_SHAPE.cpu, SMALL_SHAPE.memoryGb, mode, mode, freeLookSince(now), SMALL_NO_CARDS_RATE_MILLI, SMALL_SYNC_PAGE).all<{ user_id: string }>();
    const page = users.results ?? [];
    let pageChanged = 0;
    for (const { user_id: userId } of page) {
      const account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
      if (account) pageChanged += await syncSmallRates(env, account, now, settings, waitUntil);
    }
    changed += pageChanged;
    // One page a tick; a forced sync pages on while rows still move and the budget lasts.
    if (!force || page.length < SMALL_SYNC_PAGE || pageChanged === 0 || Date.now() - started > SMALL_SYNC_BUDGET_MS) break;
  }
  return changed;
}
