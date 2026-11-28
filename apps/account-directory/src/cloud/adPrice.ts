import type { CloudWaitUntil } from "./analytics";
import { sendOwnerAlert } from "./blocks";
import { PHONE_CREDIT_MILLI_PER_MINUTE } from "./credits";
import {
  CLOUD_FULL_PRICE_WORK,
  CLOUD_PUBLIC_PRICING_PATH,
  type CloudPublicPricing,
  type CloudAdProofAnswer,
  type CloudAdsState,
  type CloudComputerActivityReport,
  type CloudComputerPrice,
  type CloudFullPriceReason,
  type CloudFullPriceWork,
  type CloudPrice,
  type CloudPricingState,
} from "./contract";
import { PLATFORM_URL, adsCountryHas, type GravityEnv } from "./gravity";
import { CREDIT_SCALE, EXTRA_HOUR_MICROS, SMALL_NO_CARDS_RATE_MILLI, SMALL_SHAPE, adRateMilli, cloudSizeFor, isMeteredStatus, utcDay, v3FullRateMilli, type V3CatalogTerms, type V3Rate } from "./plans";
import { readCloudSettings, settingChangedAt, type CloudSettings } from "./settings";
import { readConsent, sponsoredRequester, startsOnFor, yesHolds, type ConsentRow, type SponsoredRequester } from "./sponsoredConsent";
import { freeRuleCharges, smallLookUntil } from "./sponsoredSmall";
import { adTerms, gravitySwitches, pricingV3Mode, pricingV3Reaches, type PricingV3Mode, type SponsoredMode } from "./sponsoredSwitch";
import { logCloud, reportCloudFailure, restartStretchAtStatements, shownPlanIdOf, statusGuard, type AccountRow, type ComputerRow } from "./store";

/**
 * Pricing v3: the ad price (`docs/features/ade-cloud/README.md`, "Plans,
 * credits and sizes"). Account-wide, so the server decides it: for every
 * minute of every cloud computer and cloud iPhone, the full price or the ad
 * price. Behind the `pricing_v3` setting (`sponsoredSwitch.ts`); at `off`
 * nothing here writes, and every answer is today's.
 *
 * A computer has the ad price for a minute when all hold:
 * 1. ads are on for the account (a yes that held where the proof came from,
 *    and the notice seen), or the proof came from an ADE Free Models chat,
 *    whose ad shows with ads off;
 * 2. a proof for that computer is younger than `ad_window_minutes`: a person
 *    sent a message in one of its chats (`POST /cloud/sponsored/sent`), or a
 *    finished reply asked for an ad (`POST /cloud/sponsored/ad`, whatever
 *    Gravity answered). A proof counts only from a country with ads, from the
 *    account that pays for the computer, once per (account, chat, turn);
 * 3. its brain reports no full-price work while it is awake (an agent CLI
 *    session, an automation), and no outside agent sent it a message through
 *    the account server since its last idle report.
 *
 * The rate lives on the computer row (`multiplier_milli`) and the meter's
 * stretches charge it, as a resize does: this module is the one writer that
 * moves a computer between its full and ad rate. A proof or a report moves it
 * at once; the minute tick moves it back at the exact end of its window
 * (`restartStretchAtStatements`), so no minute is charged twice or lost. The
 * cloud iPhone, which bills by its provider's minutes, keeps the credits its
 * ad minutes took off on its row (`ad_saved_milli`).
 */

/** A row of `cloud_ad_targets` (migration 0073). */
export type AdTargetRow = {
  target: string;
  user_id: string;
  proof_at: number | null;
  fm_proof_at: number | null;
  unverified_at: number | null;
  full_work: string | null;
  full_work_at: number | null;
  /** An outside agent sent one of its chats a message through the account server (`chatMessages.ts`), or made it. */
  outside_at: number | null;
  /** The brain's first busy report after that message (its turn began); its next idle report ends the hold. */
  outside_busy_at: number | null;
};

/** What the rules read for one account, read once. */
export type AdContext = {
  /** Pricing v3 reaches the account. */
  v3: boolean;
  /** The ad switch (`gravity_ads`) reaches the account: ads can exist. */
  adsReach: boolean;
  /** Free's Small rule may charge it (`freeRuleCharges`). */
  freeRule: boolean;
  /** Ads are on: a yes and the notice seen. The country is checked where a proof comes from. */
  adsOn: boolean;
  discountPct: number;
  windowMs: number;
  /** When `ad_window_minutes` last changed: a window that ends before it ends there, never earlier (no charge back in time). */
  windowChangedAt: number;
  /**
   * Free's Small only: until when the account's last US look from an older
   * app keeps it free, as before Pricing v3 (`smallLookUntil`); null when none.
   * An older app sends no "sent" proof, so without this its Small would cost
   * more than today in the minutes before each first reply.
   */
  smallLookUntil: number | null;
};

const phoneTarget = (phoneId: string): string => `phone:${phoneId}`;

/* ---- The rates ---- */

/**
 * A computer's two rates, thousandths of a Medium-hour an hour. The one hook
 * every kind of computer goes through: Small on Free is 500 at the full price
 * and free with ads while the ad switch reaches the account (switch off:
 * free, as before Pricing v3); Small on a paid plan is free either way; the
 * other sizes are their v3 full rate and that less the discount. A shape the
 * catalog doesn't know keeps its row's rate at both prices.
 */
export function computerRatesMilli(computer: Pick<ComputerRow, "type" | "cpu" | "memory_gb" | "multiplier_milli" | "ad_full_milli">, ctx: Pick<AdContext, "adsReach" | "freeRule" | "discountPct">): V3Rate {
  const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  if (!size) {
    const full = computer.ad_full_milli ?? computer.multiplier_milli;
    return { fullMilli: full, adMilli: full };
  }
  if (size.tier === "small") return ctx.freeRule && ctx.adsReach ? { fullMilli: SMALL_NO_CARDS_RATE_MILLI, adMilli: 0 } : { fullMilli: 0, adMilli: 0 };
  const full = v3FullRateMilli(size.multiplierMilli);
  return { fullMilli: full, adMilli: adRateMilli(full, ctx.discountPct) };
}

/** Small's full rate an hour under `ctx` (500 on Free while the ad switch reaches it, else 0): the catalog's, and the website's. */
const smallFullMilli = (ctx: Pick<AdContext, "adsReach" | "freeRule" | "discountPct">): number =>
  computerRatesMilli({ type: "default", cpu: SMALL_SHAPE.cpu, memory_gb: SMALL_SHAPE.memoryGb, multiplier_milli: 0, ad_full_milli: null }, ctx).fullMilli;

/**
 * The iPhone's two rates a minute: its row's `rate_milli` (set at its start
 * under Pricing v3) and that less the discount. A phone started before (null)
 * keeps the rate it bills, 1,000, with no ad price, until it ends.
 */
export function phoneRatesMilli(rateMilli: number | null, discountPct: number): V3Rate {
  if (rateMilli == null) return { fullMilli: PHONE_CREDIT_MILLI_PER_MINUTE, adMilli: PHONE_CREDIT_MILLI_PER_MINUTE };
  return { fullMilli: rateMilli, adMilli: adRateMilli(rateMilli, discountPct) };
}

