/**
 * Makes "Stored in your ADE account" true for the preferences that claim it.
 *
 * Settings has shown that chip on every account-scoped row since the scope
 * model landed, but nothing read from or wrote to the account settings store —
 * every one of those preferences lived in this machine's localStorage and went
 * no further. This module is the missing half: one hydrator that pulls the
 * account's rows in, and one subscription that pushes local changes back out.
 *
 * Three rules shape it.
 *
 * Local first. A setter writes to the store and to localStorage exactly as it
 * always did, and only then does the account hear about it. Offline, signed
 * out, brain restarting — the preference still changes, instantly, and syncs
 * when it can. A settings page that waited on a Worker would be unusable on a
 * train, and the account is supposed to make settings follow you, not make
 * them require a server.
 *
 * Newer only, per key. Every key carries a local `updatedAt`, so a remote row
 * is applied only when it is strictly newer than what this machine holds. That
 * is the same last-writer-wins rule the brain's store uses, and keeping the
 * comparison per key rather than per blob is what stops one machine's theme
 * change reverting another machine's font size. The user is never shown a
 * conflict, because there is never a conflict to show: one of the two writes
 * is simply older.
 *
 * Never revert the writer. A machine stamps its own change before sending it,
 * so a pull that races the upload finds a local stamp at least as new as the
 * server's and leaves the value alone. Watching your own edit undo itself is
 * the single worst failure this path can have.
 *
 * Machine-scoped settings are absent from the registry below, by construction.
 * They hold paths, ports and hardware facts; they are meaningless on another
 * computer and must never reach the store.
 */

import {
  ACCOUNT_SCOPE_ALL,
  accountRepoScopeKey,
  isAccountScope,
} from "../../shared/accountSettingsScope";
import type { AccountSettingRow, AccountSettingsResult } from "../../shared/types/accountSettings";
import type { SettingScope } from "../components/settings/settingsManifest";

/** How often a signed-in machine reconciles with the account. */
export const ACCOUNT_SETTINGS_POLL_MS = 30_000;

/**
 * Where each key's local stamp lives. Separate from the preferences blob so a
 * preferences migration cannot silently reset every key's sync clock.
 */
const STAMPS_STORAGE_KEY = "ade.accountSettings.stamps.v1";

/**
 * The app-store slice this module reads and writes.
 *
 * Structural rather than `AppState` so a test can drive the whole path with a
 * hand-built object instead of booting the real store.
 */
export type AccountSyncedState = Record<string, unknown>;

export type AccountSyncedStore = {
  getState(): AccountSyncedState;
  subscribe(listener: () => void): () => void;
};

/**
 * One synced preference: where to read it in the store, and how to write it.
 *
 * `apply` goes through the store's own setter rather than `setState` so the
 * value is normalized and persisted to localStorage by exactly the code path a
 * user click uses. A hydrator that wrote raw state would be a second writer
 * with its own bugs.
 */
export type AccountSyncedSetting = {
  /** The store key, which is also the account store's key. One name, not two. */
  key: string;
  scope: SettingScope;
  read: (state: AccountSyncedState) => unknown;
  apply: (state: AccountSyncedState, value: unknown) => void;
};

function callSetter(state: AccountSyncedState, setter: string, value: unknown): void {
  const fn = state[setter];
  if (typeof fn === "function") (fn as (arg: unknown) => void)(value);
}

/** A plain value setting: `key` in the store, `set<Key>` to write it. */
function pref(key: string, setter: string, scope: SettingScope = "account"): AccountSyncedSetting {
  return {
    key,
    scope,
    read: (state) => state[key],
    apply: (state, value) => callSetter(state, setter, value),
  };
}

/**
 * Every account-scoped preference the app store persists.
 *
 * Exactly the contents of the `ade.userPreferences.v1` blob, minus
 * `userOverrodeChatFontSize` — that flag records that the user has taken the
 * chat font size off auto-sizing on THIS display, so it describes a screen
 * rather than a preference and stays machine-local. The font size itself does
 * travel.
 */
