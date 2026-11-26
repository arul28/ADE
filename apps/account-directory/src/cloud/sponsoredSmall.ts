import { captureCloudFreePlan, type CloudWaitUntil } from "./analytics";
import { blockCommand, notBlockedSql, sendOwnerAlert } from "./blocks";
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
  return SMALL_FREE_WHYS.has(await smallRule(env, account, settings, now));
}

/**
 * Why Small is free or not: not on Free, the ad switch doesn't reach the
 * account, a recent US look (`look`), a yes whose looks lapsed (`lapsed`), or
 * no yes at all.
 */
type SmallWhy = "not_free" | "unreached" | "look" | "lapsed" | "no_yes";
const SMALL_FREE_WHYS: ReadonlySet<SmallWhy> = new Set(["not_free", "unreached", "look"]);

async function smallRule(env: GravityEnv, account: AccountRow, settings: CloudSettings | undefined, now: number): Promise<SmallWhy> {
  if (shownPlanIdOf(account) !== "free") return "not_free";
  const { mode } = await gravitySwitches(env, settings ?? (await readCloudSettings(env)));
  if (!(await switchReaches(env, account, mode))) return "unreached";
  const consent = await readConsent(env, account.user_id);
  if (lookKeepsSmallFree(consent, now)) return "look";
  return consent?.consent === "granted" ? "lapsed" : "no_yes";
}

/** SQL over `cloud_accounts a`: on Free as the account is shown (a test plan first, `shownPlanIdOf`). */
const SHOWN_FREE_SQL = "coalesce(case when a.test_plan in ('free', 'plus', 'pro', 'max') then a.test_plan end, case when a.plan = 'paid' then 'paid' else 'free' end) = 'free'";
/** SQL over `cloud_accounts a`, binding the ad switch's mode twice: the switch reaches the account (`switchReaches`). */
const SWITCH_REACHES_SQL = "(? = 'all' or (? = 'testers' and exists (select 1 from cloud_sponsored_testers t where t.user_id = a.user_id)))";
/** SQL over a `cloud_computers` alias, binding `SMALL_SHAPE`'s cpu and memory: a Small computer. */
const smallComputerSql = (alias: string): string => `${alias}.type = 'default' and ${alias}.cpu = ? and ${alias}.memory_gb = ?`;

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
  const saved = await env.DB.prepare(`
    update cloud_sponsored_consent set looked_at = max(coalesce(looked_at, 0), ?),
      looked_asn = case when ? >= coalesce(looked_at, 0) then ? else looked_asn end
    where user_id = ? and consent = 'granted' and decided_at = ?
  `).bind(now, now, smallLookNetwork(account, asn), account.user_id, consent.decided_at).run();
  // A no saved meanwhile: this look counted for nothing.
  if (!saved.meta?.changes) return;
  if (!lookKeepsSmallFree(consent, now)) await syncSmallRates(env, account, now, { waitUntil, restore: true });
  await smallLookTripwire(env, account, asn, now, waitUntil);
}

/**
 * The network kept with a US look or yes: only Free's, the one plan the
 * tripwire reads, so a paid account's is never stored.
 */
export const smallLookNetwork = (account: AccountRow, asn: number | null): number | null => (shownPlanIdOf(account) === "free" ? asn : null);

/** The owner hears of one account at most once in this long (weeks counted from the Unix epoch, so they start Thursdays 00:00 UTC). */
const TRIPWIRE_ALERT_MS = 7 * 24 * 60 * 60_000;
/**
 * How long a network an ADE Cloud computer joined from stays ADE Cloud's own.
 * The join (`launches.ts`) is made by the computer itself during setup, with a
 * one-time code no person holds, so no account can fake one. An activity
 * report uses the account's own sign-in, so its network names only that
 * account's computers (a report sent through a VPN rewrites only its own).
 */
const JOINED_NETWORK_MS = 30 * 24 * 60 * 60_000;

/**
 * The tripwire at a US look or yes (`gravity.ts`): one from the network the
 * account's own ADE Cloud computers call from. Told once a week per account
 * (`sendOwnerAlert`: an email, a `cloud_abuse_events` row, a Sentry error and
 * a PostHog step). Never fails the look: a failure here is a Sentry issue of
 * its own.
 */
