/**
 * Which provider runs an account's phone, and the start that fails over along
 * the route. `phones.ts` owns everything else (rows, minutes, access, routes).
 *
 * The order is fixed: NoMac first, Revyl second, and Revyl only on a paid
 * plan, as the fallback when NoMac refuses. A free plan's phone is NoMac's
 * alone; when NoMac refuses it, the person is told the phone is busy. A tester
 * (on the iPhone's beta list) may pick one provider for every phone of theirs
 * (`cloud_phone_beta.provider`, set from a beta app's toggle,
 * `POST /cloud/phone/provider`): only that one, never another quietly.
 */
import {
  CLOUD_PHONE_ABILITY_WORDS,
  CLOUD_PHONE_PROVIDER_ABILITIES,
  isCloudPhoneProvider,
  type CloudPhoneAbility,
  type CloudPhoneProvider,
} from "./contract";
import { fail } from "./http";
import { NOMAC_PHONE } from "./phoneNomac";
import type { PhoneProviderServer, PhoneSession } from "./phoneProvider";
import { REVYL_PHONE } from "./phoneRevyl";
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
 * `busyWhenRefused`: a refusal of the whole route is told as the busy answer
 * (a free plan's, which has no fallback).
 */
export type PhoneRoute = { order: CloudPhoneProvider[]; reason: "choice" | "default"; busyWhenRefused: boolean };

/** A free plan's phone NoMac turned away: no fallback, and the plan that has one. */
export const phoneBusy = (): Response =>
  fail("phone_busy", "The ADE Cloud iPhone is busy right now because of heavy use. Try again in a few minutes, or move to a paid plan for priority access.", 503);

/** The provider a tester picked (`cloud_phone_beta.provider`), or null: the fixed order. */
export const pickedProviderOf = (provider: string | null | undefined): CloudPhoneProvider | null => (isCloudPhoneProvider(provider) ? provider : null);

/**
 * The providers the account's next phone may start on, in order: the
 * tester's pick alone, else NoMac, then Revyl on a paid plan. Each only where
 * it can start phones here and this client drives it.
 */
export function routeOf(env: CloudEnv, { picked, free }: { picked: CloudPhoneProvider | null; free: boolean }, drives: (provider: CloudPhoneProvider) => boolean): PhoneRoute | Response {
  const unavailable = (): Response => fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. Try again soon.", 503);
  if (picked) {
    if (!PHONE_PROVIDERS[picked].canStart(env)) return unavailable();
    if (!drives(picked)) return fail("phone_needs_update", "Update ADE to use your ADE Cloud iPhone.", 409);
    return { order: [picked], reason: "choice", busyWhenRefused: false };
  }
  const order = (free ? PROVIDER_ORDER.slice(0, 1) : PROVIDER_ORDER).filter((provider) => PHONE_PROVIDERS[provider].canStart(env) && drives(provider));
  if (!order.length) return free ? phoneBusy() : unavailable();
  return { order, reason: "default", busyWhenRefused: free };
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
export const unsureStartHeld = (account: UnsureStart, now: number): boolean =>
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
  // A free plan's phone has no fallback: a refusal (never a lost answer, which may hide a phone) reads as busy.
  if (answer instanceof Response && route.busyWhenRefused && definitelyRefused(answer)) {
    logCloud("cloud.phone_start_busy", { userId, status: answer.status });
    return phoneBusy();
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