/* ---- The decision ---- */

/** The full-price work a brain reported, as stored: known kinds only, each once. */
export function readFullPriceWork(value: unknown): CloudFullPriceWork[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return CLOUD_FULL_PRICE_WORK.filter((kind) => list.includes(kind));
}

/** An outside agent's message holds the full price at most this long with no idle report (a brain that never sent one). */
const OUTSIDE_AGENT_HOLD_MS = 6 * 60 * 60_000;
/** An outside agent's message whose turn never began (no busy report since) holds the full price this long. */
export const OUTSIDE_AGENT_NO_TURN_MS = 30 * 60_000;

export type PriceDecision = { now: "ad" | "full"; reason: CloudFullPriceReason | null; adUntil: number | null };

type DecisionTarget = Pick<AdTargetRow, "proof_at" | "fm_proof_at" | "unverified_at" | "full_work" | "outside_at" | "outside_busy_at">;

/** Pure: an outside agent's message still holds the full price (its turn runs, or may yet begin). */
const outsideHolds = (target: DecisionTarget | null, now: number): boolean =>
  target?.outside_at != null && now - target.outside_at < OUTSIDE_AGENT_HOLD_MS && (target.outside_busy_at != null || now - target.outside_at < OUTSIDE_AGENT_NO_TURN_MS);

/**
 * Pure: the newest proof that counts under `ctx` (ads on: any; ads off: only
 * a free-model chat's), and when its window ends (or, for Free's Small under
 * an older app, its look), or nulls with none.
 */
function adWindow(target: DecisionTarget | null, ctx: AdContext, smallLook: boolean): { proof: number | null; until: number | null } {
  const ads = ctx.adsOn && ctx.adsReach;
  const proof = Math.max(ads ? target?.proof_at ?? -Infinity : -Infinity, target?.fm_proof_at ?? -Infinity);
  const until = Math.max(Number.isFinite(proof) ? proof + ctx.windowMs : -Infinity, smallLook && ads ? ctx.smallLookUntil ?? -Infinity : -Infinity);
  return { proof: Number.isFinite(proof) ? proof : null, until: Number.isFinite(until) ? until : null };
}

/**
 * Pure: the price of one computer or phone at `now`. `awakeSince`: non-null
 * while the computer is awake, when its brain's reports count (null: a phone,
 * or a resting computer).
 */
export function decidePrice(
  target: DecisionTarget | null,
  ctx: AdContext,
  awakeSince: number | null,
  now: number,
  { smallLook = false }: { smallLook?: boolean } = {},
): PriceDecision {
  const { proof, until } = adWindow(target, ctx, smallLook);
  const live = until != null && until > now;
  // Ads off and no Free Models chat holding it: nothing else matters.
  if (!live && !(ctx.adsOn && ctx.adsReach)) return { now: "full", reason: "ads_off", adUntil: null };
  // The brain's last report, while the computer is awake: it reports again after every wake, and the
  // computer's sleep clears it (`statusChangeStatements`). Not the stretch, which every rate move restarts.
  const work = awakeSince != null ? readFullPriceWork(target?.full_work ?? null) : [];
  if (work.length) return { now: "full", reason: work[0]!, adUntil: null };
  // An outside agent's message (or computer) through the account server: until the brain's idle report
  // after the turn it began, whatever order other reports came in (`noteActivityReport`).
  if (awakeSince != null && outsideHolds(target, now)) return { now: "full", reason: "outside_agent", adUntil: null };
  if (live) return { now: "ad", reason: null, adUntil: until };
  const unverified = target?.unverified_at != null && target.unverified_at >= (proof ?? 0) && target.unverified_at + ctx.windowMs > now;
  return { now: "full", reason: unverified ? "unverified" : "not_in_use", adUntil: null };
}

/**
 * Pure: where a move from the ad price back to the full price starts. At the
 * end of the window when that is why (never before the window setting last
 * changed, nor before the stretch began); now for any other reason.
 */
export function fullPriceEdge(previousAdUntil: number | null, ctx: Pick<AdContext, "windowChangedAt">, awakeSince: number, now: number): number {
  if (previousAdUntil == null) return now;
  return Math.min(now, Math.max(previousAdUntil, ctx.windowChangedAt, awakeSince));
}

/* ---- Reading what the rules need ---- */

export type PricingSwitches = { mode: PricingV3Mode; adsMode: SponsoredMode; discountPct: number; windowMs: number; windowChangedAt: number };

export async function pricingSwitches(env: GravityEnv, settings?: CloudSettings): Promise<PricingSwitches> {
  const read = settings ?? (await readCloudSettings(env));
  const [mode, ads, changed] = await Promise.all([pricingV3Mode(env, read), gravitySwitches(env, read), settingChangedAt(env, "ad_window_minutes")]);
  const terms = adTerms(read);
  return { mode, adsMode: ads.mode, discountPct: terms.discountPct, windowMs: terms.windowMinutes * 60_000, windowChangedAt: changed ?? 0 };
}

/** The tester list for these accounts: one read. */
async function testersAmong(env: GravityEnv, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await env.DB.prepare("select user_id from cloud_sponsored_testers where user_id in (select value from json_each(?))")
    .bind(JSON.stringify(userIds)).all<{ user_id: string }>();
  return new Set((rows.results ?? []).map((row) => row.user_id));
}

const reaches = (mode: string, tester: boolean): boolean => mode === "all" || (mode === "testers" && tester);

/**
 * Whether ads are on for the price: a yes, and the notice seen. On Free a yes
 * given before Pricing v3 (to the Free plan's own ads question or notice)
 * counts as seen, so an older app on Free keeps its ads. Where the proof came
 * from was checked when it came.
 */
export const adsOnOf = (consent: Pick<ConsentRow, "consent" | "notice_seen_at"> | null, account: Pick<AccountRow, "plan" | "paid_plan">): boolean =>
  consent?.consent === "granted" && (consent.notice_seen_at != null || shownPlanIdOf(account) === "free");

type ContextConsent = Pick<ConsentRow, "consent" | "notice_seen_at" | "looked_at">;

function contextOf(switches: PricingSwitches, account: AccountRow, tester: boolean, consent: ContextConsent | null): AdContext {
  return {
    v3: reaches(switches.mode, tester),
    adsReach: reaches(switches.adsMode, tester),
    freeRule: freeRuleCharges(account),
    adsOn: adsOnOf(consent, account),
    discountPct: switches.discountPct,
    windowMs: switches.windowMs,
    windowChangedAt: switches.windowChangedAt,
    smallLookUntil: freeRuleCharges(account) ? smallLookUntil(consent) : null,
  };
}

/** Whether a computer is Free's Small that charges (500 full, free with ads): the older apps' look keeps it free. */
const isChargedSmall = (rates: V3Rate): boolean => rates.adMilli === 0 && rates.fullMilli > 0;

