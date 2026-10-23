/**
 * The account-wide Fast-mode permission.
 *
 * Fast is the faster, more expensive service tier some providers sell. It is
 * off for every ADE account until that account turns it on here: one row in the
 * account settings store, scope `all`, so every machine a person signs in on
 * reads the same answer. Absent means **off** (fail-closed), which is why an
 * unreadable cache, a fresh machine, and a signed-out install all lock it rather
 * than accidentally allowing it.
 *
 * This is a permission, not a default. When it is on, every new chat still
 * starts Standard; Fast is chosen per chat. See `agentChatService`'s create /
 * update / `/fast` guards.
 */

import { ACCOUNT_SCOPE_ALL } from "./accountSettingsScope";

export const FAST_MODE_SETTING_SCOPE = ACCOUNT_SCOPE_ALL;
export const FAST_MODE_SETTING_KEY = "chat.fastModeEnabled";

/**
 * What a caller sees when it explicitly asks for Fast while the account forbids
 * it. One sentence: what is off, and the one place to change it.
 */
export const FAST_MODE_DISABLED_MESSAGE =
  "Fast mode is off for your account. Turn it on in Settings → Chat → Fast mode.";

/** Only an explicit `true` enables it; every other value, including absent, is off. */
export function isFastModeEnabledSetting(value: unknown): boolean {
  return value === true;
}
