/**
 * Which provider runs an account's phone, and the start that fails over along
 * the route. `phones.ts` owns everything else (rows, minutes, access, routes).
 *
 * The order is fixed: NoMac first, Revyl second, and Revyl only on a paid
 * plan, as the fallback when NoMac refuses. A free plan's phone is NoMac's
 * alone; when NoMac refuses it, the person is told the phone is busy. A paid
 * plan's Revyl use stops at the plan's own price each period
 * (`revylLimitMicros`), so a paying account never costs more at Revyl than
 * it pays; past it, a refusal is the same busy answer with no upgrade line. A tester
 * (on the iPhone's beta list) may pick one provider for every phone of theirs
 * (`cloud_phone_beta.provider`, set from a beta app's toggle,
 * `POST /cloud/phone/provider`): only that one, never another quietly.
 *
 * A start that names build tools its project needs (`builds`) leaves out a
 * provider found without one in the last day (`buildGaps`), so a Metal app
 * goes where Metal builds. When that leaves the plan nothing, it is told why
 * (`buildRefusal`): on Free, that a paid plan's iPhone can build it.
 */
import {
  CLOUD_PHONE_ABILITY_WORDS,
  CLOUD_PHONE_BUILD_GAP_MS,
  CLOUD_PHONE_BUILD_NEED_WORDS,
  CLOUD_PHONE_PROVIDER_ABILITIES,
  cloudPhoneLacks,
  isCloudPhoneProvider,
  type CloudPhoneAbility,
  type CloudPhoneBuildNeed,
  type CloudPhoneProvider,
} from "./contract";
import { fail } from "./http";
import { NOMAC_PHONE } from "./phoneNomac";
import type { PhoneProviderServer, PhoneSession } from "./phoneProvider";
import { REVYL_MICROS_PER_SECOND, REVYL_PHONE } from "./phoneRevyl";
import { logCloud, reportCloudFailure, type CloudEnv } from "./store";

export const PHONE_PROVIDERS: Record<CloudPhoneProvider, PhoneProviderServer> = { nomac: NOMAC_PHONE, revyl: REVYL_PHONE };

/** The order a phone tries providers in: NoMac, then Revyl. */
const PROVIDER_ORDER: readonly CloudPhoneProvider[] = ["nomac", "revyl"];

/**
 * The providers a start's client says it can drive (`providers` in its body).
 * Every client drives NoMac; a brain from before Revyl sends no list, so it
 * never gets a Revyl phone it can't use (an empty token and `apiBase`).
 */
export function clientDrives(value: unknown): (provider: CloudPhoneProvider) => boolean {
  const listed = Array.isArray(value) ? value.filter(isCloudPhoneProvider) : [];
  return (provider) => provider === "nomac" || listed.includes(provider);
}

/** "run an app's tests and shake". */
export const abilityWords = (abilities: readonly CloudPhoneAbility[]): string => {
  const words = abilities.map((ability) => CLOUD_PHONE_ABILITY_WORDS[ability]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] ?? "";
};

/**
 * Why a start went where it did (logs, PostHog): see `CloudPhoneEvent.route`.
 * `busy`: a refusal of the whole route is told as the busy answer, a free
 * plan's (no fallback) with the paid plans' line, a paid plan's past its
 * Revyl limit without it.
 */
export type PhoneRoute = { order: CloudPhoneProvider[]; reason: "choice" | "default"; busy: "free" | "paid" | null };

/** A phone NoMac turned away with no fallback left: on Free, with the plan that has one. */
export const phoneBusy = (plan: "free" | "paid" = "free"): Response =>
  fail(
    "phone_busy",
    plan === "free"
      ? "The ADE Cloud iPhone is busy right now because of heavy use. Try again in a few minutes, or move to a paid plan for priority access."
      : "The ADE Cloud iPhone is busy right now because of heavy use. Try again in a few minutes.",
    503,
  );

/**
 * What a paid account's phones may cost ADE at Revyl in one billing period:
 * the plan's own price (owner, 2026-11-25), so about 80 minutes on Plus, 330
 * on Pro and 830 on Max. Internal: never shown or named to the person.
 */
export const revylLimitMicros = (priceUsd: number): number => Math.round(priceUsd * 1_000_000);

/**
 * What the account's Revyl phones cost ADE since `periodStart`: each at least
 * for the time it ran (a live one until now, an ended one until it ended),
 * since Revyl's bill fills in only after a later settle read.
 */
