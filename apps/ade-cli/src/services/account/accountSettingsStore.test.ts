import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAccountSettingsStore,
  type AccountSettingsRelay,
} from "./accountSettingsStore";
import type { AccountSettingRecord } from "../push/pushRelayClient";

/**
 * The cache is what makes a settings page usable on a train, so the properties
 * that matter are all about what happens when the network is absent, slow, or
 * answering with something older than the user's own last edit.
 */

const USER = "user_ada";

function record(
  scope: string,
  key: string,
  value: unknown,
  updatedAt: string,
): AccountSettingRecord {
  return { scope, key, value, updatedAt, changedAt: null, writerDeviceId: "other-machine" };
}

describe("account settings store", () => {
  let adeDir: string;
  let accountUserId: string | null;
  type MockRelay = {
    putAccountSettings: ReturnType<typeof vi.fn>;
    getAccountSettings: ReturnType<typeof vi.fn>;
    deleteAccountSetting: ReturnType<typeof vi.fn>;
  };
  let relay: MockRelay;

  beforeEach(() => {
    adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-settings-"));
    accountUserId = USER;
    relay = {
      putAccountSettings: vi.fn(async () => ({ updatedAt: "2026-09-16T00:00:00.000Z" })),
      getAccountSettings: vi.fn(async () => ({ settings: [], cursor: null, truncated: false })),
      deleteAccountSetting: vi.fn(async () => true),
    };
  });

  afterEach(() => {
    fs.rmSync(adeDir, { recursive: true, force: true });
  });

  const makeStore = (override?: Partial<Parameters<typeof createAccountSettingsStore>[0]>) =>
    createAccountSettingsStore({
      adeDir,
      relay: relay as unknown as AccountSettingsRelay,
      getAccountUserId: () => accountUserId,
      getDeviceId: () => "this-machine",
      ...override,
    });

  it("answers a read from the cache without touching the network", () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");

    expect(store.get("all", "appearance.theme")).toBe("dark");
    expect(relay.getAccountSettings).not.toHaveBeenCalled();
    expect(relay.putAccountSettings).not.toHaveBeenCalled();
  });

  it("survives a restart by reloading the cache from disk", () => {
    makeStore().set("all", "appearance.theme", "dark");

    const reopened = makeStore();
    expect(reopened.get("all", "appearance.theme")).toBe("dark");
  });

  it("ignores corrupt persisted rows and pending entries with one warning", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    fs.writeFileSync(path.join(adeDir, "account-settings.json"), JSON.stringify({
      version: 1,
      seqCounter: 1,
      accountUserId: USER,
      cursor: null,
      settings: {
        "all\u0000appearance.theme": {
          value: "dark",
          updatedAt: "2026-09-16T00:00:00.000Z",
          changedAt: null,
          writerDeviceId: null,
        },
        corrupt: { updatedAt: 42 },
      },
      pending: [{ scope: "all", deleted: false }],
    }));

    const store = makeStore({ logger });
    expect(store.get("all", "appearance.theme")).toBe("dark");
    expect(store.list()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "account.settings_cache_entry_dropped",
      expect.objectContaining({ rowsField: "settings" }),
    );
  });

  // The whole point of a local-first store: a setting changed on a train is
  // still changed, and still queued, when the train arrives.
  it("keeps the queue when there is no account token to upload with", async () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");
    relay.putAccountSettings.mockResolvedValueOnce(null);

    await store.sync();

    expect(store.get("all", "appearance.theme")).toBe("dark");
    // Still queued, so the next sync retries it.
    relay.putAccountSettings.mockClear();
    relay.putAccountSettings.mockResolvedValue({ updatedAt: "2026-09-16T00:00:00.000Z" });
    await store.sync();
    expect(relay.putAccountSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the queue when the upload throws", async () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");
    relay.putAccountSettings.mockRejectedValueOnce(new Error("ECONNRESET"));

    await store.sync();

    relay.putAccountSettings.mockClear();
    await store.sync();
    expect(relay.putAccountSettings).toHaveBeenCalledTimes(1);
  });

  // A pull that ran first would hand back the server's older value for a key
  // this machine just changed, and the user would watch their own edit revert.
  it("uploads before pulling, so a local edit is never reverted by the server", async () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");
    const order: string[] = [];
    relay.putAccountSettings.mockImplementation(async () => {
      order.push("put");
      return { updatedAt: "2026-09-16T00:00:00.000Z" };
    });
    relay.getAccountSettings.mockImplementation(async () => {
      order.push("get");
      return {
        settings: [record("all", "appearance.theme", "light", "2026-09-15T00:00:00.000Z")],
        cursor: "2026-09-15T00:00:00.000Z",
        truncated: false,
      };
    });

    await store.sync();

    expect(order).toEqual(["put", "get"]);
    // The pull carried an older value, but this machine's edit had already been
    // uploaded, so the server's answer is stale rather than authoritative.
    expect(store.get("all", "appearance.theme")).toBe("dark");
  });

  it("applies another machine's settings on pull", async () => {
    const store = makeStore();
    relay.getAccountSettings.mockResolvedValueOnce({
      settings: [record("all", "chat.font-size", 16, "2026-09-16T00:00:00.000Z")],
      cursor: "2026-09-16T00:00:00.000Z",
      truncated: false,
    });

    await store.sync();

    expect(store.get("all", "chat.font-size")).toBe(16);
  });

  // A key queued while an upload is in flight is newer than what the server now
  // holds, so clearing the whole queue on success would lose it.
  it("does not clear a write that was queued during the upload", async () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");
    relay.putAccountSettings.mockImplementation(async () => {
      store.set("all", "appearance.theme", "system");
      return { updatedAt: "2026-09-16T00:00:00.000Z" };
    });

    await store.sync();

    relay.putAccountSettings.mockClear();
    relay.putAccountSettings.mockResolvedValue({ updatedAt: "2026-09-16T00:01:00.000Z" });
    await store.sync();
    expect(relay.putAccountSettings).toHaveBeenCalledTimes(1);
    expect(store.get("all", "appearance.theme")).toBe("system");
  });

  it("sends only the newest intent per key", async () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");
    store.set("all", "appearance.theme", "light");

    await store.sync();

    expect(relay.putAccountSettings).toHaveBeenCalledTimes(1);
    const sent = relay.putAccountSettings.mock.calls[0]![0] as Array<{ key: string; value: unknown }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ key: "appearance.theme", value: "light" });
  });

  it("queues a removal and clears it locally at once", async () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");
    await store.sync();

    store.remove("all", "appearance.theme");
    expect(store.get("all", "appearance.theme")).toBeUndefined();

    await store.sync();
    expect(relay.deleteAccountSetting).toHaveBeenCalledWith("all", "appearance.theme");
  });

  // One user's theme appearing after another signs in is a leak, not a
  // convenience.
  it("discards the cache when the signed-in account changes", () => {
    makeStore().set("all", "appearance.theme", "dark");

    accountUserId = "user_grace";
    const afterSwitch = makeStore();
    expect(afterSwitch.get("all", "appearance.theme")).toBeUndefined();
  });

  it("ignores a cache file written for a different account", () => {
    makeStore().set("all", "appearance.theme", "dark");
    accountUserId = "user_grace";

    expect(makeStore().list()).toHaveLength(0);
  });

  it("does nothing at all when signed out", async () => {
    accountUserId = null;
    const store = makeStore();

    await store.sync();

    expect(relay.putAccountSettings).not.toHaveBeenCalled();
    expect(relay.getAccountSettings).not.toHaveBeenCalled();
  });

  it("drops signed-out mutations and logs each dropped operation once", () => {
    accountUserId = null;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = makeStore({ logger });

    store.set("all", "appearance.theme", "must-not-persist");
    store.remove("all", "appearance.theme");

    expect(fs.existsSync(store.cachePathForTests())).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(1, "account.settings_mutation_dropped", { reason: "signed_out" });
    expect(logger.warn).toHaveBeenNthCalledWith(2, "account.settings_mutation_dropped", { reason: "signed_out" });
  });

  it("drops a mutation when the owner changes during its entry checks", () => {
    let reads = 0;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = createAccountSettingsStore({
      adeDir,
      relay: relay as unknown as AccountSettingsRelay,
      getAccountUserId: () => {
        reads += 1;
        if (reads === 2) accountUserId = "user_grace";
        return accountUserId;
      },
      logger,
    });

    store.set("all", "appearance.theme", "must-not-persist");

    expect(fs.existsSync(store.cachePathForTests())).toBe(false);
    expect(store.get("all", "appearance.theme")).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("account.settings_mutation_dropped", { reason: "owner_changed" });
  });

  it("drops a mutation when the account changes while it is being queued", () => {
    let reads = 0;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = makeStore({
      getAccountUserId: () => {
        reads += 1;
        if (reads === 4) accountUserId = "user_grace";
        return accountUserId;
      },
      logger,
    });

    store.set("all", "appearance.theme", "must-not-persist");

    expect(fs.existsSync(store.cachePathForTests())).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("account.settings_mutation_dropped", { reason: "owner_changed" });
  });

  // The caller is a 30-second timer plus whatever a user action triggers, so
  // two overlapping syncs racing the cursor is a real scenario.
  it("runs one sync at a time", async () => {
    const store = makeStore();
    let resolveGet: (value: unknown) => void = () => {};
    relay.getAccountSettings.mockImplementation(() => new Promise((resolve) => {
      resolveGet = resolve;
    }));

    const first = store.sync();
    const second = store.sync();
    resolveGet({ settings: [], cursor: null, truncated: false });
    await Promise.all([first, second]);

    expect(relay.getAccountSettings).toHaveBeenCalledTimes(1);
  });

  it("advances the cursor so an idle account stops re-reading the same rows", async () => {
    const store = makeStore();
    relay.getAccountSettings.mockResolvedValueOnce({
      settings: [record("all", "chat.font-size", 16, "2026-09-16T00:00:00.000Z")],
      cursor: "2026-09-16T00:00:00.000Z",
      truncated: false,
    });
    await store.sync();

    await store.sync();
    expect(relay.getAccountSettings).toHaveBeenLastCalledWith({ since: "2026-09-16T00:00:00.000Z" });
  });

  it("writes the cache with owner-only permissions", () => {
    const store = makeStore();
    store.set("all", "appearance.theme", "dark");

    const mode = fs.statSync(store.cachePathForTests()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("treats an unreadable cache as cold rather than failing", () => {
    const store = makeStore();
    fs.writeFileSync(store.cachePathForTests(), "{ not json");

    const reopened = makeStore();
    expect(reopened.list()).toHaveLength(0);
    expect(() => reopened.set("all", "appearance.theme", "dark")).not.toThrow();
  });
});
