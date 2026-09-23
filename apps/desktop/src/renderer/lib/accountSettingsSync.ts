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
import type {
  AccountSettingRow,
  AccountSettingsResult,
  AccountSettingsWriteOptions,
} from "../../shared/types/accountSettings";
import type { SettingScope } from "../components/settings/settingsManifest";
import type { AppState } from "../state/appStore";

/** How often a signed-in machine reconciles with the account. */
export const ACCOUNT_SETTINGS_POLL_MS = 30_000;

/**
 * Where each key's local stamp lives. Separate from the preferences blob so a
 * preferences migration cannot silently reset every key's sync clock.
 */
const STAMPS_STORAGE_KEY = "ade.accountSettings.stamps.v1";
const DIRTY_STORAGE_KEY = "ade.accountSettings.dirty.v1";

/**
 * The app-store slice this module reads and writes.
 *
 * Generic so the sync engine can be tested with a small state fixture while
 * the production registry remains tied to the real app store below.
 */
export type AccountSyncedState = AppState;

export type AccountSyncedStore<State = AccountSyncedState> = {
  getState(): State;
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
export type AccountSyncedSetting<State = AccountSyncedState> = {
  /** The store key, which is also the account store's key. One name, not two. */
  key: string;
  scope: SettingScope;
  read: (state: State) => unknown;
  apply: (state: State, value: unknown) => void;
};

/** A plain value setting with a setter checked against the real app state. */
function pref<Value>(
  key: string,
  read: (state: AppState) => Value,
  apply: (state: AppState, value: Value) => void,
  scope: SettingScope = "account",
): AccountSyncedSetting {
  return {
    key,
    scope,
    read,
    apply: (state, value) => apply(state, value as Value),
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
  pref("theme", (state) => state.theme, (state, value) => state.setTheme(value)),
  pref("terminalPreferences", (state) => state.terminalPreferences, (state, value) => state.setTerminalPreferences(value)),
  pref("smartTooltipsEnabled", (state) => state.smartTooltipsEnabled, (state, value) => state.setSmartTooltipsEnabled(value)),
  pref("launchPromptClipboardEnabled", (state) => state.launchPromptClipboardEnabled, (state, value) => state.setLaunchPromptClipboardEnabled(value)),
  pref("launchPromptClipboardNoticeEnabled", (state) => state.launchPromptClipboardNoticeEnabled, (state, value) => state.setLaunchPromptClipboardNoticeEnabled(value)),
  pref("promptStashButtonEnabled", (state) => state.promptStashButtonEnabled, (state, value) => state.setPromptStashButtonEnabled(value)),
  pref("voiceInputEnabled", (state) => state.voiceInputEnabled, (state, value) => state.setVoiceInputEnabled(value)),
  pref("codeBlockCopyButtonPosition", (state) => state.codeBlockCopyButtonPosition, (state, value) => state.setCodeBlockCopyButtonPosition(value)),
  pref("agentTurnCompletionSound", (state) => state.agentTurnCompletionSound, (state, value) => state.setAgentTurnCompletionSound(value)),
  pref("agentTurnCompletionSoundVolume", (state) => state.agentTurnCompletionSoundVolume, (state, value) => state.setAgentTurnCompletionSoundVolume(value)),
  pref("agentTurnCompletionSoundQuietWhenFocused", (state) => state.agentTurnCompletionSoundQuietWhenFocused, (state, value) => state.setAgentTurnCompletionSoundQuietWhenFocused(value)),
  pref("chatFontSizePx", (state) => state.chatFontSizePx, (state, value) => state.setChatFontSizePx(value)),
  pref("chatUserMinimapEnabled", (state) => state.chatUserMinimapEnabled, (state, value) => state.setChatUserMinimapEnabled(value)),
  pref("chatTranscriptDensity", (state) => state.chatTranscriptDensity, (state, value) => state.setChatTranscriptDensity(value)),
  pref("chatChromeTint", (state) => state.chatChromeTint, (state, value) => state.setChatChromeTint(value)),
  pref("chatShellGeometry", (state) => state.chatShellGeometry, (state, value) => state.setChatShellGeometry(value)),
  // Harness presets are a list rather than a scalar, which the registry handles
  // unchanged: the whole list is one value under one key, so the newer-wins
  // rule applies to the list as a whole and two machines never interleave
  // half of each other's edits into one preset.
  pref("harnessPresets", (state) => state.harnessPresets, (state, value) => state.setHarnessPresets(value)),
  pref(
    "apple.realisticBody",
    (state) => state.appleDevice.realisticBody,
    (state, value) => {
      if (typeof value === "boolean") state.setAppleDevicePreferences({ realisticBody: value });
    },
  ),
  pref(
    "apple.recordingOverlays.tapRings",
    (state) => state.appleDevice.recordingTapRings,
    (state, value) => {
      if (typeof value === "boolean") state.setAppleDevicePreferences({ recordingTapRings: value });
    },
  ),
  pref(
    "apple.recordingOverlays.keyBadges",
    (state) => state.appleDevice.recordingKeyBadges,
    (state, value) => {
      if (typeof value === "boolean") state.setAppleDevicePreferences({ recordingKeyBadges: value });
    },
  ),
  pref(
    "apple.remoteBitrateKbpsCap",
    (state) => state.appleDevice.remoteBitrateKbpsCap,
    (state, value) => {
      if (typeof value === "number") state.setAppleDevicePreferences({ remoteBitrateKbpsCap: value });
    },
  ),
  pref(
    "apple.recordingsWarnBytes",
    (state) => state.appleDevice.recordingsWarnBytes,
    (state, value) => {
      if (typeof value === "number") state.setAppleDevicePreferences({ recordingsWarnBytes: value });
    },
  ),
] as const;

export type AccountSettingsApi = {
  list(args?: { scope?: string | null }): Promise<AccountSettingsResult<AccountSettingRow[]>>;
  set(
    args: { scope: string; key: string; value: unknown } & AccountSettingsWriteOptions,
  ): Promise<AccountSettingsResult<null>>;
  sync(): Promise<AccountSettingsResult<null>>;
};

type AccountSettingsSyncOptionsBase<State> = {
  store: AccountSyncedStore<State>;
  /** Null whenever the bridge is missing — the web client, an older preload. */
  getApi: () => AccountSettingsApi | null | undefined;
  /** Whether an account is signed in right now. Re-read, never captured. */
  isSignedIn: () => boolean;
  /** Current account identity; null while signed out. */
  getAccountUserId?: () => string | null;
  /** Fires whenever the signed-in account changes. */
  subscribeSignedIn?: (listener: () => void) => () => void;
  /** The open project's git remote, for `account-repo` keys. */
  getProjectRemote?: () => string | null;
  settings?: readonly AccountSyncedSetting<State>[];
  pollMs?: number;
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export type AccountSettingsSyncOptions<State = AccountSyncedState> =
  State extends AccountSyncedState
    ? AccountSettingsSyncOptionsBase<State>
    : AccountSettingsSyncOptionsBase<State> & {
        /** Custom state registries must declare the settings they synchronize. */
        settings: readonly AccountSyncedSetting<State>[];
      };

type Stamps = Record<string, string>;
type StampsByUser = Record<string, Stamps>;

function readStampNamespaces(storage: Pick<Storage, "getItem" | "setItem"> | undefined): StampsByUser {
  try {
    const raw = storage?.getItem(STAMPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const namespaces: StampsByUser = {};
    for (const [userId, rawStamps] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rawStamps || typeof rawStamps !== "object" || Array.isArray(rawStamps)) continue;
      const stamps: Stamps = {};
      for (const [key, value] of Object.entries(rawStamps as Record<string, unknown>)) {
        if (typeof value === "string") stamps[key] = value;
      }
      if (Object.keys(stamps).length) namespaces[userId] = stamps;
    }
    // A flat pre-identity map is intentionally ignored. Reusing it for a new
    // account would let one user's history suppress another user's rows.
    return namespaces;
  } catch {
    // An unreadable stamp file is a cold start, not an error: every remote row
    // then looks newer, so the machine converges to the account's copy — the
    // right outcome for a machine that has lost its own history.
    return {};
  }
}

function readStamps(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  userId: string | null,
): Stamps {
  return userId ? readStampNamespaces(storage)[userId] ?? {} : {};
}

function readDirtyKeys(storage: Pick<Storage, "getItem" | "setItem"> | undefined): Set<string> {
  try {
    const raw = storage?.getItem(DIRTY_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [],
    );
  } catch {
    return new Set();
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
export function startAccountSettingsSync<State = AccountSyncedState>(
  options: AccountSettingsSyncOptions<State>,
): () => void {
  const settings = (options.settings
    ?? (ACCOUNT_SYNCED_SETTINGS as readonly AccountSyncedSetting<State>[])).filter((entry) =>
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
  const resolveAccountUserId = (): string | null => {
    if (!options.isSignedIn()) return null;
    // The fallback keeps the standalone engine compatible with older test and
    // hosted-web callers that only exposed a boolean status. The desktop hook
    // always supplies the real user id, which is what namespaces credentials.
    return options.getAccountUserId?.()?.trim() || "__signed-in__";
  };
  let accountUserId = resolveAccountUserId();
  let identityGeneration = 0;
  let stamps = readStamps(storage, accountUserId);
  const dirtyKeys = readDirtyKeys(storage);

  const persistStamps = (): void => {
    try {
      if (!accountUserId) return;
      const namespaces = readStampNamespaces(storage);
      namespaces[accountUserId] = stamps;
      storage?.setItem(STAMPS_STORAGE_KEY, JSON.stringify(namespaces));
    } catch {
      // A stamp we could not persist costs one redundant apply after a reload.
      // Failing the user's setting change over it would be far worse.
    }
  };

  const persistDirtyKeys = (): void => {
    try {
      storage?.setItem(DIRTY_STORAGE_KEY, JSON.stringify(Array.from(dirtyKeys).sort()));
    } catch {
      // The local setting already applied; losing the retry marker only costs a
      // later convergence attempt on a storage implementation that is full.
    }
  };

  /**
   * The account-store scope for one setting, or null when it must stay local.
   *
   * Null is a real answer for a repo-scoped key in a project with no remote:
   * such a checkout has no identity that means anything on a second machine,
   * so its settings wait here until it gets one.
   */
  const scopeKeyFor = (entry: AccountSyncedSetting<State>): string | null => {
    if (entry.scope === "account") return ACCOUNT_SCOPE_ALL;
    return accountRepoScopeKey(options.getProjectRemote?.() ?? null);
  };

  const stampKey = (scopeKey: string, key: string): string => `${scopeKey} ${key}`;
  const dirtyKey = (userId: string | null, key: string): string =>
    `${userId ?? "__signed-out__"}\u0000${key}`;

  const snapshot = (): Map<string, unknown> => {
    const state = options.store.getState();
    const seen = new Map<string, unknown>();
    for (const entry of settings) seen.set(entry.key, entry.read(state));
    return seen;
  };

  // Existing values are not dirty edits. After a successful sync, hydrate
  // still uploads any key the account has never stored, so a first sign-in
  // does not leave this machine's preferences stranded locally.
  const lastSeen = snapshot();

  /** Pull the account's rows and apply the ones that are newer than ours. */
  const hydrate = async (hydrateOptions: { seedMissing?: boolean } = {}): Promise<void> => {
    const api = options.getApi();
    const userIdAtStart = resolveAccountUserId();
    const generationAtStart = identityGeneration;
    if (!api || !userIdAtStart || stopped || userIdAtStart !== accountUserId) return;
    const isCurrentIdentity = (): boolean =>
      !stopped
      && identityGeneration === generationAtStart
      && resolveAccountUserId() === userIdAtStart
      && accountUserId === userIdAtStart;
    const byKey = new Map(settings.map((entry) => [entry.key, entry]));
    const scopes = new Set<string>();
    for (const entry of settings) {
      const scopeKey = scopeKeyFor(entry);
      if (scopeKey) scopes.add(scopeKey);
    }
    const seenRemoteKeys = new Set<string>();
    for (const scope of scopes) {
      const result = await api.list({ scope });
      if (!isCurrentIdentity() || !result.ok) return;
      const state = options.store.getState();
      for (const row of result.value) {
        const entry = byKey.get(row.key);
        if (!entry || scopeKeyFor(entry) !== row.scope) continue;
        seenRemoteKeys.add(stampKey(row.scope, row.key));
        if (dirtyKeys.has(dirtyKey(userIdAtStart, entry.key)) || dirtyKeys.has(dirtyKey(null, entry.key))) continue;
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
      if (!isCurrentIdentity()) return;
      persistStamps();
    }
    if (!isCurrentIdentity()) return;
    // Seed only after a successful sync. A cold cache lists as empty even
    // when the account already has rows; uploading local defaults then
    // last-writer-wins over those rows. Once sync has merged the Worker,
    // an empty list is a genuinely empty account and this machine's
    // existing preferences should follow the user.
    if (!hydrateOptions.seedMissing) return;
    const localState = options.store.getState();
    for (const entry of settings) {
      const scopeKey = scopeKeyFor(entry);
      if (!scopeKey) continue;
      const key = stampKey(scopeKey, entry.key);
      if (seenRemoteKeys.has(key) || stamps[key]) continue;
      push(entry, entry.read(localState));
    }
  };

  const pullThenHydrate = async (): Promise<void> => {
    const api = options.getApi();
    const userIdAtStart = resolveAccountUserId();
    const generationAtStart = identityGeneration;
    if (!api || !userIdAtStart || stopped || settings.length === 0) return;
    let synced = false;
    try {
      const result = await api.sync();
      synced = result.ok === true;
    } catch {
      synced = false;
    }
    if (stopped) return;
    // Identity changed while the Worker merge was in flight. The new
    // owner's pullThenHydrate is already running; starting hydrate here
    // would capture that owner and apply the previous account's rows.
    if (
      identityGeneration !== generationAtStart
      || resolveAccountUserId() !== userIdAtStart
      || accountUserId !== userIdAtStart
    ) {
      return;
    }
    await hydrate({ seedMissing: synced });
  };

  function markDirtyKey(key: string): void {
    dirtyKeys.add(key);
    persistDirtyKeys();
  }

  /** Push one local change, stamping only after the request is queued. */
  function push(
    entry: AccountSyncedSetting<State>,
    value: unknown,
    existingDirtyKey = dirtyKey(accountUserId, entry.key),
  ): void {
    const api = options.getApi();
    const scopeKey = scopeKeyFor(entry);
    const userIdAtQueue = accountUserId;
    if (!scopeKey || !api || !options.isSignedIn() || !userIdAtQueue) {
      markDirtyKey(existingDirtyKey);
      return;
    }
    try {
      const generationAtQueue = identityGeneration;
      if (resolveAccountUserId() !== userIdAtQueue) {
        markDirtyKey(existingDirtyKey);
        return;
      }
      // Calling set is the queue boundary. Do not move the stamp earlier: a
      // signed-out edit must remain dirty and must not suppress its next pull.
      const pending = api.set({
        scope: scopeKey,
        key: entry.key,
        value,
        expectedAccountUserId: userIdAtQueue,
      });
      if (identityGeneration !== generationAtQueue || resolveAccountUserId() !== userIdAtQueue) {
        markDirtyKey(existingDirtyKey);
        return;
      }
      stamps[stampKey(scopeKey, entry.key)] = new Date(now()).toISOString();
      dirtyKeys.delete(existingDirtyKey);
      persistStamps();
      persistDirtyKeys();
      void Promise.resolve(pending).then((result) => {
        if (!result || result.ok !== true) markDirtyKey(existingDirtyKey);
      }).catch(() => {
        markDirtyKey(existingDirtyKey);
      });
    } catch {
      markDirtyKey(existingDirtyKey);
    }
  }

  const flushDirty = (): void => {
    if (!options.isSignedIn() || !accountUserId || !options.getApi()) return;
    const state = options.store.getState();
    for (const entry of settings) {
      const accountDirtyKey = dirtyKey(accountUserId, entry.key);
      const signedOutDirtyKey = dirtyKey(null, entry.key);
      if (!dirtyKeys.has(accountDirtyKey) && !dirtyKeys.has(signedOutDirtyKey)) continue;
      push(entry, entry.read(state), dirtyKeys.has(accountDirtyKey) ? accountDirtyKey : signedOutDirtyKey);
    }
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
    const nextUserId = resolveAccountUserId();
    if (nextUserId === accountUserId) return;
    // Invalidate every pending list response before switching the namespace.
    identityGeneration += 1;
    accountUserId = nextUserId;
    stamps = readStamps(storage, accountUserId);
    lastSeen.clear();
    for (const [key, value] of snapshot()) lastSeen.set(key, value);
    flushDirty();
    void pullThenHydrate();
  });

  void pullThenHydrate();

  const timer = schedule(() => {
    if (!options.getApi() || !options.isSignedIn()) return;
    // Same sync-then-hydrate path as first sign-in, including the identity
    // abort. Seed still happens only when that merge succeeded.
    flushDirty();
    void pullThenHydrate();
  }, options.pollMs ?? ACCOUNT_SETTINGS_POLL_MS);

  return () => {
    stopped = true;
    unsubscribeStore();
    unsubscribeAccount?.();
    unschedule(timer);
  };
}