export async function revylSpentMicros(env: Pick<CloudEnv, "DB">, userId: string, periodStart: number, now: number): Promise<number> {
  const row = await env.DB.prepare(`
    select coalesce(sum(max(cost_micros, max(0, (case when state = 'live' then ? else coalesce(ended_at, updated_at) end) - created_at) / 1000 * ?)), 0) as spent
    from cloud_phones where user_id = ? and provider = 'revyl' and created_at >= ?
  `).bind(now, REVYL_MICROS_PER_SECOND, userId, periodStart).first<{ spent: number }>();
  return Math.max(0, Number(row?.spent ?? 0) || 0);
}

/** When a running Revyl phone uses up what the limit leaves after `spentMicros` (its own time so far included). */
export const revylLimitEndsAt = (limitMicros: number, spentMicros: number, now: number): number =>
  now + Math.max(0, Math.floor((limitMicros - spentMicros) / REVYL_MICROS_PER_SECOND)) * 1000;

/** Whole minutes of Revyl phone a limit leaves after what was spent. */
export const revylMinutesLeft = (limitMicros: number, spentMicros: number): number =>
  Math.max(0, Math.floor((limitMicros - spentMicros) / (REVYL_MICROS_PER_SECOND * 60)));

/** The provider a tester picked (`cloud_phone_beta.provider`), or null: the fixed order. */
export const pickedProviderOf = (provider: string | null | undefined): CloudPhoneProvider | null => (isCloudPhoneProvider(provider) ? provider : null);

/**
 * The providers the account's next phone may start on, in order: the
 * tester's pick alone, else NoMac, then Revyl on a paid plan with Revyl
 * minutes left this period (`revylOpen`). Each only where it can start
 * phones here and this client drives it.
 */
export function routeOf(
  env: CloudEnv,
  { picked, free, revylOpen = true }: { picked: CloudPhoneProvider | null; free: boolean; revylOpen?: boolean },
  drives: (provider: CloudPhoneProvider) => boolean,
): PhoneRoute | Response {
  const unavailable = (): Response => fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. Try again soon.", 503);
  if (picked) {
    if (!PHONE_PROVIDERS[picked].canStart(env)) return unavailable();
    if (!drives(picked)) return fail("phone_needs_update", "Update ADE to use your ADE Cloud iPhone.", 409);
    return { order: [picked], reason: "choice", busy: null };
  }
  const nomacOnly = free || !revylOpen;
  const order = (nomacOnly ? PROVIDER_ORDER.slice(0, 1) : PROVIDER_ORDER).filter((provider) => PHONE_PROVIDERS[provider].canStart(env) && drives(provider));
  const busy = free ? "free" : revylOpen ? null : "paid";
  if (!order.length) return busy ? phoneBusy(busy) : unavailable();
  return { order, reason: "default", busy };
}

/** What the account's next phone can do beyond the basics: the first provider its route tries. */
export function nextAbilities(env: CloudEnv, picked: CloudPhoneProvider | null): CloudPhoneAbility[] {
  const first = picked ?? PROVIDER_ORDER.find((provider) => PHONE_PROVIDERS[provider].canStart(env)) ?? "nomac";
  return [...CLOUD_PHONE_PROVIDER_ABILITIES[first]];
}

/**
 * How long a start whose answer was lost (`definitelyRefused` false) holds the
 * account's next starts to its provider. Its phone may be coming up there with
 * no row: a start on that provider finds it (each answers the account's running
 * phone) and saves it; one elsewhere would bill a second. Past this, a phone
 * nobody drove has ended on its idle limit (a start's few minutes plus
 * `CLOUD_PHONE_IDLE_SECONDS`).
 */
const UNSURE_START_MS = 15 * 60_000;

/** The account's lost start (migration 0057): the provider and when. */
type UnsureStart = { phone_start_unsure?: string | null; phone_start_unsure_at?: number | null };

/** A start whose answer was lost may still have a phone coming up: the next start is its retry. */
const unsureStartHeld = (account: UnsureStart, now: number): boolean =>
  isCloudPhoneProvider(account.phone_start_unsure) && (account.phone_start_unsure_at ?? 0) > now - UNSURE_START_MS;

/** The route held to the provider a lost start may have made a phone at, or refused when it can't go there. */
export function heldToUnsureStart(route: PhoneRoute, account: UnsureStart, now: number): PhoneRoute | Response {
  const unsure = account.phone_start_unsure;
  if (!unsureStartHeld(account, now) || !isCloudPhoneProvider(unsure)) return route;
  if (route.order.includes(unsure)) return { ...route, order: [unsure] };
  return fail("phone_unavailable", "Your last ADE Cloud iPhone start didn't finish answering, and that phone may still be coming up. Try again in a few minutes.", 503);
}

