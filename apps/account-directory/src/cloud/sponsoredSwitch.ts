import type { GravityEnv } from "./gravity";
import { heldUnder, isCloudSettingValue, readCloudSettings, type CloudSettingValue, type CloudSettings } from "./settings";
import type { AccountRow } from "./store";

// The ad switch: whether sponsored cards (and Free's Small rule that rides on
// them) reach an account at all, and whether Gravity's real ads are on. Read
// by `gravity.ts` for cards and by `sponsoredSmall.ts` for Small's rate. And
// the ADE Free Models switch (`freeModels.ts`), which rides on the same live
// switch.

export type SponsoredMode = CloudSettingValue<"gravity_ads">;
export type Switches = { mode: SponsoredMode; live: boolean };

/**
 * The switches as they stand now: the instant settings, each held under its
 * deploy variable. No key: off. Read once per request.
 */
export async function gravitySwitches(env: GravityEnv, settings?: CloudSettings): Promise<Switches> {
  if (!env.GRAVITY_API_KEY?.trim()) return { mode: "off", live: false };
  const read = settings ?? (await readCloudSettings(env));
  const ceiling = env.GRAVITY_ADS?.trim().toLowerCase();
  const mode = heldUnder("gravity_ads", read.gravity_ads, isCloudSettingValue("gravity_ads", ceiling) ? ceiling : "off");
  return { mode, live: liveOf(env, read, mode) };
}

const liveOf = (env: GravityEnv, read: CloudSettings, mode: string): boolean =>
  mode !== "off" && read.gravity_live === "on" && env.GRAVITY_LIVE?.trim() === "1";

export type InferenceMode = CloudSettingValue<"gravity_inference">;
export type InferenceSwitch = { mode: InferenceMode; live: boolean };

/**
 * The ADE Free Models switch: the `gravity_inference` setting held under the
 * deploy variable `GRAVITY_INFERENCE` (unset or `off`: a hard off). Off
 * without both keys: the inference key, and the publisher key the cards in
 * these chats need. `live`: the cards are Gravity's real ads.
 */
export async function inferenceSwitch(env: GravityEnv, settings?: CloudSettings): Promise<InferenceSwitch> {
  if (!env.GRAVITY_INFERENCE_KEY?.trim() || !env.GRAVITY_API_KEY?.trim()) return { mode: "off", live: false };
  const read = settings ?? (await readCloudSettings(env));
  const ceiling = env.GRAVITY_INFERENCE?.trim().toLowerCase();
  const mode = heldUnder("gravity_inference", read.gravity_inference, isCloudSettingValue("gravity_inference", ceiling) ? ceiling : "off");
  return { mode, live: liveOf(env, read, mode) };
}

/**
 * Whether ADE Free Models reach this account: a tester under `testers` or
 * `all`; anyone else under `all`, only while real ads are on.
 */
export async function inferenceReaches(env: GravityEnv, userId: string, inference: InferenceSwitch): Promise<boolean> {
  if (inference.mode === "off") return false;
  if (inference.mode === "all" && inference.live) return true;
  return isTester(env, userId);
}

export async function isTester(env: GravityEnv, userId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare("select 1 as listed from cloud_sponsored_testers where user_id = ?").bind(userId).first<{ listed: number }>());
}

/** Whether the switch reaches this account: `all`, or `testers` and it is one. Plan and country aside. */
export async function switchReaches(env: GravityEnv, account: AccountRow, mode: SponsoredMode): Promise<boolean> {
  if (mode === "off") return false;
  return mode === "all" || isTester(env, account.user_id);
}
