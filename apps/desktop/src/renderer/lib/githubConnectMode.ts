/**
 * How GitHub connects, for the whole ADE account: through the ADE for GitHub
 * app, a token or the GitHub CLI (the default), or the GitHub CLI and git
 * only, for a person whose organisation blocks the app and personal access
 * tokens.
 *
 * It is the person's choice, not a machine's, so it lives in the account
 * settings store and holds on every computer (CLAUDE.md, Account-wide
 * features). It only changes what ADE offers: the CLI login was always a
 * GitHub sign-in ADE uses, and nothing here turns another one off.
 *
 * Read once per window when a surface first asks, again when it is changed
 * here, and when the account's settings change. Nothing polls.
 */

import { useEffect, useSyncExternalStore } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../shared/accountSettingsScope";

export const GITHUB_CONNECT_MODE_SETTING_KEY = "github.connectMode";

export type GithubConnectMode = "app_or_token" | "cli_only";

const DEFAULT_MODE: GithubConnectMode = "app_or_token";

function decode(value: unknown): GithubConnectMode {
  return value === "cli_only" ? "cli_only" : DEFAULT_MODE;
}

type Snapshot = { mode: GithubConnectMode; loaded: boolean };

let snapshot: Snapshot = { mode: DEFAULT_MODE, loaded: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

let watching = false;

function load(): Promise<void> {
  loading ??= (async () => {
    const settings = window.ade?.accountSettings;
    // A change from another computer (or another window) reads it again.
    if (settings?.onChanged && !watching) {
      watching = true;
      settings.onChanged(() => {
        loading = null;
        void load();
      });
    }
    if (!settings) {
      publish({ mode: DEFAULT_MODE, loaded: true });
      return;
    }
    try {
      const row = await settings.get({ scope: ACCOUNT_SCOPE_ALL, key: GITHUB_CONNECT_MODE_SETTING_KEY });
      // Unreadable reads as the default: every prompt shows, as before.
      publish({ mode: row.ok ? decode(row.value) : snapshot.mode, loaded: true });
    } catch {
      publish({ ...snapshot, loaded: true });
    }
  })();
  return loading;
}

/**
 * Saves the choice for the account. Resolves to null, or one sentence when it
 * did not save; the page then shows the choice it had.
 */
export async function setGithubConnectMode(mode: GithubConnectMode): Promise<string | null> {
  const settings = window.ade?.accountSettings;
  if (!settings) return "This window can't change account settings.";
  const before = snapshot;
  publish({ mode, loaded: true });
  try {
    const written = await settings.set({ scope: ACCOUNT_SCOPE_ALL, key: GITHUB_CONNECT_MODE_SETTING_KEY, value: mode });
    if (written.ok) return null;
    publish(before);
    return written.message;
  } catch (error) {
    publish(before);
    return error instanceof Error ? error.message : String(error);
  }
}

/** The account's choice; `loaded` is false until the first read answered. */
export function useGithubConnectMode(): Snapshot {
  useEffect(() => {
    void load();
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