type StartInput = Parameters<PhoneProviderServer["start"]>[1];

/**
 * A start's answer that says no phone was made (refused: a bad key, no
 * credit, full, busy), so the next provider may try. A 502 or 504 (a 5xx, a
 * timeout, a throw) may hide a phone the provider made anyway; starting a
 * second one there would bill both, so that answer is final.
 */
const definitelyRefused = (answer: Response): boolean => answer.status !== 502 && answer.status !== 504;

/**
 * Starts the phone on the first provider of the route that starts one. One
 * that definitely refused hands the start to the next; the last answer is
 * the reply. `reason` is `failover` when the phone started past the route's
 * first provider.
 */
export async function startOnRoute(env: CloudEnv, route: PhoneRoute, userId: string, input: StartInput): Promise<
  { started: { session: PhoneSession; reused: boolean }; provider: CloudPhoneProvider; reason: PhoneRoute["reason"] | "failover" } | Response
> {
  const answer = await startAlongRoute(env, route, userId, input);
  // A phone with no fallback left: a refusal (never a lost answer, which may hide a phone) reads as busy.
  if (answer instanceof Response && route.busy && definitelyRefused(answer)) {
    logCloud("cloud.phone_start_busy", { userId, status: answer.status, plan: route.busy });
    return phoneBusy(route.busy);
  }
  return answer;
}

async function startAlongRoute(env: CloudEnv, route: PhoneRoute, userId: string, input: StartInput): Promise<
  { started: { session: PhoneSession; reused: boolean }; provider: CloudPhoneProvider; reason: PhoneRoute["reason"] | "failover" } | Response
> {
  let refused: Response | null = null;
  for (const [index, provider] of route.order.entries()) {
    const started = await PHONE_PROVIDERS[provider].start(env, input).catch((error: unknown) => {
      reportCloudFailure("cloud.phone_start_threw", { userId, provider, message: error instanceof Error ? error.message : "unknown" }, "cloud-phone");
      return fail("phone_unavailable", "The ADE Cloud iPhone isn't answering right now. Try again in a moment.", 502);
    });
    if (!(started instanceof Response)) {
      // The phone is known now (saved by the caller): a lost start before it no longer holds the route.
      await env.DB.prepare("update cloud_accounts set phone_start_unsure = null, phone_start_unsure_at = null where user_id = ? and phone_start_unsure is not null").bind(userId).run();
      return { started, provider, reason: index === 0 ? route.reason : "failover" };
    }
    refused = started;
    if (!definitelyRefused(started)) {
      // It may have made a phone: the next starts go there alone until one finds it (`heldToUnsureStart`).
      await env.DB.prepare("update cloud_accounts set phone_start_unsure = ?, phone_start_unsure_at = ? where user_id = ?").bind(provider, input.now, userId).run();
      break;
    }
    const next = route.order[index + 1];
    if (!next) break;
    logCloud("cloud.phone_start_failover", { userId, from: provider, to: next, status: started.status });
  }
  return refused ?? fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. Try again soon.", 503);
}

/* ---- Build tools a provider's hosts lack (`cloud_phone_build_gaps`) ---- */

/**
 * The providers found without any of `needs` in the last day: a start that
 * needs them goes elsewhere. `ownOnly` (a free plan, whose start can only be
 * refused, never moved): only the account's own reports, on its own phones'
 * rows, so another account's report can't block it; any account's report
 * only ever moves a paid plan's start to a provider that builds it.
 */
export async function buildGaps(env: Pick<CloudEnv, "DB">, needs: readonly CloudPhoneBuildNeed[], now: number, ownOnly: string | null = null): Promise<Set<CloudPhoneProvider>> {
  if (!needs.length) return new Set();
  const listed = needs.map(() => "?").join(", ");
  const rows = ownOnly
    ? await env.DB.prepare(`select distinct coalesce(provider, 'nomac') as provider from cloud_phones where user_id = ? and build_gap_at > ? and build_gap in (${listed})`)
      .bind(ownOnly, now - CLOUD_PHONE_BUILD_GAP_MS, ...needs).all<{ provider: string }>()
    : await env.DB.prepare(`select provider from cloud_phone_build_gaps where seen_at > ? and need in (${listed})`)
      .bind(now - CLOUD_PHONE_BUILD_GAP_MS, ...needs).all<{ provider: string }>();
  return new Set((rows.results ?? []).map((row) => row.provider).filter(isCloudPhoneProvider));
}

