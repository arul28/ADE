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

function baseOptions(overrides: AccountSettingsSyncOptions<FakeState>) {
  return {
    settings: SETTINGS,
    storage: createStorage(),
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearInterval: () => {},
    ...overrides,
  } satisfies AccountSettingsSyncOptions<FakeState>;
}

beforeEach(() => {
  timers = [];
});

describe("accountSettingsSync (renderer)", () => {
  it("registers exactly the account-scoped persisted preferences", () => {
    expect(ACCOUNT_SYNCED_SETTINGS.map((entry) => entry.key)).toEqual([
      "theme",
      "terminalPreferences",
      "smartTooltipsEnabled",
      "launchPromptClipboardEnabled",
      "launchPromptClipboardNoticeEnabled",
      "promptStashButtonEnabled",
      "voiceInputEnabled",
      "codeBlockCopyButtonPosition",
      "agentTurnCompletionSound",
      "agentTurnCompletionSoundVolume",
      "agentTurnCompletionSoundQuietWhenFocused",
      "chatFontSizePx",
      "chatUserMinimapEnabled",
      "chatTranscriptDensity",
      "chatChromeTint",
      "chatShellGeometry",
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
    // Applying a hydrated value must not bounce straight back as a write.
    expect(api.set).not.toHaveBeenCalled();
    stop();
  });

  it("writes a local change through with the account scope key", async () => {
    const { store, state } = createStore({ theme: "dark", chatFontSizePx: 14 });
    const api = createApi();
    const stop = startAccountSettingsSync(
      baseOptions({ store, getApi: () => api, isSignedIn: () => true }),
    );
    await settle();
    state.setTheme("light");
    expect(api.set).toHaveBeenCalledWith({ scope: "all", key: "theme", value: "light" });
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

    rows.push(row("chatFontSizePx", 18, "2026-02-01T00:00:00.000Z"));
    timers[0]?.();
    await settle();
    expect(api.sync).toHaveBeenCalledTimes(1);
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
    expect(api.set).toHaveBeenCalledTimes(1);

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
    api.list
      .mockImplementationOnce(async () => ({ ok: true as const, value: await accountA }))
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

    expect(api.set).toHaveBeenCalledWith({ scope: "all", key: "theme", value: "light" });
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
    stop();
    state.setTheme("light");
    await settle();
    expect(api.set).not.toHaveBeenCalled();
  });
});
