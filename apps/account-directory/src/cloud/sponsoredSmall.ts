import type { CloudSponsoredState } from "./contract";
import type { GravityEnv } from "./gravity";
import { SMALL_NO_CARDS_RATE_MILLI, SMALL_SHAPE, cloudSizeFor, type CloudSize } from "./plans";
import { readCloudSettings, type CloudSettings } from "./settings";
import { readConsent, type ConsentRow, type SponsoredRequester } from "./sponsoredConsent";
import { gravitySwitches, switchReaches } from "./sponsoredSwitch";
import { logCloud, restartStretchStatements, shownPlanIdOf, statusGuard, type AccountRow, type ComputerRow } from "./store";

// Free's Small computers: unlimited with sponsored cards, in the US. Where
// the ad switch reaches a Free account, its Small computers use no credits
// only while it said yes to the cards and someone opened one of its ADE Cloud
// chats (or terminals) from the US in the last week; otherwise they run at
// `SMALL_NO_CARDS_RATE_MILLI`. `gravity.ts` saves the answers and the looks;
// this module decides the rate, puts computers on it and tells the clients.

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
  if (shownPlanIdOf(account) !== "free") return true;
  const { mode } = await gravitySwitches(env, settings ?? (await readCloudSettings(env)));
  if (!(await switchReaches(env, account, mode))) return true;
  return lookKeepsSmallFree(await readConsent(env, account.user_id), now);
}

/**
 * A look at one of the account's ADE Cloud chats or terminals found its yes
 * holding (`/cloud/sponsored/seen`). From the US it keeps Small free: saved at
 * most once an hour, only over the yes it read (a no saved meanwhile wins),
 * and never moved back by a slower request. Back from a lapse, Small is free
 * again from this look.
 */
export async function noteSmallLook(env: GravityEnv, account: AccountRow, consent: ConsentRow, country: string | null, now: number): Promise<void> {
  if (!smallFreeFrom(country)) return;
  if (consent.looked_at != null && now - consent.looked_at < LOOK_REFRESH_MS) return;
  await env.DB.prepare("update cloud_sponsored_consent set looked_at = max(coalesce(looked_at, 0), ?) where user_id = ? and consent = 'granted' and decided_at = ?")
    .bind(now, account.user_id, consent.decided_at).run();
  if (!lookKeepsSmallFree(consent, now)) await syncSmallRates(env, account, now);
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
export async function syncSmallRates(env: GravityEnv, account: AccountRow, now: number, settings?: CloudSettings): Promise<number> {
  const smallFree = await smallUsesNoHours(env, account, settings, now);
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
  if (changed) logCloud("cloud.small_rate_synced", { userId: account.user_id, smallFree, changed });
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
export async function syncAllSmallRates(env: GravityEnv, now: number, { force = false }: { force?: boolean } = {}): Promise<number> {
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
      if (account) pageChanged += await syncSmallRates(env, account, now, settings);
    }
    changed += pageChanged;
    // One page a tick; a forced sync pages on while rows still move and the budget lasts.
    if (!force || page.length < SMALL_SYNC_PAGE || pageChanged === 0 || Date.now() - started > SMALL_SYNC_BUDGET_MS) break;
  }
  return changed;
}
