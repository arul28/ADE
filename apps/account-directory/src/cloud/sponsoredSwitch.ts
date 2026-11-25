import type { GravityEnv } from "./gravity";
import { heldUnder, isCloudSettingValue, readCloudSettings, type CloudSettingValue, type CloudSettings } from "./settings";
import type { AccountRow } from "./store";

// The ad switch: whether sponsored cards (and Free's Small rule that rides on
// them) reach an account at all, and whether Gravity's real ads are on. Read
// by `gravity.ts` for cards and by `sponsoredSmall.ts` for Small's rate.

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
  return { mode, live: mode !== "off" && read.gravity_live === "on" && env.GRAVITY_LIVE?.trim() === "1" };
}

export async function isTester(env: GravityEnv, userId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare("select 1 as listed from cloud_sponsored_testers where user_id = ?").bind(userId).first<{ listed: number }>());
}

/** Whether the switch reaches this account: `all`, or `testers` and it is one. Plan and country aside. */
export async function switchReaches(env: GravityEnv, account: AccountRow, mode: SponsoredMode): Promise<boolean> {
  if (mode === "off") return false;
  return mode === "all" || isTester(env, account.user_id);
}
