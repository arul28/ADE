/**
 * "Push this preference now, and tell me whether the brain took it."
 *
 * The account-settings engine is fire-and-forget by design: a settings change
 * lands locally and reaches the account on a 30-second tick. That is right for
 * a theme. It is wrong for a value that something else reads out of the
 * brain's own copy seconds later — a Custom provider is written to
 * `account-settings.json`, and the launch resolver in the brain reads that
 * same file, so a launch that beats the tick reads a list the preset is not in
 * and reports "this harness preset no longer exists on this account".
 *
 * This module is the one place that says "not yet". `useAccountSettingsSync`
 * registers the live engine here on mount; the Custom surfaces call
 * {@link flushAccountSettingKey} before a save reports success and before a
 * launch that names a saved preset. Everything else keeps the tick.
 *
 * A module-level handle rather than a React context because the callers are
 * not all components: the launch guard runs inside a submit handler that has no
 * access to the settings page's tree, and the sync is mounted exactly once for
 * the whole app.
 */

import type { AccountSettingsResult } from "../../shared/types/accountSettings";
import type { AccountSettingsSyncHandle } from "./accountSettingsSync";

let current: AccountSettingsSyncHandle | null = null;

/** Mount (and unmount) the live engine. The app mounts one; tests may mount none. */
export function registerAccountSettingsSync(
  handle: AccountSettingsSyncHandle | null,
): void {
  current = handle;
}

/**
 * Push one preference to the brain and await its answer.
 *
 * Resolves to `ok: false` — never throws — when there is no sync mounted (the
 * hosted web client, a renderer test), when the account is signed out, or when
 * the brain refuses. Callers decide whether that is fatal; a save says so, a
 * launch only warns.
 */
export async function flushAccountSettingKey(
  key: string,
): Promise<AccountSettingsResult<null>> {
  if (!current) {
    return {
      ok: false,
      unavailable: true,
      message: "This surface does not sync account settings.",
    };
  }
  try {
    return await current.flushKey(key);
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      message: error instanceof Error ? error.message : String(error ?? ""),
    };
  }
}