export async function smallLookTripwire(env: GravityEnv, account: AccountRow, asn: number | null, now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  // Only Free's Small costs anything without a look.
  const network = smallLookNetwork(account, asn);
  if (network == null) return;
  try {
    const seen = await env.DB.prepare(`
      select
        (select count(*) from cloud_computers c where c.user_id = ? and c.deleted_at is null and c.net_asn = ?) as own,
        (select count(*) from cloud_computers c where c.join_asn = ? and c.created_at >= ?) as joined,
        (select count(*) from cloud_computers c where c.user_id = ? and c.deleted_at is null and ${smallComputerSql("c")}) as smalls
    `).bind(account.user_id, network, network, now - JOINED_NETWORK_MS, account.user_id, SMALL_SHAPE.cpu, SMALL_SHAPE.memoryGb).first<{ own: number; joined: number; smalls: number }>();
    // Only a look from ADE Cloud's network (its own computers', or one a computer joined from) that keeps a live Small free matters.
    if (!seen?.smalls || (!seen.own && !seen.joined)) return;
    logCloud("cloud.sponsored.small_cloud_look", { userId: account.user_id, asn: network });
    await sendOwnerAlert(env, {
      key: `small_cloud_look:${account.user_id}:${Math.floor(now / TRIPWIRE_ALERT_MS)}`,
      kind: "small_cloud_look",
      userId: account.user_id,
      subject: "ADE Cloud: free Small kept free from an ADE Cloud computer's network",
      reason: "A US view of a cloud chat (or a turn-on of sponsored cards) that keeps this Free account's Small computers free came from the network ADE Cloud computers call from, not from a phone or laptop. It may be a script on a cloud computer keeping Small free with nobody watching. Nothing was refused: it still counts.",
      counts: { Network: `AS${network}`, "Its computers on that network": seen.own, "ADE Cloud computers that joined from it (30 days)": seen.joined, "Its Small computers": seen.smalls },
      step: "small_cloud_look",
      abuse: true,
    }, now, waitUntil);
  } catch (error) {
    reportCloudFailure("cloud.sponsored.small_tripwire_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * Networks privacy relays share with everyone: Cloudflare (WARP, and part of
 * iCloud Private Relay), Akamai and Fastly (the rest of Private Relay). A
 * computer seen on one names no datacenter of its own, and a match on it would
 * trip for every Safari user of ADE's web app: never kept.
 */
const SHARED_RELAY_NETWORKS: ReadonlySet<number> = new Set([13335, 36183, 54113]);
const computerNetworkOf = (asn: number | null): number | null => (asn == null || SHARED_RELAY_NETWORKS.has(asn) ? null : asn);

/**
 * Keeps the network an ADE Cloud computer's brain calls from (its activity
 * report, `routes.ts`), for the tripwire. Written only when it changed.
 */
export async function noteComputerNetwork(env: Pick<GravityEnv, "DB">, computer: Pick<ComputerRow, "instance_id" | "net_asn">, asn: number | null): Promise<void> {
  const network = computerNetworkOf(asn);
  if (network == null || computer.net_asn === network) return;
  await env.DB.prepare("update cloud_computers set net_asn = ? where instance_id = ?").bind(network, computer.instance_id).run();
}

/** Keeps the network a computer joined from (`launches.ts`, its first join only): ADE Cloud's own, for the tripwire. */
export async function noteComputerJoin(env: Pick<GravityEnv, "DB">, instanceId: string, asn: number | null): Promise<void> {
  const network = computerNetworkOf(asn);
  if (network == null) return;
  await env.DB.prepare("update cloud_computers set join_asn = ? where instance_id = ? and join_asn is null").bind(network, instanceId).run();
}

/** Accounts the daily report names at most. */
const TRIPWIRE_REPORT_LIMIT = 25;

/**
 * The daily report's tripwire alarms: Free accounts the ad switch reaches,
 * not blocked, whose live Small is free now through a US look or yes from
 * ADE Cloud's network (their own computers', or one a computer joined from in
 * `JOINED_NETWORK_MS`). One line each, with its block command. Empty on a
 * quiet day.
 */
export async function smallCloudLookAlarms(env: GravityEnv, now: number): Promise<string[]> {
  const { mode } = await gravitySwitches(env);
  const rows = await env.DB.prepare(`
    select s.user_id, s.looked_asn from cloud_sponsored_consent s join cloud_accounts a on a.user_id = s.user_id
    where s.consent = 'granted' and s.looked_at >= ? and s.looked_asn is not null and a.deleted_at is null
      and ${SHOWN_FREE_SQL} and ${SWITCH_REACHES_SQL} and ${notBlockedSql("s.user_id")}
      and (exists (select 1 from cloud_computers c where c.user_id = s.user_id and c.deleted_at is null and c.net_asn = s.looked_asn)
        or exists (select 1 from cloud_computers c where c.join_asn = s.looked_asn and c.created_at >= ?))
      and exists (select 1 from cloud_computers c where c.user_id = s.user_id and c.deleted_at is null and ${smallComputerSql("c")})
    limit ?
  `).bind(freeLookSince(now), mode, mode, now - JOINED_NETWORK_MS, SMALL_SHAPE.cpu, SMALL_SHAPE.memoryGb, TRIPWIRE_REPORT_LIMIT).all<{ user_id: string; looked_asn: number }>();
  return (rows.results ?? []).map((row) =>
    `Free account ${row.user_id}: its Small stays free through a US view or turn-on from an ADE Cloud computer's network (AS${row.looked_asn}), not a phone or laptop. Block it: ${blockCommand(env, row.user_id, "small_cloud_look")}`);
}

/** The rate a computer of `size` runs at for this account: Small's is 0, or `SMALL_NO_CARDS_RATE_MILLI`. */
export const rateMilliFor = (size: Pick<CloudSize, "tier" | "multiplierMilli">, smallFree: boolean): number =>
  size.tier === "small" && !smallFree ? SMALL_NO_CARDS_RATE_MILLI : size.multiplierMilli;

/**
 * Puts the account's Small computers on the rate they run at now
 * (`rateMilliFor`): the time so far is charged at the old rate and the new
 * one starts there, as a resize does. Run after anything that changes the
 * answer (a yes or no, a test plan, a tester), and by the tick for every
 * account after a switch flips. The number of computers re-rated (only the
 * updates that wrote). `restore`: it follows a US look or yes over a yes whose
 * looks lapsed, so a move back to free counts as `small_restored`.
 */
export async function syncSmallRates(
  env: GravityEnv,
  account: AccountRow,
  now: number,
  { settings, waitUntil, restore = false }: { settings?: CloudSettings; waitUntil?: CloudWaitUntil; restore?: boolean } = {},
): Promise<number> {
  const why = await smallRule(env, account, settings, now);
  const smallFree = SMALL_FREE_WHYS.has(why);
  const rows = await env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null").bind(account.user_id).all<ComputerRow>();
  const statements: D1PreparedStatement[] = [];
  // Where each rate update sits in the batch: only the ones that wrote count as re-rated.
  const rateUpdates: number[] = [];
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
    rateUpdates.push(statements.length);
    statements.push(env.DB.prepare(`update cloud_computers set multiplier_milli = ? where instance_id = ? and multiplier_milli = ? and ${guard.sql}${yesSince}`)
      .bind(rate, computer.instance_id, computer.multiplier_milli, ...guard.binds, ...(smallFree ? [] : [freeLookSince(now)])));
    if (computer.awake_since != null && computer.awake_since <= now) statements.push(...restartStretchStatements(env, computer, now));
  }
  const results = statements.length ? await env.DB.batch(statements) : [];
  const changed = rateUpdates.filter((at) => (results[at]?.meta?.changes ?? 0) > 0).length;
  if (changed) logCloud("cloud.small_rate_synced", { userId: account.user_id, smallFree, why, changed });
  if (changed && why === "lapsed") captureCloudFreePlan(env, waitUntil, account.user_id, "small_lapsed", null, now);
  // Only a move that wrote, toward free: a no landing meanwhile moves Small the other way.
  if (changed && restore && smallFree) captureCloudFreePlan(env, waitUntil, account.user_id, "small_restored", null, now);
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
      where c.deleted_at is null and ${smallComputerSql("c")}
        and c.multiplier_milli != (case when
          not ${SHOWN_FREE_SQL}
          or not ${SWITCH_REACHES_SQL}
          or exists (select 1 from cloud_sponsored_consent s where s.user_id = a.user_id and s.consent = 'granted' and s.looked_at >= ?)
        then 0 else ? end)
      limit ?
    `).bind(SMALL_SHAPE.cpu, SMALL_SHAPE.memoryGb, mode, mode, freeLookSince(now), SMALL_NO_CARDS_RATE_MILLI, SMALL_SYNC_PAGE).all<{ user_id: string }>();
    const page = users.results ?? [];
    let pageChanged = 0;
    for (const { user_id: userId } of page) {
      const account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
      if (account) pageChanged += await syncSmallRates(env, account, now, { settings, waitUntil });
    }
    changed += pageChanged;
    // One page a tick; a forced sync pages on while rows still move and the budget lasts.
    if (!force || page.length < SMALL_SYNC_PAGE || pageChanged === 0 || Date.now() - started > SMALL_SYNC_BUDGET_MS) break;
  }
  return changed;
}