/** One account's `AdContext`. */
export async function adContextFor(env: GravityEnv, account: AccountRow, switches?: PricingSwitches): Promise<{ ctx: AdContext; consent: ConsentRow | null }> {
  const read = switches ?? (await pricingSwitches(env));
  const [testers, consent] = await Promise.all([testersAmong(env, [account.user_id]), readConsent(env, account.user_id)]);
  return { ctx: contextOf(read, account, testers.has(account.user_id), consent), consent };
}

async function targetsOf(env: GravityEnv, targets: readonly string[]): Promise<Map<string, AdTargetRow>> {
  if (targets.length === 0) return new Map();
  const rows = await env.DB.prepare("select target, user_id, proof_at, fm_proof_at, unverified_at, full_work, full_work_at, outside_at, outside_busy_at from cloud_ad_targets where target in (select value from json_each(?))")
    .bind(JSON.stringify(targets)).all<AdTargetRow>();
  return new Map((rows.results ?? []).map((row) => [row.target, row]));
}

/* ---- Moving a computer between its rates ---- */

/**
 * The rate a computer runs at outside Pricing v3: its size's own; Small by
 * today's Free rule (`sponsoredSmall.ts` `smallRule`: free off Free, while the
 * ad switch doesn't reach the account, or with a recent US look), so leaving
 * Pricing v3 never charges a minute that rule keeps free.
 */
function v2RateMilli(computer: ComputerRow, ctx: AdContext, now: number): number {
  const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  if (!size) return computer.ad_full_milli ?? computer.multiplier_milli;
  if (size.tier !== "small") return size.multiplierMilli;
  const free = !ctx.freeRule || !ctx.adsReach || (ctx.smallLookUntil != null && ctx.smallLookUntil >= now);
  return free ? 0 : SMALL_NO_CARDS_RATE_MILLI;
}

/**
 * The statements that put a computer on `rate` (with `adFull`, its full rate
 * while at the ad price, or null), its stretch so far charged at the rate it
 * ran at up to `edge`. The new rate first, held to the row as read; then the
 * stretch restarts, so a race leaves the row on its old rate, charged once.
 * Empty when it is already there.
 */
export function rateMoveStatements(env: GravityEnv, computer: ComputerRow, rate: number, adFull: number | null, edge: number, proofsRead?: Pick<AdTargetRow, "proof_at" | "fm_proof_at"> | null): D1PreparedStatement[] {
  if (computer.multiplier_milli === rate && (computer.ad_full_milli ?? null) === adFull) return [];
  const guard = statusGuard(computer);
  // `proofsRead`: a move off the ad price holds only while no newer proof came in since they were read
  // (a proof landing between the tick's read and its write keeps the ad price).
  const noNewProof = proofsRead === undefined ? "" : " and not exists (select 1 from cloud_ad_targets where target = ? and (coalesce(proof_at, 0) > ? or coalesce(fm_proof_at, 0) > ?))";
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`update cloud_computers set multiplier_milli = ?, ad_full_milli = ? where instance_id = ? and multiplier_milli = ? and ad_full_milli is ? and ${guard.sql}${noNewProof}`)
      .bind(rate, adFull, computer.instance_id, computer.multiplier_milli, computer.ad_full_milli ?? null, ...guard.binds,
        ...(proofsRead === undefined ? [] : [computer.instance_id, proofsRead?.proof_at ?? 0, proofsRead?.fm_proof_at ?? 0])),
  ];
  const running = computer.awake_since != null && isMeteredStatus(computer.status);
  if (running) statements.push(...restartStretchAtStatements(env, computer, Math.max(computer.awake_since!, edge)));
  computer.multiplier_milli = rate;
  computer.ad_full_milli = adFull;
  return statements;
}

/**
 * Pure-ish: the move one computer needs now under `ctx`, given its target
 * row. Outside Pricing v3 a computer on an ad rate (or on a v3 full rate that
 * differs from its size's) goes back to its size's own rate.
 */
export function computerPriceStatements(env: GravityEnv, computer: ComputerRow, target: AdTargetRow | null, ctx: AdContext, now: number): D1PreparedStatement[] {
  const rates = computerRatesMilli(computer, ctx);
  // Off the ad price: from the end of its window when that ended (whatever the reason now: no use,
  // ads off after a free-model chat's window, the switch), else now (work begun, ads turned off).
  const offAd = (rate: number) => {
    const until = adWindow(target, ctx, isChargedSmall(rates)).until;
    const edge = computer.awake_since != null && until != null && until <= now ? fullPriceEdge(until, ctx, computer.awake_since, now) : now;
    return rateMoveStatements(env, computer, rate, null, edge, target);
  };
  if (!ctx.v3) {
    const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
    const v3Full = size && size.tier !== "small" && computer.multiplier_milli === v3FullRateMilli(size.multiplierMilli) && computer.multiplier_milli !== size.multiplierMilli;
    if (computer.ad_full_milli == null && !v3Full) return [];
    return computer.ad_full_milli != null ? offAd(v2RateMilli(computer, ctx, now)) : rateMoveStatements(env, computer, v2RateMilli(computer, ctx, now), null, now);
  }
  const decision = decidePrice(target, ctx, computer.awake_since, now, { smallLook: isChargedSmall(rates) });
  if (decision.now === "ad") return rateMoveStatements(env, computer, rates.adMilli, rates.fullMilli, now);
  const work = decision.reason === "cli_session" || decision.reason === "automation" || decision.reason === "outside_agent";
  return computer.ad_full_milli != null && !work ? offAd(rates.fullMilli) : rateMoveStatements(env, computer, rates.fullMilli, null, now);
}

/**
 * Puts every computer of the account on the rate its price says now (a
 * consent change, a proof, a report). Never fails the caller.
 */
