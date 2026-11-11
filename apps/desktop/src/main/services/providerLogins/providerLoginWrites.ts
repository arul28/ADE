/**
 * The person's writes (P5 §8.1): which sign-in ADE Cloud uses, a switch per
 * sign-in and one for all, Claude's smart balance, and a removal. Only the
 * desktop's Settings calls them (user-only in `actionPolicy.ts`). Each write
 * saves the account setting `providerLogins.cloud`; on a cloud computer the
 * change applies at once.
 */

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { PROVIDER_LOGINS_CLOUD_SETTING, cloudChoiceKey } from "../../../shared/providerLoginsCloudSetting";
import { isClaudePassKey, type ProviderLoginProvider, type ProviderLoginStatus } from "../../../shared/types/providerLogins";
import { isRecord } from "../shared/utils";
import { notifyProviderLoginsChanged } from "./providerLoginHooks";
import { PROVIDER_LOGIN_VAULT_KIND, parseProviderLoginKey } from "./providerLoginPayload";
import {
  OFF_MESSAGES,
  type CloudSetting,
  type ProviderLoginSettings,
  type ProviderLoginVault,
  type SyncShared,
} from "./providerLoginSyncShared";

export function createWrites(s: SyncShared) {
  const { deps, jobs } = s;
  const { cloudSetting, captureOffReason, liveSignInKeys } = s;

  async function writableStores(): Promise<{ vault: ProviderLoginVault; settings: ProviderLoginSettings & { set: NonNullable<ProviderLoginSettings["set"]> } }> {
    if (deps.staticOff) throw new Error(OFF_MESSAGES[deps.staticOff]);
    const off = await captureOffReason();
    // The off switch for all and a vault that has not synced yet still take a change.
    if (off && off !== "all_off" && off !== "vault_unavailable") throw new Error(OFF_MESSAGES[off]);
    const vault = deps.vault();
    const settings = deps.settings();
    if (!vault || !settings?.set) throw new Error(OFF_MESSAGES.vault_unavailable);
    return { vault, settings: settings as ProviderLoginSettings & { set: NonNullable<ProviderLoginSettings["set"]> } };
  }

  /**
   * Save the setting, without entries whose sign-in is gone (§2.2: a write
   * prunes). A Claude pass key (P6) is never pruned here, only dropped by its
   * own removal (`dropKey`). Fields this code does not know (P6:
   * `claude.smartBalance`) are kept as they are.
   */
  async function saveSetting(next: CloudSetting, dropKey: string | null = null, claude: Record<string, unknown> | null = null): Promise<ProviderLoginStatus> {
    const { vault, settings } = await writableStores();
    const live = liveSignInKeys(vault);
    const keep = (key: string) => key !== dropKey && (isClaudePassKey(key) || live.has(key));
    const inUse = Object.fromEntries(Object.entries(next.inUse).filter(([, key]) => key === "key" || keep(key)));
    const off = [...new Set(next.off.filter(keep))].sort();
    const raw = settings.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING);
    const unknownFields = isRecord(raw) ? raw : {};
    const fields = { ...unknownFields, v: 1, enabled: next.enabled, inUse, off, ...(claude ? { claude } : {}) };
    if (!settings.set(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING, fields)) {
      throw new Error("ADE couldn't save that to your account. Try again in a moment.");
    }
    return await afterWrite();
  }

  async function afterWrite(): Promise<ProviderLoginStatus> {
    notifyProviderLoginsChanged();
    // On a cloud computer the change applies now; elsewhere the status reads it.
    if (deps.cloudComputer) await jobs.pass();
    return await jobs.status();
  }

  /** A live key of the account: a carried sign-in (with its place), or a Claude pass (P6, place "claude"). */
  function existingKey(vault: ProviderLoginVault, key: string): { provider: ProviderLoginProvider; slot: string | null; place: string; pass: boolean } {
    if (!liveSignInKeys(vault).has(key)) throw new Error("That sign-in is not in your account.");
    if (isClaudePassKey(key)) return { provider: "claude", slot: null, place: "claude", pass: true };
    const parsedKey = parseProviderLoginKey(key);
    if (!parsedKey) throw new Error("That sign-in is not in your account.");
    return { provider: parsedKey.provider, slot: parsedKey.slot, place: cloudChoiceKey(parsedKey.provider, parsedKey.slot), pass: false };
  }

  const writes = {
    /**
     * ADE Cloud uses this sign-in (a vault key; for Claude a pass key), the
     * saved key ("key"), or the newest (null). Picking a key also switches it on.
     */
    async use(args: { provider: ProviderLoginProvider; key: string | null; slot?: string | null }): Promise<ProviderLoginStatus> {
      const { vault } = await writableStores();
      const setting = cloudSetting();
      if (args.key && args.key !== "key") {
        const found = existingKey(vault, args.key);
        if (found.provider !== args.provider) throw new Error("That sign-in belongs to another provider.");
        setting.inUse[found.place] = args.key;
        setting.off = setting.off.filter((key) => key !== args.key);
      } else if (args.key === "key") {
        if (args.provider === "pi" || args.provider === "claude") throw new Error(`${args.provider === "pi" ? "Pi" : "Claude"} has no saved ADE Cloud key.`);
        setting.inUse[args.provider] = "key";
      } else {
        delete setting.inUse[args.provider === "claude" ? "claude" : cloudChoiceKey(args.provider, args.slot ?? "base")];
      }
      return await saveSetting(setting);
    },
    /** Switch one sign-in (or Claude pass) on or off for ADE Cloud. */
    async setCloud(args: { key: string; on: boolean }): Promise<ProviderLoginStatus> {
      const { vault } = await writableStores();
      const found = existingKey(vault, args.key);
      const setting = cloudSetting();
      setting.off = args.on ? setting.off.filter((key) => key !== args.key) : [...setting.off, args.key];
      // A pass's pick is P6's to change; a carried sign-in switched off stops being the pick.
      if (!found.pass && !args.on && setting.inUse[found.place] === args.key) delete setting.inUse[found.place];
      return await saveSetting(setting);
    },
    /** The one off switch for all of ADE Cloud's sign-ins. */
    async setCloudAll(args: { on: boolean }): Promise<ProviderLoginStatus> {
      const setting = cloudSetting();
      setting.enabled = args.on;
      return await saveSetting(setting);
    },
    /**
     * Claude's smart balance on ADE Cloud: `claude.smartBalance` in the account
     * setting, the other fields of `claude` kept. One switch for ADE Cloud,
     * apart from each own computer's switch; nothing syncs between them.
     * P6's reconcile reads it.
     */
    async setCloudBalance(args: { provider: "claude"; on: boolean }): Promise<ProviderLoginStatus> {
      if (args.provider !== "claude") throw new Error("Only Claude has a smart balance on ADE Cloud.");
      const { settings } = await writableStores();
      const raw = settings.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGINS_CLOUD_SETTING);
      const claude = isRecord(raw) && isRecord(raw.claude) ? raw.claude : {};
      return await saveSetting(cloudSetting(), null, { ...claude, smartBalance: args.on });
    },
    /** Remove one sign-in or Claude pass from the account (a tombstone every computer hears), and its setting entries. */
    async remove(args: { key: string }): Promise<ProviderLoginStatus> {
      const { vault } = await writableStores();
      const found = existingKey(vault, args.key);
      if (!vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, args.key)) {
        throw new Error("ADE couldn't remove that sign-in from your account. Try again in a moment.");
      }
      deps.logger.info("provider_login.removed", { provider: found.provider, slot: found.slot ?? "pass", reason: "removed_by_person" });
      return await saveSetting(cloudSetting(), args.key);
    },
  };

  return { saveSetting, writes };
}
