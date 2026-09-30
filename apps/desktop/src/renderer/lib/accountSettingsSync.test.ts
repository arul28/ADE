import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SYNCED_SETTINGS,
  startAccountSettingsSync,
  type AccountSettingsApi,
  type AccountSettingsSyncOptions,
  type AccountSyncedSetting,
  type AccountSyncedStore,
} from "./accountSettingsSync";
import type { AccountSettingRow } from "../../shared/types/accountSettings";

// ---------------------------------------------------------------------------
// A stand-in for the app store: the two registered settings below read plain
// fields and write them through setters, exactly as the real registry does.
// ---------------------------------------------------------------------------

type FakeState = {
  theme: string;
  chatFontSizePx: number;
  setTheme: (value: string) => void;
  setChatFontSizePx: (value: number) => void;
};

function createStore(initial: Partial<Pick<FakeState, "theme" | "chatFontSizePx">>) {
  const listeners = new Set<() => void>();
  const state: FakeState = {
    theme: initial.theme ?? "dark",
    chatFontSizePx: initial.chatFontSizePx ?? 14,
    setTheme: (value: string) => {
      state.theme = value;
      for (const listener of listeners) listener();
    },
    setChatFontSizePx: (value: number) => {
      state.chatFontSizePx = value;
      for (const listener of listeners) listener();
    },
  };
  const store: AccountSyncedStore<FakeState> = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { store, state };
}

const SETTINGS: readonly AccountSyncedSetting<FakeState>[] = [
  {
    key: "theme",
    scope: "account",
    read: (state) => state.theme,
    apply: (state, value) => state.setTheme(value as string),
  },
  {
    key: "chatFontSizePx",
    scope: "account",
    read: (state) => state.chatFontSizePx,
    apply: (state, value) => state.setChatFontSizePx(value as number),
  },
];

const REPO_SETTINGS: readonly AccountSyncedSetting<FakeState>[] = [
  {
    key: "theme",
    scope: "account-repo",
    read: (state) => state.theme,
    apply: (state, value) => state.setTheme(value as string),
  },
];

const MACHINE_SETTINGS: readonly AccountSyncedSetting<FakeState>[] = [
  {
    key: "theme",
    scope: "machine",
    read: (state) => state.theme,
    apply: (state, value) => state.setTheme(value as string),
  },
];

function row(key: string, value: unknown, updatedAt: string, scope = "all"): AccountSettingRow {
  return { scope, key, value, updatedAt, changedAt: updatedAt, writerDeviceId: "other" };
}