export const ACCOUNT_SYNCED_SETTINGS: readonly AccountSyncedSetting[] = [
  pref("theme", "setTheme"),
  pref("terminalPreferences", "setTerminalPreferences"),
  pref("smartTooltipsEnabled", "setSmartTooltipsEnabled"),
  pref("launchPromptClipboardEnabled", "setLaunchPromptClipboardEnabled"),
  pref("launchPromptClipboardNoticeEnabled", "setLaunchPromptClipboardNoticeEnabled"),
  pref("promptStashButtonEnabled", "setPromptStashButtonEnabled"),
  pref("voiceInputEnabled", "setVoiceInputEnabled"),
  pref("codeBlockCopyButtonPosition", "setCodeBlockCopyButtonPosition"),
  pref("agentTurnCompletionSound", "setAgentTurnCompletionSound"),
  pref("agentTurnCompletionSoundVolume", "setAgentTurnCompletionSoundVolume"),
  pref("agentTurnCompletionSoundQuietWhenFocused", "setAgentTurnCompletionSoundQuietWhenFocused"),
  pref("chatFontSizePx", "setChatFontSizePx"),
  pref("chatUserMinimapEnabled", "setChatUserMinimapEnabled"),
  pref("chatTranscriptDensity", "setChatTranscriptDensity"),
  pref("chatChromeTint", "setChatChromeTint"),
  pref("chatShellGeometry", "setChatShellGeometry"),
] as const;

export type AccountSettingsApi = {
  list(args?: { scope?: string | null }): Promise<AccountSettingsResult<AccountSettingRow[]>>;
  set(args: { scope: string; key: string; value: unknown }): Promise<AccountSettingsResult<null>>;
  sync(): Promise<AccountSettingsResult<null>>;
};

