/**
 * Which provider runs an account's phone: the provider table, the owner's
 * per-email lock or the router, and the start that fails over along the
 * route. `phones.ts` owns everything else (rows, minutes, access, routes).
 */
import {
  CLOUD_PHONE_ABILITIES,
  CLOUD_PHONE_ABILITY_WORDS,
  CLOUD_PHONE_PROVIDER_ABILITIES,
  CLOUD_PHONE_PROVIDERS,
  cloudPhoneLacks,
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

/** The server's `CLOUD_PHONE_PROVIDER`: `revyl`, else NoMac. */
export const providerSetting = (env: Pick<CloudEnv, "CLOUD_PHONE_PROVIDER">): CloudPhoneProvider =>
  env.CLOUD_PHONE_PROVIDER?.trim().toLowerCase() === "revyl" ? "revyl" : "nomac";

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

/** Why a start went where it did (logs, PostHog): see `CloudPhoneEvent.route`. */
export type PhoneRoute = { order: CloudPhoneProvider[]; reason: "lock" | "default" | "need" };

/**
 * The providers the account's next phone may start on, in order.
 *
 * - **A lock:** the owner set this account to one provider
 *   (`cloud_phone_beta.provider`). Only that one, never another quietly: a
 *   tester always knows what they test. It can't start (Revyl's switch off),
 *   this ADE can't drive it, or it lacks a need: the start is refused.
 * - **The router**, for everyone else: the server's default
 *   (`CLOUD_PHONE_PROVIDER`, NoMac when unset) first, then the other, each only
 *   where it can start phones here and this client drives it. A start that
 *   `needs` an ability goes only where it is; `startPhone` tries the next one
 *   when the first refuses.
 */
export function routeOf(env: CloudEnv, lock: CloudPhoneProvider | null, drives: (provider: CloudPhoneProvider) => boolean, needs: readonly CloudPhoneAbility[]): PhoneRoute | Response {
  const unavailable = (): Response => fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. Try again soon.", 503);
  if (lock) {
    const lacked = cloudPhoneLacks(lock, needs);
    if (lacked.length) return fail("phone_cant", `Your ADE Cloud iPhone can't ${abilityWords(lacked)}.`, 409);
    if (!PHONE_PROVIDERS[lock].canStart(env)) return unavailable();
    if (!drives(lock)) return fail("phone_needs_update", "Update ADE to use your ADE Cloud iPhone.", 409);
    return { order: [lock], reason: "lock" };
  }
  const preferred = providerSetting(env);
  const usable = [preferred, ...CLOUD_PHONE_PROVIDERS.filter((provider) => provider !== preferred)]
    .filter((provider) => PHONE_PROVIDERS[provider].canStart(env) && drives(provider));
  const order = usable.filter((provider) => !cloudPhoneLacks(provider, needs).length);
  if (!order.length) {
    if (!usable.length) return unavailable();
    return fail("phone_cant", `No ADE Cloud iPhone can ${abilityWords(needs)}${needs.length > 1 ? " at once" : ""} right now.`, 409);
  }
  return { order, reason: order[0] === usable[0] ? "default" : "need" };
}

/** The provider the owner locked this account to, from its beta row (`null`, `both` or no row: the router). */
export const lockOf = (provider: string | null | undefined): CloudPhoneProvider | null => (isCloudPhoneProvider(provider) ? provider : null);

/**
 * What the account's next phone can do beyond the basics: its lock's, or
 * every ability some provider that starts phones here has (a start's `needs`
 * picks among them).
 */
export function nextAbilities(env: CloudEnv, lock: CloudPhoneProvider | null): CloudPhoneAbility[] {
  const providers = lock ? [lock] : CLOUD_PHONE_PROVIDERS.filter((provider) => PHONE_PROVIDERS[provider].canStart(env));
  return CLOUD_PHONE_ABILITIES.filter((ability) => providers.some((provider) => CLOUD_PHONE_PROVIDER_ABILITIES[provider].includes(ability)));
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
  let refused: Response | null = null;
  for (const [index, provider] of route.order.entries()) {
    const started = await PHONE_PROVIDERS[provider].start(env, input).catch((error: unknown) => {
      reportCloudFailure("cloud.phone_start_threw", { userId, provider, message: error instanceof Error ? error.message : "unknown" }, "cloud-phone");
      return fail("phone_unavailable", "The ADE Cloud iPhone isn't answering right now. Try again in a moment.", 502);
    });
    if (!(started instanceof Response)) return { started, provider, reason: index === 0 ? route.reason : "failover" };
    refused = started;
    const next = route.order[index + 1];
    if (!next || !definitelyRefused(started)) break;
    logCloud("cloud.phone_start_failover", { userId, from: provider, to: next, status: started.status });
  }
  return refused ?? fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. Try again soon.", 503);
}
