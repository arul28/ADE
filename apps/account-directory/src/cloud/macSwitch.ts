/**
 * Who may use the DAEX Cloud Mac: the `mac_computers` switch (`settings.ts`)
 * and the owner's testers by email (`cloud_mac_testers`, the iPhone beta's
 * mechanism: `handleOwnerTesterList`). With the switch
 * off, or for an account it doesn't reach, nothing about the Mac is in any
 * answer: no catalog entry, no Mac in a list, and `os: "mac"` refused like a
 * size DAEX doesn't offer.
 *
 * The switch is held under the deploy variable `MAC_COMPUTERS` (its ceiling;
 * `off` or unset is a hard off) and under the NoMac key: with no key, it is
 * off whatever the row says. The stored setting starts off: that is the lock.
 */

import { json } from "./http";
import { handleOwnerTesterList } from "./phoneBeta";
import { heldUnder, isCloudSettingValue, ownerLogStatement, readCloudSettings, type CloudSettings, type CloudSettingValue } from "./settings";
import { MAC_TESTERS, type CloudEnv } from "./store";

export type MacMode = CloudSettingValue<"mac_computers">;

export const OWNER_MAC_TESTERS_PATH = "/cloud/owner/mac-testers";

type MacSwitchEnv = Pick<CloudEnv, "DB" | "NOMAC_API_KEY" | "MAC_COMPUTERS">;

/** The switch in force: the setting held under its deploy ceiling, or off with no NoMac key. */
export async function macMode(env: MacSwitchEnv, settings?: CloudSettings): Promise<MacMode> {
  if (!env.NOMAC_API_KEY?.trim()) return "off";
  const ceiling = env.MAC_COMPUTERS?.trim().toLowerCase();
  return heldUnder("mac_computers", (settings ?? await readCloudSettings(env)).mac_computers, isCloudSettingValue("mac_computers", ceiling) ? ceiling : "off");
}

export async function isMacTester(env: Pick<CloudEnv, "DB">, userId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare("select 1 as listed from cloud_mac_testers where user_id = ? limit 1").bind(userId).first<{ listed: number }>());
}

/** Whether the Mac exists for this account now. One settings read and, at `testers`, one indexed read. */
export async function macReaches(env: MacSwitchEnv, userId: string, settings?: CloudSettings): Promise<boolean> {
  const mode = await macMode(env, settings);
  if (mode === "off") return false;
  return mode === "all" || isMacTester(env, userId);
}

/** The minutes a Mac waits with no work before it stops (`mac_idle_stop_minutes`). */
export async function macIdleStopMinutes(env: Pick<CloudEnv, "DB">, settings?: CloudSettings): Promise<number> {
  return Number((settings ?? await readCloudSettings(env)).mac_idle_stop_minutes);
}

/**
 * `POST /cloud/owner/mac-testers` `{ email? | userId?, enabled? }` (owner
 * token, checked in `safety.ts`): the iPhone beta's mechanism on the Mac's
 * list (`handleOwnerTesterList`). `{}` lists it and the emails still
 * waiting. A tester taken off has their Macs stopped (`onRemoved`), their
 * drives kept under the normal cleanup clock.
 */
export async function handleOwnerMacTesters(
  env: CloudEnv,
  body: Record<string, unknown>,
  now: number,
  stopAccountMacs: (userId: string) => Promise<void>,
): Promise<Response> {
  const named = typeof body.email === "string" || typeof body.userId === "string";
  if (!named) {
    const rows = await env.DB.prepare("select user_id, email, added_at from cloud_mac_testers order by added_at").all<{ user_id: string; email: string | null; added_at: number }>();
    const pending = await env.DB.prepare("select email, added_at from cloud_mac_testers_pending order by added_at").all<{ email: string; added_at: number }>();
    return json({ ok: true, mode: await macMode(env), users: rows.results ?? [], pending: pending.results ?? [] });
  }
  return handleOwnerTesterList(env, MAC_TESTERS, body, now, {
    alongside: [ownerLogStatement(env, now, body.enabled === false ? "mac_tester_off" : "mac_tester_on", typeof body.userId === "string" ? body.userId : null, { email: typeof body.email === "string" ? body.email.trim().toLowerCase() : null })],
    onRemoved: async (userIds) => {
      if (await macMode(env) !== "testers") return;
      for (const userId of userIds) await stopAccountMacs(userId);
    },
  });
}
