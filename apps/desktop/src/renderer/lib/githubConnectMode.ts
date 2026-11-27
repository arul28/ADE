/**
 * How GitHub connects, for the whole ADE account: through the ADE for GitHub
 * app, a token or the GitHub CLI (the default), or the GitHub CLI and git
 * only, for a person whose organisation blocks the app and personal access
 * tokens.
 *
 * Read when the first surface subscribes, when the account's settings change
 * (another computer), and when the window comes to the front (another window
 * on this computer, or a first read that failed while the brain started).
 * Nothing polls. The newest read wins.
 */

import { useSyncExternalStore } from "react";
import type { GitHubCredentialState } from "../../shared/types";
import { ACCOUNT_SCOPE_ALL } from "../../shared/accountSettingsScope";
import { plainErrorText } from "./plainError";

import { GITHUB_CONNECT_MODE_SETTING_KEY, githubConnectMode, type GithubConnectMode } from "../../shared/githubConnectMode";
import { BRAND } from "../../shared/brand";

export type { GithubConnectMode } from "../../shared/githubConnectMode";

const DEFAULT_MODE: GithubConnectMode = "app_or_token";

type Snapshot = { mode: GithubConnectMode; loaded: boolean; error: string | null };

let snapshot: Snapshot = { mode: DEFAULT_MODE, loaded: false, error: null };
// Each read and write takes a number; an answer older than the last one
// published is dropped, so two overlapping reads cannot show the older value.
let latest = 0;
let saving = false;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function read(): Promise<void> {
  if (saving) return;
  const settings = window.ade?.accountSettings;
  const seq = ++latest;
  const fallback = `${BRAND.NAME} couldn't check how GitHub connects.`;
  if (!settings) {
    publish({ ...snapshot, error: fallback });
    return;
  }
  try {
    const row = await settings.get({ scope: ACCOUNT_SCOPE_ALL, key: GITHUB_CONNECT_MODE_SETTING_KEY });
    if (seq !== latest) return;
    if (row.ok) publish({ mode: githubConnectMode(row.value), loaded: true, error: null });
    else publish({ ...snapshot, error: plainErrorText(row.message, fallback) });
  } catch (error) {
    if (seq === latest) publish({ ...snapshot, error: plainErrorText(error, fallback) });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopWatching) {
    const reread = () => void read();
    const offChanged = window.ade?.accountSettings?.onChanged?.(reread) ?? (() => {});
    window.addEventListener("focus", reread);
    stopWatching = () => {
      offChanged();
      window.removeEventListener("focus", reread);
    };
    void read();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
  };
}

/**
 * Saves the choice for the account. Resolves to null, or one sentence when it
 * did not save; the page then shows the choice it had.
 */
export async function setGithubConnectMode(mode: GithubConnectMode): Promise<string | null> {
  const settings = window.ade?.accountSettings;
  if (!settings) return "This window can't change account settings.";
  if (saving) return `${BRAND.NAME} is already saving this choice.`;
  saving = true;
  latest += 1;
  try {
    const written = await settings.set({ scope: ACCOUNT_SCOPE_ALL, key: GITHUB_CONNECT_MODE_SETTING_KEY, value: mode });
    if (!written.ok) return plainErrorText(written.message, `${BRAND.NAME} couldn't save this choice.`);
    publish({ mode, loaded: true, error: null });
    // Let the other computers receive the selection without waiting for the next tick.
    void settings.sync().catch(() => undefined);
    return null;
  } catch (error) {
    return plainErrorText(error, `${BRAND.NAME} couldn't save this choice.`);
  } finally {
    saving = false;
  }
}

/** The account's choice; `loaded` is false until the first read answered. */
export function refreshGithubConnectMode(): Promise<void> {
  return read();
}

export function useGithubConnectMode(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/**
 * The sign-in rows the GitHub page lists. GitHub CLI only leaves out idle app
 * rows, and the token row unless a token is saved (so it can be removed). A
 * row in use always stays, so the list agrees with "Reads with".
 */
export function visibleGithubSignInRows(
  rows: readonly GitHubCredentialState[],
  mode: GithubConnectMode,
  patTokenStored: boolean,
): GitHubCredentialState[] {
  if (mode !== "cli_only") return [...rows];
  return rows.filter((row) => {
    if (row.activeFor.length > 0) return true;
    if (row.source === "app" || row.source === "account_app") return false;
    return row.source !== "pat" || patTokenStored;
  });
}