export type AccountSettingsSyncOptions = {
  store: AccountSyncedStore;
  /** Null whenever the bridge is missing — the web client, an older preload. */
  getApi: () => AccountSettingsApi | null | undefined;
  /** Whether an account is signed in right now. Re-read, never captured. */
  isSignedIn: () => boolean;
  /** Fires whenever the signed-in account changes. */
  subscribeSignedIn?: (listener: () => void) => () => void;
  /** The open project's git remote, for `account-repo` keys. */
  getProjectRemote?: () => string | null;
  settings?: readonly AccountSyncedSetting[];
  pollMs?: number;
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

type Stamps = Record<string, string>;

function readStamps(storage: Pick<Storage, "getItem" | "setItem"> | undefined): Stamps {
  try {
    const raw = storage?.getItem(STAMPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const stamps: Stamps = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") stamps[key] = value;
    }
    return stamps;
  } catch {
    // An unreadable stamp file is a cold start, not an error: every remote row
    // then looks newer, so the machine converges to the account's copy — the
    // right outcome for a machine that has lost its own history.
    return {};
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  // Terminal preferences are an object the setter replaces wholesale; a deep
  // compare is what keeps a rehydrate from looking like a user edit.
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Starts hydrating from, and writing through to, the account settings store.
 *
 * Returns a stop function. Safe to call with no bridge, no account, and no
 * network: each of those simply means the machine keeps its local copy.
 */
export function startAccountSettingsSync(options: AccountSettingsSyncOptions): () => void {
  const settings = (options.settings ?? ACCOUNT_SYNCED_SETTINGS).filter((entry) =>
    isAccountScope(entry.scope),
  );
  const now = options.now ?? Date.now;
  const storage = options.storage
    ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  const schedule = options.setInterval
    ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown);
  const unschedule = options.clearInterval
    ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let stopped = false;
  let applying = false;
  let stamps = readStamps(storage);

  const persistStamps = (): void => {
    try {
      storage?.setItem(STAMPS_STORAGE_KEY, JSON.stringify(stamps));
    } catch {
      // A stamp we could not persist costs one redundant apply after a reload.
      // Failing the user's setting change over it would be far worse.
    }
  };

  /**
   * The account-store scope for one setting, or null when it must stay local.
   *
   * Null is a real answer for a repo-scoped key in a project with no remote:
   * such a checkout has no identity that means anything on a second machine,
   * so its settings wait here until it gets one.
   */
  const scopeKeyFor = (entry: AccountSyncedSetting): string | null => {
    if (entry.scope === "account") return ACCOUNT_SCOPE_ALL;
    return accountRepoScopeKey(options.getProjectRemote?.() ?? null);
  };

  const stampKey = (scopeKey: string, key: string): string => `${scopeKey} ${key}`;

  const snapshot = (): Map<string, unknown> => {
    const state = options.store.getState();
    const seen = new Map<string, unknown>();
    for (const entry of settings) seen.set(entry.key, entry.read(state));
    return seen;
  };

  const lastSeen = snapshot();

  /** Pull the account's rows and apply the ones that are newer than ours. */
  const hydrate = async (): Promise<void> => {
    const api = options.getApi();
    if (!api || !options.isSignedIn() || stopped) return;
    const byKey = new Map(settings.map((entry) => [entry.key, entry]));
    const scopes = new Set<string>();
    for (const entry of settings) {
      const scopeKey = scopeKeyFor(entry);
      if (scopeKey) scopes.add(scopeKey);
    }
    for (const scope of scopes) {
      const result = await api.list({ scope });
      if (stopped || !result.ok) continue;
      const state = options.store.getState();
      for (const row of result.value) {
        const entry = byKey.get(row.key);
        if (!entry || scopeKeyFor(entry) !== row.scope) continue;
        const stamp = stamps[stampKey(row.scope, row.key)];
        // Strictly newer. An equal stamp means this machine already holds the
        // row it is being handed, and re-applying it would be a write with no
        // change behind it.
        if (stamp && Date.parse(row.updatedAt) <= Date.parse(stamp)) continue;
        applying = true;
        try {
          entry.apply(state, row.value);
        } finally {
          applying = false;
        }
        stamps[stampKey(row.scope, row.key)] = row.updatedAt;
        lastSeen.set(entry.key, entry.read(options.store.getState()));
      }
      persistStamps();
    }
  };

  /** Push one local change. Stamped before it leaves, so a racing pull loses. */
  const push = (entry: AccountSyncedSetting, value: unknown): void => {
    const api = options.getApi();
    const scopeKey = scopeKeyFor(entry);
    if (!scopeKey) return;
    stamps[stampKey(scopeKey, entry.key)] = new Date(now()).toISOString();
    persistStamps();
    if (!api || !options.isSignedIn()) return;
    void api.set({ scope: scopeKey, key: entry.key, value }).catch(() => {
      // The brain's own store queues and retries uploads. Nothing useful is
      // left for the renderer to do, and a toast for a theme change that DID
      // take effect locally would be noise.
    });
  };

  const onStoreChange = (): void => {
    if (applying || stopped) return;
    const state = options.store.getState();
    for (const entry of settings) {
      const value = entry.read(state);
      if (sameValue(value, lastSeen.get(entry.key))) continue;
      lastSeen.set(entry.key, value);
      push(entry, value);
    }
  };

  const unsubscribeStore = options.store.subscribe(onStoreChange);

  const unsubscribeAccount = options.subscribeSignedIn?.(() => {
    // A fresh sign-in is the one moment the account certainly holds rows this
    // machine has never seen. Re-read the stamps too: a different account's
    // history must not decide what counts as newer for this one.
    stamps = readStamps(storage);
    void hydrate();
  });

  void hydrate();

  const timer = schedule(() => {
    const api = options.getApi();
    if (!api || !options.isSignedIn()) return;
    // `sync` flushes this machine's queue and takes what changed; `list` then
    // reads the merged result out of the local cache, so the poll costs one
    // round trip to the Worker rather than one per key.
    void api
      .sync()
      .catch(() => null)
      .then(() => hydrate())
      .catch(() => null);
  }, options.pollMs ?? ACCOUNT_SETTINGS_POLL_MS);

  return () => {
    stopped = true;
    unsubscribeStore();
    unsubscribeAccount?.();
    unschedule(timer);
  };
}