/**
 * A brain's report that a build on `phoneId` failed for want of `need`. Only
 * for a phone of this account's from the last few hours, and the provider is
 * the phone row's, never the brain's word. One row per provider and need,
 * for every account: its day starts again with each report.
 */
export async function recordBuildGap(env: Pick<CloudEnv, "DB">, userId: string, phoneId: string, need: CloudPhoneBuildNeed, now: number): Promise<CloudPhoneProvider | null> {
  const row = await env.DB.prepare("select provider from cloud_phones where phone_id = ? and user_id = ? and created_at > ?")
    .bind(phoneId, userId, now - BUILD_REPORT_MS).first<{ provider: string | null }>();
  const provider = row ? (isCloudPhoneProvider(row.provider) ? row.provider : "nomac") : null;
  if (!provider) return null;
  await env.DB.batch([
    env.DB.prepare("insert into cloud_phone_build_gaps (provider, need, seen_at) values (?, ?, ?) on conflict(provider, need) do update set seen_at = excluded.seen_at")
      .bind(provider, need, now),
    // The account's own record, on its phone's row (a free plan's refusals read only these).
    env.DB.prepare("update cloud_phones set build_gap = ?, build_gap_at = ? where phone_id = ? and user_id = ?").bind(need, now, phoneId, userId),
  ]);
  logCloud("cloud.phone_build_gap", { userId, phoneId, provider, need });
  return provider;
}

/** A report names a phone this old at most: a build runs on a phone that is up (one runs two hours at most). */
const BUILD_REPORT_MS = 3 * 60 * 60_000;

/** "build apps with Metal shaders". */
const buildWords = (needs: readonly CloudPhoneBuildNeed[]): string => needs.map((need) => CLOUD_PHONE_BUILD_NEED_WORDS[need]).join(" and ");

/**
 * The route without the providers that lack a build tool the start needs (or
 * an ability it needs), or why there is none: on Free, when a paid plan's
 * iPhone could build it, that (402 `phone_needs_paid`); when one could build
 * it but can't do an ability asked for too, that; otherwise that no cloud
 * iPhone builds it right now (409 `phone_build_unavailable`). A tester's
 * pick is theirs and never filtered. Never names a provider.
 */
export function routeForBuilds(
  env: CloudEnv,
  route: PhoneRoute,
  { builds, gapped, needs, free, drives }: { builds: readonly CloudPhoneBuildNeed[]; gapped: ReadonlySet<CloudPhoneProvider>; needs: readonly CloudPhoneAbility[]; free: boolean; drives: (provider: CloudPhoneProvider) => boolean },
): PhoneRoute | Response {
  if (!builds.length || !gapped.size || route.reason === "choice") return route;
  // Abilities too: with a gap in play the order is picked by what can do the whole start, so the answer names what's missing.
  const order = route.order.filter((provider) => !gapped.has(provider) && cloudPhoneLacks(provider, needs).length === 0);
  if (order.length) return { ...route, order };
  const what = buildWords(builds);
  const elsewhere = PROVIDER_ORDER.filter((provider) => !gapped.has(provider) && PHONE_PROVIDERS[provider].canStart(env) && drives(provider));
  if (elsewhere.length && free && elsewhere.some((provider) => cloudPhoneLacks(provider, needs).length === 0)) {
    return fail("phone_needs_paid", `This app needs a cloud iPhone that can ${what}, and right now only the paid plans' iPhones can. Pick a plan in Settings › ADE Cloud, or build the app on a Mac and send it with ade apple install --app <path to the Simulator .app>.`, 402);
  }
  const lacking = elsewhere.length && elsewhere.every((provider) => cloudPhoneLacks(provider, needs).length > 0) ? cloudPhoneLacks(elsewhere[0]!, needs) : [];
  if (lacking.length) {
    return fail("phone_lacks", `The ADE Cloud iPhone can't ${what} and ${abilityWords(lacking)} at once right now. Leave out what needs the second, or build the app on a Mac and send it with ade apple install --app <path to the Simulator .app>.`, 409);
  }
  return fail("phone_build_unavailable", `The ADE Cloud iPhone can't ${what} right now. Build the app on a Mac and send it with ade apple install --app <path to the Simulator .app>.`, 409);
}