export async function syncAccountPrices(env: GravityEnv, account: AccountRow, now: number, { instanceIds }: { instanceIds?: readonly string[] } = {}): Promise<number> {
  try {
    const { ctx } = await adContextFor(env, account);
    const rows = await env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null").bind(account.user_id).all<ComputerRow>();
    const computers = (rows.results ?? []).filter((computer) => !instanceIds || instanceIds.includes(computer.instance_id));
    if (!ctx.v3 && !computers.some((computer) => computer.ad_full_milli != null)) return 0;
    const targets = await targetsOf(env, computers.map((computer) => computer.instance_id));
    const statements = computers.flatMap((computer) => computerPriceStatements(env, computer, targets.get(computer.instance_id) ?? null, ctx, now));
    if (statements.length) await env.DB.batch(statements);
    const phones = ctx.v3 ? await syncPhonePrices(env, [account.user_id], new Map([[account.user_id, ctx]]), now) : 0;
    return statements.length + phones;
  } catch (error) {
    reportCloudFailure("cloud.ad_price.sync_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}

/**
 * The minute tick: the computers it read (`cron.ts`), each running one put on
 * the rate its price says now; a window that ended moves back at its exact
 * end. At `off`, only a computer still on an ad rate (or a v3 full rate) goes
 * back, so the read is the tick's own and nothing else runs.
 */
export async function syncAdPricesInTick(env: GravityEnv, tickRows: ComputerRow[], now: number): Promise<void> {
  try {
    const switches = await pricingSwitches(env);
    // The rows as the tick's own status changes left them: a computer it just woke is awake now.
    const computers = switches.mode === "off" || tickRows.length === 0 ? tickRows
      : (await env.DB.prepare("select * from cloud_computers where deleted_at is null and instance_id in (select value from json_each(?))")
        .bind(JSON.stringify(tickRows.map((computer) => computer.instance_id))).all<ComputerRow>()).results ?? [];
    const running = computers.filter((computer) => computer.awake_since != null && isMeteredStatus(computer.status));
    const candidates = switches.mode === "off"
      ? computers.filter((computer) => computer.ad_full_milli != null || isV3OnlyRate(computer))
      : [...new Set([...running, ...computers.filter((computer) => computer.ad_full_milli != null)])];
    const userIds = [...new Set(candidates.map((computer) => computer.user_id))];
    const ctxs = await contextsFor(env, switches, userIds);
    const targets = await targetsOf(env, candidates.map((computer) => computer.instance_id));
    const moved: string[] = [];
    const statements = candidates.flatMap((computer) => {
      const ctx = ctxs.get(computer.user_id);
      const move = ctx ? computerPriceStatements(env, computer, targets.get(computer.instance_id) ?? null, ctx, now) : [];
      if (move.length) moved.push(computer.instance_id);
      return move;
    });
    if (statements.length === 0) return;
    await env.DB.batch(statements);
    // The rest of the tick (the settle, the zero stop, the daily settle) reads the rows it passed in:
    // each moved one gets its rate and stretch as written (a guarded move a race refused keeps the old).
    const fresh = await env.DB.prepare("select instance_id, multiplier_milli, ad_full_milli, awake_since from cloud_computers where instance_id in (select value from json_each(?))")
      .bind(JSON.stringify(moved)).all<Pick<ComputerRow, "instance_id" | "multiplier_milli" | "ad_full_milli" | "awake_since">>();
    const byId = new Map((fresh.results ?? []).map((row) => [row.instance_id, row]));
    for (const row of tickRows) {
      const written = byId.get(row.instance_id);
      if (written) Object.assign(row, { multiplier_milli: written.multiplier_milli, ad_full_milli: written.ad_full_milli, awake_since: written.awake_since });
    }
  } catch (error) {
    reportCloudFailure("cloud.ad_price.tick_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * The minute tick's cloud iPhones (`cron.ts`, whatever the computers' part
 * does): each live one on its price now. At `off`, a phone's running ad
 * minutes stop (the minute begun at its last move is in already), so turning
 * Pricing v3 back on never counts the time between: one write that matches
 * nothing after.
 */
export async function syncPhonePricesInTick(env: GravityEnv, now: number): Promise<void> {
  try {
    const switches = await pricingSwitches(env);
    if (switches.mode !== "off") await syncPhonePrices(env, null, null, now, switches);
    else await env.DB.prepare("update cloud_phones set ad_mark_at = null where ad_mark_at is not null").run();
  } catch (error) {
    reportCloudFailure("cloud.ad_price.phone_tick_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

const isV3OnlyRate = (computer: ComputerRow): boolean => {
  const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
  return Boolean(size && size.tier !== "small" && computer.multiplier_milli !== size.multiplierMilli && computer.multiplier_milli === v3FullRateMilli(size.multiplierMilli));
};

async function contextsFor(env: GravityEnv, switches: PricingSwitches, userIds: readonly string[]): Promise<Map<string, AdContext>> {
  if (userIds.length === 0) return new Map();
  const json = JSON.stringify(userIds);
  const [accounts, consents, testers] = await Promise.all([
    env.DB.prepare("select * from cloud_accounts where user_id in (select value from json_each(?))").bind(json).all<AccountRow>(),
    env.DB.prepare("select user_id, consent, notice_seen_at, looked_at from cloud_sponsored_consent where user_id in (select value from json_each(?))").bind(json).all<{ user_id: string; consent: ConsentRow["consent"]; notice_seen_at: number | null; looked_at: number | null }>(),
    testersAmong(env, userIds),
  ]);
  const consentBy = new Map((consents.results ?? []).map((row) => [row.user_id, row]));
  return new Map((accounts.results ?? []).map((account) => [account.user_id, contextOf(switches, account, testers.has(account.user_id), consentBy.get(account.user_id) ?? null)]));
}

/* ---- The cloud iPhone ---- */

type PhonePriceRow = { phone_id: string; user_id: string; rate_milli: number | null; ad_mark_at: number | null; ad_saved_milli: number };

/**
 * The live v3 phones (`rate_milli` set) of these accounts (null: all), each
 * on its price now. Ad minutes go into `ad_saved_milli` a whole minute at a
 * time from `ad_mark_at`; a window that ended stops them at its end. One
 * write per phone that moved.
 */
async function syncPhonePrices(env: GravityEnv, userIds: readonly string[] | null, known: Map<string, AdContext> | null, now: number, switches?: PricingSwitches): Promise<number> {
  const rows = await env.DB.prepare(`select phone_id, user_id, rate_milli, ad_mark_at, ad_saved_milli from cloud_phones where state = 'live' and credits = 1 and rate_milli is not null${userIds ? " and user_id in (select value from json_each(?))" : ""}`)
    .bind(...(userIds ? [JSON.stringify(userIds)] : [])).all<PhonePriceRow>();
  const phones = rows.results ?? [];
  if (phones.length === 0) return 0;
  const ctxs = known ?? (await contextsFor(env, switches ?? (await pricingSwitches(env)), [...new Set(phones.map((phone) => phone.user_id))]));
  const targets = await targetsOf(env, phones.map((phone) => phoneTarget(phone.phone_id)));
  const statements: D1PreparedStatement[] = [];
  for (const phone of phones) {
    const ctx = ctxs.get(phone.user_id);
    if (!ctx) continue;
    const move = phoneMoveAt(phone, targets.get(phoneTarget(phone.phone_id)) ?? null, ctx, now);
    if (!move) continue;
    statements.push(env.DB.prepare("update cloud_phones set ad_saved_milli = ad_saved_milli + ?, ad_mark_at = ? where phone_id = ? and state = 'live' and ad_mark_at is ?")
      .bind(move.addMilli, move.markAt, phone.phone_id, phone.ad_mark_at));
  }
  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

/**
 * Pure: `phoneAdMove` for one phone on the price it has at `at`. Pricing v3
 * no longer reaching it: the mark clears with nothing more (the minute begun
 * at the last move is in already; after it, the full price).
 */
function phoneMoveAt(phone: PhonePriceRow, target: AdTargetRow | null, ctx: AdContext, at: number): { addMilli: number; markAt: number | null } | null {
  if (!ctx.v3) return phone.ad_mark_at == null ? null : { addMilli: 0, markAt: null };
  const decision = decidePrice(target, ctx, null, at);
  return phoneAdMove(phone, decision, phoneRatesMilli(phone.rate_milli, ctx.discountPct), adWindow(target, ctx, false).until, ctx, at);
}

/**
 * A phone that ended (`phones.ts`, before its final charge, which never
 * shrinks after): the minutes it began at the ad price since its last move go
 * in, up to its end, and its mark clears. Pricing v3 off since: up to the
 * mark only. Nothing without a mark. Never fails the caller.
 */
export async function settlePhoneAtEnd(env: GravityEnv, phoneId: string, endedAt: number): Promise<void> {
  try {
    const phone = await env.DB.prepare("select phone_id, user_id, rate_milli, ad_mark_at, ad_saved_milli from cloud_phones where phone_id = ? and ad_mark_at is not null")
      .bind(phoneId).first<PhonePriceRow>();
    if (!phone) return;
    const ctx = (await contextsFor(env, await pricingSwitches(env), [phone.user_id])).get(phone.user_id);
    const move = ctx ? phoneMoveAt(phone, (await targetsOf(env, [phoneTarget(phoneId)])).get(phoneTarget(phoneId)) ?? null, ctx, endedAt) : null;
    await env.DB.prepare("update cloud_phones set ad_saved_milli = ad_saved_milli + ?, ad_mark_at = null where phone_id = ? and ad_mark_at is ?")
      .bind(move?.addMilli ?? 0, phoneId, phone.ad_mark_at).run();
  } catch (error) {
    reportCloudFailure("cloud.ad_price.phone_end_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * Pure: a phone's ad minutes. The phone bills every minute it began, so a
 * minute begun at the ad price is taken off whole: `ad_mark_at` is where the
 * minutes already taken off end. On the ad price the minutes begun since the
 * mark go in and the mark moves past them (no mark: the minute begun now).
 * Back on the full price, the minutes begun before the window's end go in and
 * the mark clears. Null when nothing changes.
 */
export function phoneAdMove(phone: Pick<PhonePriceRow, "ad_mark_at">, decision: PriceDecision, rates: V3Rate, adUntil: number | null, ctx: Pick<AdContext, "windowChangedAt">, now: number): { addMilli: number; markAt: number | null } | null {
  const perMinute = Math.max(0, rates.fullMilli - rates.adMilli);
  const begun = (from: number, to: number) => (to > from ? Math.ceil((to - from) / 60_000) : 0);
  if (decision.now === "ad") {
    if (phone.ad_mark_at == null) return { addMilli: perMinute, markAt: now + 60_000 };
    const minutes = begun(phone.ad_mark_at, now);
    return minutes > 0 ? { addMilli: minutes * perMinute, markAt: phone.ad_mark_at + minutes * 60_000 } : null;
  }
  if (phone.ad_mark_at == null) return null;
  // Up to the window's end when it ended (whatever the reason now), else now.
  const end = adUntil != null && adUntil <= now ? fullPriceEdge(adUntil, ctx, phone.ad_mark_at, now) : now;
  return { addMilli: begun(phone.ad_mark_at, end) * perMinute, markAt: null };
}

/* ---- Proofs ---- */

/** How long a network an ADE Cloud computer joined from stays ADE Cloud's own (as the Small tripwire reads it). */
const JOINED_NETWORK_MS = 30 * 24 * 60 * 60_000;
/** The owner hears of one account's requests that don't count at most once a week. */
const UNVERIFIED_ALERT_MS = 7 * 24 * 60 * 60_000;

/**
 * Where a request's network is: `own`, the network of one of the account's
 * own cloud computers (the one its brain calls from, or one it joined from
 * lately), so not a person at a screen: the proof doesn't count. `cloud`,
 * DAEX Cloud's network but none of the account's computers (a VPN or an
 * office proxy there): it counts, and the owner hears of it. Null otherwise,
 * or with no network data.
 */
export async function cloudNetworkOf(env: GravityEnv, userId: string, asn: number | null, now: number): Promise<"own" | "cloud" | null> {
  if (asn == null) return null;
  const joined = now - JOINED_NETWORK_MS;
  const row = await env.DB.prepare(`
    select exists (select 1 from cloud_computers where user_id = ? and ((deleted_at is null and net_asn = ?) or (join_asn = ? and created_at >= ?))) as own,
      exists (select 1 from cloud_computers where (deleted_at is null and net_asn = ?) or (join_asn = ? and created_at >= ?)) as cloud
  `).bind(userId, asn, asn, joined, asn, asn, joined).first<{ own: number; cloud: number }>();
  return row?.own ? "own" : row?.cloud ? "cloud" : null;
}

/** A proof that counted from DAEX Cloud's network (`cloudNetworkOf` `cloud`): the owner hears of it once a week per account. */
export async function noteCloudNetworkProof(env: GravityEnv, account: AccountRow, asn: number | null, now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  try {
    logCloud("cloud.ad_price.cloud_network", { userId: account.user_id, asn });
    await sendOwnerAlert(env, {
      key: `ad_cloud_network:${account.user_id}:${Math.floor(now / UNVERIFIED_ALERT_MS)}`,
      kind: "ad_cloud_network",
      userId: account.user_id,
      subject: "DAEX Cloud: an ad-price proof came from the DAEX Cloud provider's network",
      reason: "A request that keeps this account's cloud computer at the ad price came from the network DAEX Cloud computers use, though not from one of this account's computers (a VPN or an office proxy there, say). It counted. Nothing was blocked.",
      counts: { Network: asn != null ? `AS${asn}` : "unknown" },
      step: "ad_cloud_network",
      abuse: true,
    }, now, waitUntil);
  } catch (error) {
    reportCloudFailure("cloud.ad_price.cloud_network_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

export type ProofTargets = { instanceId: string | null; phoneId: string | null };

/** What a computer's or phone's product is, for the owner's counts. */
const productOf = (targets: ProofTargets, freeModel: boolean): string => (targets.phoneId ? "phone" : freeModel && !targets.instanceId ? "free_model" : "linux");

/**
 * A request that doesn't count (`cloudNetworkOf` `own`): marked on its
 * targets so their price row says why, and the owner hears of it once a week
 * per account. No ban, no penalty.
 */
export async function noteUnverified(env: GravityEnv, account: AccountRow, targets: ProofTargets, asn: number | null, now: number, waitUntil?: CloudWaitUntil): Promise<void> {
  try {
    const keys = targetKeys(targets);
    if (keys.length) {
      await env.DB.batch(keys.map((key) => env.DB.prepare(`
        insert into cloud_ad_targets (target, user_id, unverified_at, updated_at) values (?, ?, ?, ?)
        on conflict (target) do update set unverified_at = max(coalesce(unverified_at, 0), excluded.unverified_at), updated_at = excluded.updated_at
      `).bind(key, account.user_id, now, now)));
    }
    logCloud("cloud.ad_price.unverified", { userId: account.user_id, asn });
    await sendOwnerAlert(env, {
      key: `ad_cloud_request:${account.user_id}:${Math.floor(now / UNVERIFIED_ALERT_MS)}`,
      kind: "ad_cloud_request",
      userId: account.user_id,
      subject: "DAEX Cloud: an ad-price request came from a DAEX Cloud computer's network",
      reason: "A request that would keep this account's cloud computer at the ad price came from the network of one of this account's own DAEX Cloud computers, not from a phone or laptop. It did not count: no proof, nothing sent to the ad partner, and the computer has the full price. Nothing was blocked.",
      counts: { Network: asn != null ? `AS${asn}` : "unknown" },
      step: "ad_cloud_request",
      abuse: true,
    }, now, waitUntil);
  } catch (error) {
    reportCloudFailure("cloud.ad_price.unverified_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

const targetKeys = (targets: ProofTargets): string[] => [
  ...(targets.instanceId ? [targets.instanceId] : []),
  ...(targets.phoneId ? [phoneTarget(targets.phoneId)] : []),
];

/**
 * Counts one proof, once per (account, chat, turn): its targets' window
 * starts again, and the computer or phone moves to the ad price now if its
 * rules allow. `freeModel`: it came from an ADE Free Models chat, whose ad
 * shows with ads off, so it holds with ads off. The caller checked the
 * targets are the account's own, the country, and the network.
 */
export async function countAdProof(
  env: GravityEnv,
  account: AccountRow,
  proof: { chatId: string; turnId: string; kind: "reply" | "sent"; freeModel: boolean; targetAt?: number } & ProofTargets,
  now: number,
): Promise<CloudAdProofAnswer> {
  const keys = targetKeys(proof);
  // A free-model chat on the person's own machine prices nothing, but counts for the owner's report.
  if (keys.length === 0 && !proof.freeModel) return { counted: false, reason: "not_cloud" };
  const column = proof.freeModel ? "fm_proof_at" : "proof_at";
  // Pruned by `pruneSponsored` (`sponsoredReport.ts`), never here.
  const [claimed] = await env.DB.batch([
    env.DB.prepare(`
      insert into cloud_ad_proofs (user_id, chat_id, turn_id, kind, instance_id, phone_id, at) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (user_id, chat_id, turn_id) do nothing
    `).bind(account.user_id, proof.chatId, proof.turnId, proof.kind, proof.instanceId, proof.phoneId, now),
    countProofStatement(env, utcDay(now), `${proof.kind === "reply" ? "proof" : "sent"}:${productOf(proof, proof.freeModel)}`, account.user_id, proof.chatId, proof.turnId, now),
  ]);
  // A replay of the same turn moves nothing.
  if (!claimed?.meta?.changes) return { counted: false, reason: "repeat" };
  if (keys.length === 0) return { counted: true };
  // A window that ended since the last tick goes back to the full price at its end first: the new
  // proof would otherwise hide that gap (the computer still on its ad rate, the phone's mark old).
  const scope = { instanceIds: proof.instanceId ? [proof.instanceId] : [] };
  await syncAccountPrices(env, account, now, scope);
  await env.DB.batch(keys.map((key) => env.DB.prepare(`
    insert into cloud_ad_targets (target, user_id, ${column}, updated_at) values (?, ?, ?, ?)
    on conflict (target) do update set ${column} = max(coalesce(${column}, 0), excluded.${column}), updated_at = excluded.updated_at
  `).bind(key, account.user_id, proof.targetAt ?? now, now)));
  await syncAccountPrices(env, account, now, scope);
  return { counted: true };
}

/** The day's count of proofs by product (`proof:<product>` for replies, `sent:<product>` for messages), for the owner's report: added only with the proof's own row. */
function countProofStatement(env: GravityEnv, day: string, kind: string, userId: string, chatId: string, turnId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(`
    insert into cloud_sponsored_days (day, user_id, kind, count)
    select ?, '*', ?, 1 where exists (select 1 from cloud_ad_proofs where user_id = ? and chat_id = ? and turn_id = ? and at = ?)
    on conflict (day, user_id, kind) do update set count = count + 1
  `).bind(day, kind, userId, chatId, turnId, now);
}

/* ---- The brain's full-price work ---- */

/** Whether Pricing v3 reaches this account now: at `off` (and for others at `testers`) nothing new is kept. */
async function v3Reaches(env: GravityEnv, userId: string): Promise<boolean> {
  return pricingV3Reaches(env, userId, await pricingV3Mode(env));
}

/**
 * The newest activity report of a computer's brain (`POST .../activity`, one
 * sent late never comes here): the full-price work it names, and the turn of
 * an outside agent's message. A busy report after that message means its turn
 * began; the idle report after it ends the hold. Moves the computer to the
 * price it now has. Never fails the report.
 */
export async function noteActivityReport(env: GravityEnv, computer: ComputerRow, report: Pick<CloudComputerActivityReport, "busy" | "fullPriceWork">, now: number): Promise<void> {
  try {
    const work = report.fullPriceWork ?? [];
    // None (an older brain leaves the field out, which means none too) only clears what was kept, and
    // never adds a row. Work is kept only while Pricing v3 reaches the account: nothing kept at `off`
    // turns into a price when it comes on (the brain reports again on its next change).
    const keep = work.length > 0 && (await v3Reaches(env, computer.user_id));
    const statements = [
      keep
        ? env.DB.prepare(`
          insert into cloud_ad_targets (target, user_id, full_work, full_work_at, updated_at) values (?, ?, ?, ?, ?)
          on conflict (target) do update set full_work = excluded.full_work, full_work_at = excluded.full_work_at, updated_at = excluded.updated_at
            where coalesce(cloud_ad_targets.full_work, '[]') <> excluded.full_work
        `).bind(computer.instance_id, computer.user_id, JSON.stringify(work), now, now)
        : env.DB.prepare("update cloud_ad_targets set full_work = '[]', full_work_at = ?, updated_at = ? where target = ? and coalesce(full_work, '[]') <> '[]'")
          .bind(now, now, computer.instance_id),
      report.busy
        ? env.DB.prepare("update cloud_ad_targets set outside_busy_at = ? where target = ? and outside_at is not null and outside_busy_at is null").bind(now, computer.instance_id)
        : env.DB.prepare("update cloud_ad_targets set outside_at = null, outside_busy_at = null, updated_at = ? where target = ? and outside_busy_at is not null").bind(now, computer.instance_id),
    ];
    const [worked, turned] = await env.DB.batch(statements);
    // A turn that began changes no price; its end, or new work, does.
    if (worked?.meta?.changes || (!report.busy && turned?.meta?.changes)) await syncComputerPrice(env, computer, now);
  } catch (error) {
    reportCloudFailure("cloud.ad_price.work_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * An outside agent (ADE MCP) sent a message to a chat on this computer
 * through the account server (`origin: "mcp"`), or made the computer: the
 * full price until the brain's idle report after the turn it starts
 * (`noteActivityReport`), or `OUTSIDE_AGENT_NO_TURN_MS` with no turn at all.
 * Nothing while Pricing v3 doesn't reach the account. Never fails the caller.
 */
export async function noteOutsideAgentWork(env: GravityEnv, computer: Pick<ComputerRow, "instance_id" | "user_id">, now: number): Promise<void> {
  try {
    if (!(await v3Reaches(env, computer.user_id))) return;
    await env.DB.prepare(`
      insert into cloud_ad_targets (target, user_id, outside_at, outside_busy_at, updated_at) values (?, ?, ?, null, ?)
      on conflict (target) do update set outside_at = excluded.outside_at, outside_busy_at = null, updated_at = excluded.updated_at
    `).bind(computer.instance_id, computer.user_id, now, now).run();
    await syncComputerPrice(env, computer, now);
  } catch (error) {
    reportCloudFailure("cloud.ad_price.outside_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

/** One computer on the price it has now, after its brain, an outside agent or a resize changed what decides it. */
export async function syncComputerPrice(env: GravityEnv, computer: Pick<ComputerRow, "instance_id" | "user_id">, now: number): Promise<void> {
  const account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(computer.user_id).first<AccountRow>();
  if (account) await syncAccountPrices(env, account, now, { instanceIds: [computer.instance_id] });
}

/**
 * The rate `computer` would wake at now under Pricing v3 (asleep, so its
 * brain's work doesn't count), for the 0-credit check (`routes.ts`
 * `wakeBlocker`), or null while Pricing v3 doesn't reach the account.
 */
export async function wakeRateMilli(env: GravityEnv, account: AccountRow, computer: ComputerRow, now: number): Promise<number | null> {
  const settings = await readCloudSettings(env);
  if ((await pricingV3Mode(env, settings)) === "off") return null;
  const { ctx } = await adContextFor(env, account, await pricingSwitches(env, settings));
  if (!ctx.v3) return null;
  const rates = computerRatesMilli(computer, ctx);
  if (rates.fullMilli === rates.adMilli) return rates.fullMilli;
  const target = (await targetsOf(env, [computer.instance_id])).get(computer.instance_id) ?? null;
  return decidePrice(target, ctx, null, now, { smallLook: isChargedSmall(rates) }).now === "ad" ? rates.adMilli : rates.fullMilli;
}

/**
 * How Free's Small keeps working with no credits left, under Pricing v3:
 * `ads_on` (a person's message wakes it at the price with ads, `routes.ts`),
 * `ads_off` (ads are offered: with them on it would), or null (another plan,
 * Pricing v3 or the ad switch not reaching the account, or no ads in the
 * country its ads answer came from). For the credits emails and the
 * `out_of_hours` refusal, which have no request. Only the settings read at `off`.
 */
export async function freeSmallWayOut(env: GravityEnv, account: AccountRow): Promise<"ads_on" | "ads_off" | null> {
  if (!freeRuleCharges(account)) return null;
  const settings = await readCloudSettings(env);
  if ((await pricingV3Mode(env, settings)) === "off") return null;
  const { ctx, consent } = await adContextFor(env, account, await pricingSwitches(env, settings));
  if (!ctx.v3 || !ctx.adsReach || !adsCountryHas(env, consent?.country ?? null)) return null;
  return ctx.adsOn ? "ads_on" : "ads_off";
}

/* ---- What the apps read ---- */

/** Whether this request's country has ads (Gravity's countries; an unknown one, a local run, counts). */
export type AdsWhere = { available: boolean };

/** Pure: one target's `CloudPrice`, with the reason a person reads where they are. */
export function priceOf(decision: PriceDecision, rates: V3Rate, here: AdsWhere): CloudPrice {
  const ad = decision.now === "ad";
  const reason: CloudFullPriceReason | null = ad ? null : !here.available ? "no_ads_here" : decision.reason;
  return {
    now: ad ? "ad" : "full",
    reason,
    adUntil: ad ? decision.adUntil : null,
    rateMilli: ad ? rates.adMilli : rates.fullMilli,
    otherRateMilli: ad ? rates.fullMilli : rates.adMilli,
  };
}

/**
 * `CloudAccountState.pricing` and the catalog's terms, or undefined while
 * Pricing v3 doesn't reach the account (one settings read at `off`: the
 * account read runs on every app's poll). `available`: the request's country
 * has ads.
 */
export async function pricingAccountState(
  env: GravityEnv,
  account: AccountRow,
  computers: readonly ComputerRow[],
  who: SponsoredRequester,
  available: boolean,
  now: number,
): Promise<{ state: CloudPricingState; catalog: V3CatalogTerms } | undefined> {
  const settings = await readCloudSettings(env);
  if ((await pricingV3Mode(env, settings)) === "off") return undefined;
  const { ctx, consent } = await adContextFor(env, account, await pricingSwitches(env, settings));
  if (!ctx.v3) return undefined;
  const live = await env.DB.prepare("select phone_id, rate_milli from cloud_phones where user_id = ? and state = 'live' and credits = 1 order by created_at desc limit 1")
    .bind(account.user_id).first<{ phone_id: string; rate_milli: number | null }>();
  const targets = await targetsOf(env, [...computers.map((computer) => computer.instance_id), ...(live ? [phoneTarget(live.phone_id)] : [])]);
  const here: AdsWhere = { available: available && ctx.adsReach };
  const ads: CloudAdsState = {
    available: here.available,
    on: ctx.adsOn && ctx.adsReach && yesHolds(env, consent, who),
    startsOn: here.available && startsOnFor(env, who),
    noticeSeen: consent?.notice_seen_at != null,
    discountPct: ctx.discountPct,
    windowMinutes: Math.round(ctx.windowMs / 60_000),
  };
  const computerPrices: CloudComputerPrice[] = computers.map((computer) => {
    const awake = computer.awake_since != null && isMeteredStatus(computer.status) ? computer.awake_since : null;
    const rates = computerRatesMilli(computer, ctx);
    const decision = decidePrice(targets.get(computer.instance_id) ?? null, ctx, awake, now, { smallLook: isChargedSmall(rates) });
    return { instanceId: computer.instance_id, ...priceOf(decision, rates, here) };
  });
  const phone = live
    ? { phoneId: live.phone_id, ...priceOf(decidePrice(targets.get(phoneTarget(live.phone_id)) ?? null, ctx, null, now), phoneRatesMilli(live.rate_milli, ctx.discountPct), here) }
    : null;
  return { state: { creditScale: CREDIT_SCALE, ads, computers: computerPrices, phone }, catalog: { discountPct: ctx.discountPct, smallFullMilli: smallFullMilli(ctx), freeSmallMilli: smallFullMilli({ ...ctx, freeRule: true }) } };
}

/* ---- The public read for the website ---- */

const PUBLIC_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
  "cache-control": "no-store",
} as const;

export const isPublicPricingRequest = (url: URL): boolean => url.pathname.replace(/\/+$/, "") === CLOUD_PUBLIC_PRICING_PATH;

/**
 * `GET /public/pricing` (`CloudPublicPricing`): no auth, CORS `*`, never
 * cached. `pricingV3` only at `all` (a tester's prices stay theirs); `mac`
 * only while `mac_computers` is `all`; `ads` only where the request's country
 * has ads and the ad switch reaches everyone. One settings read, kept in the isolate for 15 s.
 */
export async function handlePublicPricing(request: Request, env: GravityEnv): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_HEADERS });
  if (request.method !== "GET") return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found." } }), { status: 404, headers: { ...PUBLIC_HEADERS, "content-type": "application/json" } });
  const answer = await publicPricing(env, request).catch((error: unknown) => {
    reportCloudFailure("cloud.ad_price.public_failed", { message: error instanceof Error ? error.message : "unknown" });
    return { pricingV3: false } satisfies CloudPublicPricing;
  });
  return new Response(JSON.stringify(answer), { status: 200, headers: { ...PUBLIC_HEADERS, "content-type": "application/json" } });
}

/** The settings `GET /public/pricing` reads, kept in the isolate a few seconds: the read has no auth and no rate limit. */
let publicSettings: { at: number; settings: CloudSettings } | null = null;
const PUBLIC_SETTINGS_MS = 15_000;

async function publicPricing(env: GravityEnv, request: Request): Promise<CloudPublicPricing> {
  const now = Date.now();
  if (!publicSettings || now - publicSettings.at > PUBLIC_SETTINGS_MS || now < publicSettings.at) publicSettings = { at: now, settings: await readCloudSettings(env) };
  const { settings } = publicSettings;
  if ((await pricingV3Mode(env, settings)) !== "all") return { pricingV3: false };
  // The cloud Mac's switch, once its branch adds it (`mac_computers`); none here reads as off.
  const mac = (settings as unknown as Record<string, string | undefined>).mac_computers === "all";
  const who = sponsoredRequester(request);
  const terms = adTerms(settings);
  // A visitor is a new Free account that isn't a tester: the ad switch reaches it only at `all`.
  const adsReach = (await gravitySwitches(env, settings)).mode === "all";
  const freeSmallMilli = smallFullMilli({ adsReach, freeRule: true, discountPct: terms.discountPct });
  if (!adsReach || who.country == null || !adsCountryHas(env, who.country)) return { pricingV3: true, mac, freeSmallMilli, ads: null };
  return { pricingV3: true, mac, freeSmallMilli, ads: { startsOn: startsOnFor(env, who), discountPct: terms.discountPct, adWindowMinutes: terms.windowMinutes } };
}

/* ---- The owner's report: ad income against what the discount costs ---- */

/** What one thousandth of a credit is worth: the price of an extra credit (4 cents a Medium-hour, `EXTRA_HOUR_MICROS`). */
const MICROS_PER_MILLI = EXTRA_HOUR_MICROS.plus / 1000;

export type AdPriceProductReport = {
  product: string;
  /** Finished replies that asked for an ad and counted as proofs. */
  replies: number;
  /** Messages sent that counted as proofs. */
  messages: number;
  /** Credits the ad price took off (thousandths), and their worth at the extra-credit price (micros). */
  discountMilli: number;
  discountMicros: number;
  /** Hours computers ran at the ad price, and at the full price (computers only). */
  adHours: number | null;
  fullHours: number | null;
  /** The ad income attributed by its share of the replies' ad requests (micros), or null when the partner's report can't be read. */
  incomeMicros: number | null;
};

/**
 * `POST /cloud/owner/ad-price` `{ days? }`: for the last `days` UTC days, by
 * product, the proofs, what the ad price took off (and its worth at the
 * extra-credit price), and the ad income attributed by each product's share
 * of the replies that asked for an ad. So the owner sets `ad_discount_pct`
 * from data.
 */
export async function adPriceReport(env: GravityEnv, now: number, days: number) {
  const since = utcDay(now - (days - 1) * 24 * 60 * 60_000);
  const until = utcDay(now);
  const sinceMs = Date.parse(`${since}T00:00:00Z`);
  const untilMs = Date.parse(`${until}T00:00:00Z`) + 24 * 60 * 60_000;
  const [counts, computers, phones, settings] = await Promise.all([
    env.DB.prepare("select kind, sum(count) as total from cloud_sponsored_days where user_id = '*' and day >= ? and day <= ? and (kind like 'proof:%' or kind like 'sent:%') group by kind")
      .bind(since, until).all<{ kind: string; total: number }>(),
    env.DB.prepare("select coalesce(sum(ad_discount_milli), 0) as discount, coalesce(sum(ad_ms), 0) as ms, coalesce(sum(metered_ms), 0) as metered from cloud_computer_days where day >= ? and day <= ?")
      .bind(since, until).first<{ discount: number; ms: number; metered: number }>(),
    env.DB.prepare("select coalesce(sum(ad_saved_milli), 0) as discount from cloud_phones where created_at >= ? and created_at < ?")
      .bind(sinceMs, untilMs).first<{ discount: number }>(),
    readCloudSettings(env),
  ]);
  const count = new Map((counts.results ?? []).map((row) => [row.kind, row.total]));
  const income = await gravityIncomeMicros(env, since, until);
  const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;
  const products = ["linux", "phone", "free_model"];
  const replies = products.reduce((sum, product) => sum + (count.get(`proof:${product}`) ?? 0), 0);
  const rows: AdPriceProductReport[] = products.map((product) => {
    const discountMilli = product === "linux" ? computers?.discount ?? 0 : product === "phone" ? phones?.discount ?? 0 : 0;
    const share = replies > 0 ? (count.get(`proof:${product}`) ?? 0) / replies : 0;
    return {
      product,
      replies: count.get(`proof:${product}`) ?? 0,
      messages: count.get(`sent:${product}`) ?? 0,
      discountMilli,
      discountMicros: Math.round(discountMilli * MICROS_PER_MILLI),
      adHours: product === "linux" ? hours(computers?.ms ?? 0) : null,
      fullHours: product === "linux" ? hours(Math.max(0, (computers?.metered ?? 0) - (computers?.ms ?? 0))) : null,
      incomeMicros: income == null ? null : Math.round(income * share),
    };
  });
  return { days, since, mode: await pricingV3Mode(env, settings), ...adTerms(settings), products: rows, incomeMicros: income };
}

/** The partner's ad revenue over these UTC days, in micros, or null when it can't be read. */
async function gravityIncomeMicros(env: GravityEnv, from: string, to: string): Promise<number | null> {
  const key = env.GRAVITY_API_KEY?.trim();
  if (!key) return null;
  try {
    const response = await fetch(`${PLATFORM_URL}/publisher-dashboard/stats?start_date=${from}&end_date=${to}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown>;
    return typeof body.totalRevenue === "number" ? Math.round(body.totalRevenue * 1_000_000) : null;
  } catch {
    return null;
  }
}

/** The daily report's line: yesterday's ad price by product. Empty while Pricing v3 is off and nothing was counted. */
export async function adPriceReportLines(env: GravityEnv, day: string): Promise<string[]> {
  const report = await adPriceReport(env, Date.parse(`${day}T12:00:00Z`), 1);
  const any = report.products.some((row) => row.replies + row.messages + row.discountMilli > 0);
  if (report.mode === "off" && !any) return [];
  const money = (micros: number | null) => (micros == null ? "unknown" : `$${(micros / 1_000_000).toFixed(2)}`);
  const parts = report.products.filter((row) => row.replies + row.messages + row.discountMilli > 0)
    .map((row) => `${row.product} ${row.replies} replies + ${row.messages} messages, discount ${money(row.discountMicros)}${row.adHours != null ? ` over ${row.adHours} h (${row.fullHours} h at the full price)` : ""}, ad income ${money(row.incomeMicros)}`);
  return [`Ad price (${report.mode}, ${report.discountPct}% off, ${report.windowMinutes} min): ${parts.length ? parts.join("; ") : "nothing counted"}.`];
}