function createApi(rows: AccountSettingRow[] = []) {
  const api: AccountSettingsApi & {
    list: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    sync: ReturnType<typeof vi.fn>;
  } = {
    list: vi.fn(async (args?: { scope?: string | null }) => ({
      ok: true as const,
      value: rows.filter((r) => !args?.scope || r.scope === args.scope),
    })),
    set: vi.fn(async () => ({ ok: true as const, value: null })),
    sync: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  return api;
}

function createStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

/** Lets the module's floating hydrate promise settle. */
const settle = async () => {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
};

let timers: Array<() => void>;

type FakeSyncOverrides = Omit<AccountSettingsSyncOptions<FakeState>, "settings"> & {
  settings?: readonly AccountSyncedSetting<FakeState>[];
};

function baseOptions(overrides: FakeSyncOverrides) {
  const { settings = SETTINGS, ...rest } = overrides;
  return {
    settings,
    storage: createStorage(),
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearInterval: () => {},
    ...rest,
  } satisfies AccountSettingsSyncOptions<FakeState>;
}

beforeEach(() => {
  timers = [];
});

describe("accountSettingsSync (renderer)", () => {
  it("registers exactly the account-scoped persisted preferences", () => {
    // `theme` (the painted base mode) is deliberately absent: a machine that
    // follows its OS derives it, so syncing it would let one machine's OS event
    // become another machine's choice. `themeId` + `themeFollowsSystem` carry
    // the real choices and reconstruct `theme` locally.
    expect(ACCOUNT_SYNCED_SETTINGS.map((entry) => entry.key)).toEqual([
      "themeId",
      "customThemes",
      "themeFollowsSystem",
      "interfacePreferences",
      "terminalPreferences",
      "smartTooltipsEnabled",
      "launchPromptClipboardEnabled",
      "launchPromptClipboardNoticeEnabled",
      "promptStashButtonEnabled",
      "voiceInputEnabled",
      "codexVoice",
      "codeBlockCopyButtonPosition",
      "agentTurnCompletionSound",
      "agentTurnCompletionSoundVolume",
      "agentTurnCompletionSoundQuietWhenFocused",
      "chatFontSizePx",
      "chatUserMinimapEnabled",
      "chatTranscriptDensity",
      "chatChromeTint",
      "chatShellGeometry",
      "harnessPresets",
      "apple.realisticBody",
      "apple.recordingOverlays.tapRings",
      "apple.recordingOverlays.keyBadges",
      "apple.remoteBitrateKbpsCap",
      "apple.recordingsWarnBytes",
    ]);
    // The screen-specific auto-size lock is deliberately machine-local.
    expect(ACCOUNT_SYNCED_SETTINGS.map((entry) => entry.key)).not.toContain(
      "userOverrodeChatFontSize",
    );
    expect(ACCOUNT_SYNCED_SETTINGS.every((entry) => entry.scope === "account")).toBe(true);
  });

  it("hydrates a remote value the machine has never seen", async () => {
    const { store, state } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi([row("theme", "light", "2026-01-02T00:00:00.000Z")]);
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true }),
    );
    await settle();
    expect(state.theme).toBe("light");
    expect(api.set).not.toHaveBeenCalledWith(expect.objectContaining({ key: "theme" }));
    stop();
  });

  it("uploads existing local preferences the account has never stored", async () => {
    const { store } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi();
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true }),
    );
    await settle();
    expect(api.set).toHaveBeenCalledWith({
      scope: "all",
      key: "theme",
      value: "dark",
    });
    expect(api.set).toHaveBeenCalledWith({
      scope: "all",
      key: "chatFontSizePx",
      value: 14,
    });
    stop();
  });

  it("does not upload local defaults before the account cache has synced", async () => {
    const { store } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi();
    api.sync.mockResolvedValue({
      ok: false as const,
      unavailable: true as const,
      message: "offline",
    });
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true }),
    );
    await settle();
    expect(api.set).not.toHaveBeenCalled();
    stop();
  });

  it("seeds missing local preferences once a later poll syncs an empty account", async () => {
    const { store } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi();
    api.sync
      .mockResolvedValueOnce({
        ok: false as const,
        unavailable: true as const,
        message: "offline",
      })
      .mockResolvedValue({ ok: true as const, value: null });
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true }),
    );
    await settle();
    expect(api.set).not.toHaveBeenCalled();

    timers[0]?.();
    await settle();
    expect(api.set).toHaveBeenCalledWith({
      scope: "all",
      key: "theme",
      value: "dark",
    });
    stop();
  });

  it("A1: fences a write with the REAL account id, and with no id when there is none", async () => {
    // A boolean-only sign-in has no id to fence with. Sending the engine's own
    // namespace placeholder instead is a claim that is always wrong: the
    // brain compares it against the owner it really holds and refuses, and the
    // key stays dirty for as long as the placeholder is what gets sent.
    const anonymous = createStore({ theme: "dark", chatFontSizePx: 14 });
    const anonymousApi = createApi();
    const stopAnonymous = startAccountSettingsSync(
      baseOptions({ store: anonymous.store, getApi: () => anonymousApi, isSignedIn: () => true }),
    );
    await settle();
    anonymous.state.setTheme("light");
    expect(anonymousApi.set).toHaveBeenCalledWith({ scope: "all", key: "theme", value: "light" });
    stopAnonymous();

    // With a real id, the fence is sent — that is what makes the write's
    // "ownership changed" answer meaningful.
    const owned = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi();
    const stop = startAccountSettingsSync(
      baseOptions({
        store: owned.store,
        getApi: () => api,
        isSignedIn: () => true,
        getAccountUserId: () => "user_1",
      }),
    );
    await settle();
    owned.state.setTheme("light");
    expect(api.set).toHaveBeenCalledWith({
      scope: "all",
      key: "theme",
      value: "light",
      expectedAccountUserId: "user_1",
    });
    stop();
  });

  it("A1c: does not report a write confirmed after the account changed", async () => {
    // The acknowledgement belongs to the account the request was sent as. If
    // someone signs in as another account while it is in flight, that "ok" says
    // nothing about the account signed in now — so it must not be handed back
    // as a confirmation a caller can act on, and the value stays queued under
    // the account it was written for.
    const { store } = createStore({ theme: "dark" });
    const storage = createStorage();
    // Held as a list because a `let` the callback writes is narrowed to `null`
    // by the time the test calls it (control-flow analysis cannot see the
    // callback run). The LAST entry is this test's `flushKey` write: the
    // hydrator's own seeding pushes run before it and are never awaited.
    const acknowledged: Array<(value: { ok: true; value: null }) => void> = [];
    const api = createApi();
    api.set.mockImplementation(async () => await new Promise((resolve) => {
      acknowledged.push(resolve as (value: { ok: true; value: null }) => void);
    }));
    let userId = "user_1";
    const sync = startAccountSettingsSync(
      baseOptions({
        store,
        storage,
        getApi: () => api,
        isSignedIn: () => true,
        getAccountUserId: () => userId,
      }),
    );
    await settle();

    const pending = sync.flushKey("theme");
    await settle();
    // The account switches before the write is acknowledged.
    userId = "user_2";
    acknowledged.at(-1)?.({ ok: true, value: null });

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(JSON.parse(storage.map.get("ade.accountSettings.dirty.v1") ?? "[]"))
      .toContain("user_1\u0000theme");
    sync();
  });

  it("A1b: flushKey pushes the current value and answers what the brain said", async () => {
    const { store } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi();
    const sync = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true, getAccountUserId: () => "user_1" }),
    );
    await settle();
    api.set.mockClear();

    // Nothing changed locally, and the write still goes: a caller awaiting
    // `flushKey` is saying "make the machine's copy mine before something else
    // reads it", and a value that is not dirty would never be pushed otherwise.
    const confirmed = await sync.flushKey("theme");
    expect(confirmed.ok).toBe(true);
    expect(api.set).toHaveBeenCalledWith({
      scope: "all",
      key: "theme",
      value: "dark",
      expectedAccountUserId: "user_1",
    });

    api.set.mockImplementation(async () => ({
      ok: false as const,
      unavailable: true as const,
      message: "no brain",
    }));
    const refused = await sync.flushKey("theme");
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.message).toContain("no brain");
    sync();
  });

  it("A2: keeps the dirty key and local stamp when the account write is rejected", async () => {
    const { store, state } = createStore({ theme: "dark" });
    const storage = createStorage();
    const api = createApi();
    api.set.mockImplementation(async (args: { value?: unknown }) => {
      if (args.value === "light") {
        return {
          ok: false as const,
          rejected: true as const,
          message: "ownership changed",
        };
      }
      return { ok: true as const, value: null };
    });
    const stop = startAccountSettingsSync(
      baseOptions({
        store,
        storage,
        getApi: () => api,
        isSignedIn: () => true,
        now: () => Date.parse("2026-09-16T12:00:00.000Z"),
      }),
    );
    await settle();

    state.setTheme("light");
    await settle();

    expect(JSON.parse(storage.map.get("ade.accountSettings.dirty.v1") ?? "[]")).toContain(
      "__signed-in__\u0000theme",
    );
    expect(JSON.parse(storage.map.get("ade.accountSettings.stamps.v1") ?? "{}"))
      .toMatchObject({ "__signed-in__": { "all theme": "2026-09-16T12:00:00.000Z" } });
    stop();
  });

  it("files a repo-scoped setting under the repository, and keeps it local with no remote", async () => {
    const withRemote = createStore({ theme: "dark" });
    const api = createApi();
    const stop = startAccountSettingsSync(
      baseOptions({
        store: withRemote.store,
        settings: REPO_SETTINGS,
        getApi: () => api,
        isSignedIn: () => true,
        getProjectRemote: () => "git@github.com:ade-dev/ade.git",
      }),
    );
    await settle();
    withRemote.state.setTheme("light");
    expect(api.set).toHaveBeenCalledWith({
      scope: "repo:github.com/ade-dev/ade",
      key: "theme",
      value: "light",
    });
    stop();

    const noRemote = createStore({ theme: "dark" });
    const localApi = createApi();
    const stopLocal = startAccountSettingsSync(
      baseOptions({
        store: noRemote.store,
        settings: REPO_SETTINGS,
        getApi: () => localApi,
        isSignedIn: () => true,
        getProjectRemote: () => null,
      }),
    );
    await settle();
    noRemote.state.setTheme("light");
    expect(localApi.set).not.toHaveBeenCalled();
    stopLocal();
  });

  it("never touches a machine-scoped key", async () => {
    const { store, state } = createStore({ theme: "dark" });
    const api = createApi([row("theme", "light", "2030-01-01T00:00:00.000Z")]);
    const stop = startAccountSettingsSync(
      baseOptions({
        store,
        settings: MACHINE_SETTINGS,
        getApi: () => api,
        isSignedIn: () => true,
      }),
    );
    await settle();
    state.setTheme("sepia");
    expect(api.list).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
    expect(state.theme).toBe("sepia");
    stop();
  });

  it("applies a newer row that arrives on the poll", async () => {
    const { store, state } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const rows: AccountSettingRow[] = [];
    const api = createApi(rows);
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true }),
    );
    await settle();
    expect(state.theme).toBe("dark");

    rows.push(row("chatFontSizePx", 18, "2030-02-01T00:00:00.000Z"));
    timers[0]?.();
    await settle();
    expect(api.sync).toHaveBeenCalledTimes(2);
    expect(state.chatFontSizePx).toBe(18);
    stop();
  });

  it("does not revert this machine's own change with an older remote row", async () => {
    const { store, state } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const rows: AccountSettingRow[] = [];
    const api = createApi(rows);
    const stop = startAccountSettingsSync(
      baseOptions({
        store,
        getApi: () => api,
        isSignedIn: () => true,
        now: () => Date.parse("2026-03-01T00:00:00.000Z"),
      }),
    );
    await settle();
    state.setTheme("light");
    expect(api.set).toHaveBeenCalledWith({
      scope: "all",
      key: "theme",
      value: "light",
    });

    // The server's copy predates the local edit: a pull must leave it alone.
    rows.push(row("theme", "dark", "2026-01-01T00:00:00.000Z"));
    timers[0]?.();
    await settle();
    expect(state.theme).toBe("light");
    stop();
  });

  it("makes no calls at all while signed out, and still changes the value locally", async () => {
    const { store, state } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi([row("theme", "light", "2030-01-01T00:00:00.000Z")]);
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => false }),
    );
    await settle();
    state.setTheme("sepia");
    timers[0]?.();
    await settle();
    expect(api.list).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
    expect(state.theme).toBe("sepia");
    stop();
  });

  it("hydrates when the account signs in, not before", async () => {
    const { store, state } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi([row("theme", "light", "2030-01-01T00:00:00.000Z")]);
    let signedIn = false;
    const notifiers: Array<() => void> = [];
    const stop = startAccountSettingsSync(
      baseOptions({
        store,
        getApi: () => api,
        isSignedIn: () => signedIn,
        subscribeSignedIn: (listener) => {
          notifiers.push(listener);
          return () => {};
        },
      }),
    );
    await settle();
    expect(state.theme).toBe("dark");

    signedIn = true;
    notifiers[0]?.();
    await settle();
    expect(state.theme).toBe("light");
    stop();
  });

  it("rehydrates a direct account switch and ignores the old account's in-flight response", async () => {
    const { store, state } = createStore({ theme: "local" });
    const api = createApi();
    let userId: string | null = "account-a";
    let resolveAccountA: (result: AccountSettingRow[]) => void = () => {};
    const accountA = new Promise<AccountSettingRow[]>((resolve) => {
      resolveAccountA = resolve;
    });
    let markListed = (): void => {};
    const listed = new Promise<void>((resolve) => {
      markListed = resolve;
    });
    api.list
      .mockImplementationOnce(async () => {
        markListed();
        return { ok: true as const, value: await accountA };
      })
      .mockResolvedValueOnce({ ok: true as const, value: [row("theme", "from-account-b", "2030-01-01T00:00:00.000Z")] });
    const notifiers: Array<() => void> = [];
    const stop = startAccountSettingsSync(
      baseOptions({
        store,
        getApi: () => api,
        isSignedIn: () => userId !== null,
        getAccountUserId: () => userId,
        subscribeSignedIn: (listener) => {
          notifiers.push(listener);
          return () => {};
        },
      }),
    );

    await listed;
    userId = "account-b";
    notifiers[0]?.();
    resolveAccountA([row("theme", "from-account-a", "2030-02-01T00:00:00.000Z")]);
    await settle();

    expect(state.theme).toBe("from-account-b");
    expect(api.list).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps signed-out changes dirty and flushes them after the next sign-in", async () => {
    const { store, state } = createStore({ theme: "dark" });
    const api = createApi();
    const storage = createStorage();
    let signedIn = false;
    let userId: string | null = null;
    const notifiers: Array<() => void> = [];
    const stop = startAccountSettingsSync(
      baseOptions({
        store,
        storage,
        getApi: () => api,
        isSignedIn: () => signedIn,
        getAccountUserId: () => userId,
        subscribeSignedIn: (listener) => {
          notifiers.push(listener);
          return () => {};
        },
      }),
    );
    await settle();

    state.setTheme("light");
    expect(api.set).not.toHaveBeenCalled();
    expect(JSON.parse(storage.map.get("ade.accountSettings.dirty.v1") ?? "[]")).toContain(
      "__signed-out__\u0000theme",
    );
    expect(storage.map.has("ade.accountSettings.stamps.v1")).toBe(false);

    signedIn = true;
    userId = "account-a";
    notifiers[0]?.();
    await settle();

    expect(api.set).toHaveBeenCalledWith({
      scope: "all",
      key: "theme",
      value: "light",
      expectedAccountUserId: "account-a",
    });
    const stamps = JSON.parse(storage.map.get("ade.accountSettings.stamps.v1") ?? "{}");
    expect(stamps["account-a"]).toMatchObject({ "all theme": expect.any(String) });
    expect(JSON.parse(storage.map.get("ade.accountSettings.dirty.v1") ?? "[]")).not.toContain(
      "__signed-out__\u0000theme",
    );
    stop();
  });

  it("keeps the local value when the bridge is missing entirely", async () => {
    const { store, state } = createStore({ theme: "dark" });
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => null, isSignedIn: () => true }),
    );
    await settle();
    state.setTheme("light");
    timers[0]?.();
    await settle();
    expect(state.theme).toBe("light");
    stop();
  });

  it("stops listening and polling once stopped", async () => {
    const { store, state } = createStore({ theme: "dark" });
    const api = createApi();
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true }),
    );
    await settle();
    api.set.mockClear();
    stop();
    state.setTheme("light");
    await settle();
    expect(api.set).not.toHaveBeenCalled();
  });
});
