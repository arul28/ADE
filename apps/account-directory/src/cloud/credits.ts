/**
 * Credits: one balance for everything ADE Cloud runs.
 *
 * A credit is the old hour renamed: the plan's hours (`includedMilli`), the
 * earned ones and the extra ones keep every number, and a Medium computer
 * still uses one an hour. The ADE Cloud iPhone draws from the same balance
 * at one credit a minute, so there is no separate iPhone balance and no
 * separate switch for extra iPhone minutes: an extra iPhone minute is one
 * extra credit, on the extra-hours switch.
 *
 * The `cloud_credits` switch (`settings.ts`) turns it on: `off`, `testers`
 * (the accounts on the iPhone's beta list) or `all`, held under the deploy
 * variable `CLOUD_CREDITS`. A phone counts in credits when it started while
 * the switch reached its account (`cloud_phones.credits`, migration 0059);
 * one that started before keeps the old iPhone minutes, so a flip never
 * counts a phone twice. Its credits go into `used_milli` as its provider
 * settles its billed minutes (`phoneCreditStatements` in `phones.ts`), so
 * every rule that reads hours (the limits, extra hours, earned hours, the
 * period's end) counts them.
 */

import { heldUnder, isCloudSettingValue, readCloudSettings, type CloudSettings } from "./settings";
import type { CloudEnv } from "./store";

/** What a running iPhone uses: one credit (a thousand thousandths) a minute. */
export const PHONE_CREDIT_MILLI_PER_MINUTE = 1000;

/** How far the `cloud_credits` switch reaches now: the setting, held under `CLOUD_CREDITS` (unset: a hard off). */
export async function creditsMode(env: CloudEnv, settings?: CloudSettings): Promise<"off" | "testers" | "all"> {
  const ceiling = env.CLOUD_CREDITS?.trim().toLowerCase();
  if (!isCloudSettingValue("cloud_credits", ceiling) || ceiling === "off") return "off";
  const read = settings ?? (await readCloudSettings(env));
  return heldUnder("cloud_credits", read.cloud_credits, ceiling);
}

/** Whether credits reach this account now: `all`, or `testers` and it is on the iPhone's beta list. */
export async function creditsOnFor(env: CloudEnv, userId: string): Promise<boolean> {
  const mode = await creditsMode(env);
  if (mode === "off") return false;
  if (mode === "all") return true;
  return Boolean(await env.DB.prepare("select 1 as listed from cloud_phone_beta where user_id = ?").bind(userId).first<{ listed: number }>());
}
