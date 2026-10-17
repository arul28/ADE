import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAccountVaultStore,
  type AccountVaultRelay,
} from "./accountVaultStore";
import { PushRelayRequestError, type AccountVaultItem } from "../push/pushRelayClient";
import { recordAccountChangeMarks } from "./accountChangeMarks";

/**
 * The vault cache is the settings cache with one extra duty: what it holds is a
 * credential. So beyond the offline behaviour, these pin the two properties a
 * secret store must have — it leaves the machine on sign-out, and it never lets
 * the server's "I cannot read this" overwrite a value that still works here.
 */

const USER = "user_ada";

function item(key: string, value: string | null, updatedAt: string): AccountVaultItem {
  return {
    scope: "all",
    kind: "provider_key",
    key,
    value,
    updatedAt,
    writerDeviceId: "other-machine",
    refreshOwner: null,
  };
}

describe("account vault store", () => {
  let adeDir: string;
  let accountUserId: string | null;
  let relay: {
    putAccountVault: ReturnType<typeof vi.fn>;
    getAccountVault: ReturnType<typeof vi.fn>;
    deleteAccountVaultItem: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-vault-"));
    accountUserId = USER;
    relay = {
      putAccountVault: vi.fn(async () => ({ updatedAt: "2026-09-16T00:00:00.000Z" })),
      getAccountVault: vi.fn(async () => ({ items: [], cursor: null, truncated: false })),
      deleteAccountVaultItem: vi.fn(async () => true),
    };
  });

  afterEach(() => {
    fs.rmSync(adeDir, { recursive: true, force: true });
  });

  const makeStore = (override?: Partial<Parameters<typeof createAccountVaultStore>[0]>) =>
    createAccountVaultStore({
      adeDir,
      relay: relay as unknown as AccountVaultRelay,
      getAccountUserId: () => accountUserId,
      getDeviceId: () => "this-machine",
      ...override,
    });

  it("answers a read from the cache without touching the network", () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");

    expect(store.get("all", "provider_key", "anthropic")).toBe("sk-live-abc");
    expect(relay.getAccountVault).not.toHaveBeenCalled();
  });

  // The list surface never needs the credential itself, and one that returned
  // it would be a careless log line away from printing every key a user owns.
  it("lists items without their values", () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");

    const listed = store.list();
    expect(listed).toMatchObject([{ key: "anthropic", readable: true }]);
    expect(JSON.stringify(listed)).not.toContain("sk-live-abc");
  });

  it("keeps the queue when the upload cannot happen", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");
    relay.putAccountVault.mockResolvedValueOnce(null);

    await store.sync();

    relay.putAccountVault.mockClear();
    await store.sync();
    expect(relay.putAccountVault).toHaveBeenCalledTimes(1);
  });

  it("uploads before pulling so a local edit is never reverted", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "new-key");
    relay.getAccountVault.mockResolvedValue({
      items: [item("anthropic", "old-key", "2026-09-15T00:00:00.000Z")],
      cursor: "2026-09-15T00:00:00.000Z",
      truncated: false,
    });

    await store.sync();

    expect(store.get("all", "provider_key", "anthropic")).toBe("new-key");
  });

  // A relay that cannot open its own stored bytes — a rotated key — must not be
  // allowed to erase a credential this machine still holds and can still use.
  it("never lets an unreadable server row overwrite a working local value", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "still-works");
    await store.sync();

    relay.getAccountVault.mockResolvedValueOnce({
      items: [item("anthropic", null, "2099-01-01T00:00:00.000Z")],
      cursor: "2099-01-01T00:00:00.000Z",
      truncated: false,
    });
    await store.sync();

    expect(store.get("all", "provider_key", "anthropic")).toBe("still-works");
  });

  it("records an unreadable item this machine never held, so a surface can say so", async () => {
    const store = makeStore();
    relay.getAccountVault.mockResolvedValueOnce({
      items: [item("openai", null, "2026-09-16T00:00:00.000Z")],
      cursor: "2026-09-16T00:00:00.000Z",
      truncated: false,
    });

    await store.sync();

    expect(store.list()).toMatchObject([{ key: "openai", readable: false }]);
    expect(store.get("all", "provider_key", "openai")).toBeNull();
  });

  it("applies another machine's credential", async () => {
    const store = makeStore();
    relay.getAccountVault.mockResolvedValueOnce({
      items: [item("openai", "sk-from-elsewhere", "2026-09-16T00:00:00.000Z")],
      cursor: "2026-09-16T00:00:00.000Z",
      truncated: false,
    });

    await store.sync();

    expect(store.get("all", "provider_key", "openai")).toBe("sk-from-elsewhere");
  });

  it("stamps this machine as refreshOwner on a Linear refresh token", async () => {
    const store = makeStore();
    store.set("all", "linear_refresh_token", "default", "rt-linear");
    await store.sync();

    const sent = relay.putAccountVault.mock.calls[0]![0] as Array<{ kind: string; refreshOwner: string | null }>;
    expect(sent[0]).toMatchObject({ kind: "linear_refresh_token", refreshOwner: "this-machine" });
    expect(store.list()).toMatchObject([{ key: "default", refreshOwner: "this-machine" }]);
  });

  it("keeps pulling truncated vault pages until the relay says the view is complete", async () => {
    const store = makeStore();
    let pulls = 0;
    relay.getAccountVault.mockImplementation(async () => {
      pulls += 1;
      if (pulls === 1) {
        return {
          items: [item("anthropic", "sk-page-1", "2026-09-16T00:00:00.000Z")],
          cursor: "2026-09-16T00:00:00.000Z",
          truncated: true,
        };
      }
      return {
        items: [item("openai", "sk-page-2", "2026-09-16T00:01:00.000Z")],
        cursor: "2026-09-16T00:01:00.000Z",
        truncated: false,
      };
    });

    await expect(store.sync()).resolves.toBe("ready");
    expect(pulls).toBe(2);
    expect(store.get("all", "provider_key", "anthropic")).toBe("sk-page-1");
    expect(store.get("all", "provider_key", "openai")).toBe("sk-page-2");
  });

  it("drops uploaded vault writes even when a later delete cannot be sent", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");
    store.remove("all", "provider_key", "openai");
    relay.deleteAccountVaultItem.mockResolvedValueOnce(null);

    await store.sync();

    relay.putAccountVault.mockClear();
    relay.deleteAccountVaultItem.mockResolvedValue(true);
    await store.sync();

    expect(relay.putAccountVault).not.toHaveBeenCalled();
    expect(relay.deleteAccountVaultItem).toHaveBeenCalledWith("all", "provider_key", "openai");
  });

  it("queues a revocation and clears it locally at once", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");
    await store.sync();

    store.remove("all", "provider_key", "anthropic");
    expect(store.get("all", "provider_key", "anthropic")).toBeNull();

    await store.sync();
    expect(relay.deleteAccountVaultItem).toHaveBeenCalledWith("all", "provider_key", "anthropic");
  });

  // Settings survive a sign-out; the vault does not. Leaving synced keys
  // readable on a machine someone just signed out of is the wrong default for a
  // shared or handed-on laptop.
  it("removes the file entirely on purge", () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");
    const cachePath = store.cachePathForTests();
    expect(fs.existsSync(cachePath)).toBe(true);

    store.purge();

    expect(fs.existsSync(cachePath)).toBe(false);
    expect(store.get("all", "provider_key", "anthropic")).toBeNull();
  });

  it("drops queued uploads on purge, because a signed-out machine owes the account nothing", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");

    store.purge();
    await store.sync();

    expect(relay.putAccountVault).not.toHaveBeenCalled();
  });

  /**
   * The purge race. `sync()` checks the account only on entry, so a pull that
   * was already in flight used to resolve AFTER the sign-out purge and persist
   * the credentials straight back onto a machine the user had just signed out
   * of — the file recreated, `0600`, holding live keys.
   */
  it("does not re-create the cache when a pull resolves after purge", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");
    const cachePath = store.cachePathForTests();

    let releasePull = (): void => {};
    const pullOpened = new Promise<void>((ready) => {
      relay.getAccountVault.mockImplementationOnce(async () => {
        const held = new Promise<void>((resolve) => {
          releasePull = resolve;
        });
        ready();
        await held;
        return {
          items: [item("anthropic", "sk-live-from-server", "2026-09-17T00:00:00.000Z")],
          cursor: "cursor-2",
          truncated: false,
        };
      });
    });

    const syncing = store.sync();
    await pullOpened;
    // The purge lands while the pull is still open, exactly as a sign-out does.
    store.purge();
    releasePull();
    await syncing;

    expect(fs.existsSync(cachePath)).toBe(false);
    expect(store.get("all", "provider_key", "anthropic")).toBeNull();
  });

  /**
   * The brain builds one vault per machine but starts the beat from every
   * project scope. Tearing one project down must not silence the timer for the
   * projects still running.
   */
  it("keeps the shared sync timer alive until the last holder releases it", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const stopFirst = store.startPeriodicSync(1_000);
      const stopSecond = store.startPeriodicSync(1_000);

      stopFirst();
      vi.advanceTimersByTime(1_000);
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);

      stopSecond();
      vi.advanceTimersByTime(5_000);
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards the cache when the signed-in account changes", () => {
    makeStore().set("all", "provider_key", "anthropic", "sk-live-abc");

    accountUserId = "user_grace";
    expect(makeStore().get("all", "provider_key", "anthropic")).toBeNull();
  });

  it("writes the cache with owner-only permissions", () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");

    expect(fs.statSync(store.cachePathForTests()).mode & 0o777).toBe(0o600);
  });

  it("ignores corrupt persisted rows and pending entries with one warning", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    fs.writeFileSync(path.join(adeDir, "account-vault.json"), JSON.stringify({
      version: 1,
      seqCounter: 1,
      accountUserId: USER,
      cursor: null,
      items: {
        "all\u0000provider_key\u0000valid": {
          value: "sk-valid",
          updatedAt: "2026-09-16T00:00:00.000Z",
          writerDeviceId: null,
          refreshOwner: null,
        },
        "all\u0000unknown\u0000corrupt": {
          value: "sk-corrupt",
          updatedAt: "2026-09-16T00:00:00.000Z",
          writerDeviceId: null,
          refreshOwner: null,
        },
      },
      pending: [{ scope: "all", key: "missing-kind", deleted: false }],
    }));

    const store = makeStore({ logger });
    expect(store.get("all", "provider_key", "valid")).toBe("sk-valid");
    expect(store.get("all", "provider_key", "corrupt")).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "account.vault_cache_entry_dropped",
      expect.objectContaining({ rowsField: "items" }),
    );
  });

  it("encrypts the vault cache at rest and migrates a legacy plaintext cache on write", () => {
    const legacyPath = path.join(adeDir, "account-vault.json");
    fs.writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      seqCounter: 0,
      accountUserId: USER,
      cursor: null,
      items: {
        "all\u0000provider_key\u0000legacy": {
          value: "sk-legacy-secret",
          updatedAt: "2026-09-16T00:00:00.000Z",
          writerDeviceId: null,
          refreshOwner: null,
        },
      },
      pending: [],
    }), "utf8");

    const store = makeStore();
    expect(store.get("all", "provider_key", "legacy")).toBe("sk-legacy-secret");
    store.set("all", "provider_key", "new", "sk-new-secret");

    const encryptedPath = store.cachePathForTests();
    expect(encryptedPath.endsWith("account-vault.json.enc")).toBe(true);
    expect(fs.readFileSync(encryptedPath, "utf8")).not.toContain("sk-new-secret");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("drops signed-out mutations and logs each dropped operation once", () => {
    accountUserId = null;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = createAccountVaultStore({
      adeDir,
      relay: relay as unknown as AccountVaultRelay,
      getAccountUserId: () => accountUserId,
      logger,
    });

    expect(store.set("all", "provider_key", "blocked", "must-not-persist")).toBe(false);
    expect(store.remove("all", "provider_key", "blocked")).toBe(false);

    expect(fs.existsSync(store.cachePathForTests())).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(1, "account.vault_mutation_dropped", { reason: "signed_out" });
    expect(logger.warn).toHaveBeenNthCalledWith(2, "account.vault_mutation_dropped", { reason: "signed_out" });
  });

  it("A1: rejects set and remove when the expected owner differs", () => {
    const store = makeStore();

    expect(store.set("all", "provider_key", "blocked", "must-not-persist", {
      expectedAccountUserId: "user_grace",
    })).toBe(false);
    expect(store.remove("all", "provider_key", "blocked", {
      expectedAccountUserId: "user_grace",
    })).toBe(false);

    expect(store.get("all", "provider_key", "blocked")).toBeNull();
    expect(fs.existsSync(store.cachePathForTests())).toBe(false);
  });

  it("drops a mutation when the owner changes during its entry checks", () => {
    let reads = 0;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = createAccountVaultStore({
      adeDir,
      relay: relay as unknown as AccountVaultRelay,
      getAccountUserId: () => {
        reads += 1;
        if (reads === 2) accountUserId = "user_grace";
        return accountUserId;
      },
      logger,
    });

    expect(store.set("all", "provider_key", "blocked", "must-not-persist")).toBe(false);

    expect(fs.existsSync(store.cachePathForTests())).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("account.vault_mutation_dropped", { reason: "owner_changed" });
  });

  it("keeps the same key apart across kinds and scopes", () => {
    const store = makeStore();
    store.set("all", "provider_key", "linear", "a-key");
    store.set("all", "integration", "linear", "an-oauth-token");
    store.set("repo:github.com/arul28/ade", "integration", "linear", "a-repo-token");

    expect(store.get("all", "provider_key", "linear")).toBe("a-key");
    expect(store.get("all", "integration", "linear")).toBe("an-oauth-token");
    expect(store.get("repo:github.com/arul28/ade", "integration", "linear")).toBe("a-repo-token");
  });

  it("keeps the ready tick for local follow-up while the vault mark holds, without pulling", async () => {
    vi.useFakeTimers();
    try {
      const user = "user_vault_marks";
      accountUserId = user;
      const store = makeStore();
      const ticks: string[] = [];
      const stop = store.startPeriodicSync(30_000, (status) => ticks.push(status));
      recordAccountChangeMarks(user, { settings: null, vault: "2026-10-07T12:00:00.000Z" });
      await vi.advanceTimersByTimeAsync(0);
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);
      expect(ticks).toEqual(["ready"]);

      for (let beat = 0; beat < 3; beat += 1) {
        recordAccountChangeMarks(user, { settings: "s-moved", vault: "2026-10-07T12:00:00.000Z" });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      // A settings change does not pull the vault, and every tick still says ready.
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);
      expect(ticks).toEqual(["ready", "ready", "ready", "ready"]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // A secret saved on one machine is wanted on the next one now: the write
  // must not sit in the queue until the 30-second tick.
  it("uploads a local write within a moment and reports it pending until it lands", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      const stop = store.startPeriodicSync(30_000);
      store.set("repo:github.com/acme/app", "project_secret", "STRIPE_KEY", "sk-1");
      expect(store.pendingKeys("repo:github.com/acme/app", "project_secret")).toEqual(["STRIPE_KEY"]);
      expect(store.pendingKeys("repo:github.com/acme/other", "project_secret")).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(relay.putAccountVault).toHaveBeenCalledTimes(1);
      expect(relay.putAccountVault.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ key: "STRIPE_KEY", value: "sk-1" }),
      ]);
      expect(store.pendingKeys("repo:github.com/acme/app", "project_secret")).toEqual([]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a read-path sync from the cache while it is fresh and asks the account once it is not", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore();
      await expect(store.sync()).resolves.toBe("ready");
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);

      await expect(store.sync({ maxAgeMs: 10_000 })).resolves.toBe("ready");
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_001);
      await expect(store.sync({ maxAgeMs: 10_000 })).resolves.toBe("ready");
      expect(relay.getAccountVault).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A relay that refused (its daily budget, a rate limit) must not get the
  // same request again from every write and every agent read on every machine.
  it("holds writes and read-path syncs during a 429 backoff, but not an explicit sync or another account", async () => {
    vi.useFakeTimers();
    try {
      relay.putAccountVault.mockRejectedValue(
        new PushRelayRequestError("putAccountVault", 429, "relay daily budget reached"),
      );
      const store = makeStore();
      const stop = store.startPeriodicSync(30_000);
      store.set("all", "provider_key", "anthropic", "sk-1");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(relay.putAccountVault).toHaveBeenCalledTimes(1);

      store.set("all", "provider_key", "openai", "sk-2");
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(store.sync({ maxAgeMs: 0 })).resolves.toBe("failed");
      expect(relay.putAccountVault).toHaveBeenCalledTimes(1);

      // A person asking explicitly still gets an attempt.
      await expect(store.sync()).resolves.toBe("failed");
      expect(relay.putAccountVault).toHaveBeenCalledTimes(2);

      // The backoff belongs to the account that earned it.
      relay.putAccountVault.mockResolvedValue({ updatedAt: "2026-09-16T00:00:00.000Z" });
      accountUserId = "user_someone_else";
      await expect(store.sync({ maxAgeMs: 0 })).resolves.toBe("ready");
      expect(relay.getAccountVault).toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pulls on the next tick after a purge, instead of reporting the emptied vault ready", async () => {
    vi.useFakeTimers();
    try {
      const user = "user_vault_purge";
      accountUserId = user;
      const store = makeStore();
      // Each "ready" records how many pulls had happened when it was reported.
      const readyAfterPulls: number[] = [];
      const stop = store.startPeriodicSync(30_000, (status) => {
        if (status === "ready") readyAfterPulls.push(relay.getAccountVault.mock.calls.length);
      });
      const mark = { settings: null, vault: "2026-10-07T15:00:00.000Z" };
      recordAccountChangeMarks(user, mark);
      await vi.advanceTimersByTimeAsync(0);
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);

      store.purge();
      const readyBeforePurge = readyAfterPulls.length;
      recordAccountChangeMarks(user, mark);
      await vi.advanceTimersByTimeAsync(30_000);

      // The tick after a purge goes back to the relay from the beginning.
      expect(relay.getAccountVault).toHaveBeenCalledTimes(2);
      expect(relay.getAccountVault).toHaveBeenLastCalledWith({ since: null });
      // No "ready" after the purge is reported before the purged vault was pulled again.
      const readyAfterPurge = readyAfterPulls.slice(readyBeforePurge);
      expect(readyAfterPurge.length).toBeGreaterThan(0);
      expect(readyAfterPurge.every((pulls) => pulls >= 2)).toBe(true);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ticking and notifying when a sync listener throws", async () => {
    vi.useFakeTimers();
    try {
      const user = "user_vault_throwing_listener";
      accountUserId = user;
      const store = makeStore();
      const heard: string[] = [];
      const stopThrowing = store.startPeriodicSync(30_000, () => {
        throw new Error("listener bug");
      });
      const stopListening = store.startPeriodicSync(30_000, (status) => heard.push(status));
      const mark = { settings: null, vault: "2026-10-07T16:00:00.000Z" };
      recordAccountChangeMarks(user, mark);
      await vi.advanceTimersByTimeAsync(0);
      for (let beat = 0; beat < 2; beat += 1) {
        recordAccountChangeMarks(user, mark);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      // The pull and both skipped ticks still reached the healthy listener.
      expect(relay.getAccountVault).toHaveBeenCalledTimes(1);
      expect(heard).toEqual(["ready", "ready", "ready"]);
      stopThrowing();
      stopListening();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing at all when signed out", async () => {
    accountUserId = null;
    await makeStore().sync();

    expect(relay.putAccountVault).not.toHaveBeenCalled();
    expect(relay.getAccountVault).not.toHaveBeenCalled();
  });
  it("keeps a delete the relay reports, and lets the key come back when it is written again", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");
    relay.getAccountVault.mockResolvedValueOnce({
      items: [{ ...item("anthropic", null, "2026-09-17T00:00:00.000Z"), deleted: true, writerDeviceId: null }],
      cursor: null,
      truncated: false,
    });

    await store.sync();

    // The tombstone is the only evidence a delete happened, and a value row
    // cannot carry it: it has to survive the pull to reach the consumer.
    expect(store.get("all", "provider_key", "anthropic")).toBeNull();
    expect(store.list("all")).toEqual([
      expect.objectContaining({ key: "anthropic", deleted: true, readable: false }),
    ]);

    // Writing the key again is what un-deletes it.
    expect(store.set("all", "provider_key", "anthropic", "sk-live-xyz")).toBe(true);
    expect(store.get("all", "provider_key", "anthropic")).toBe("sk-live-xyz");
    expect(store.list("all")).toEqual([
      expect.objectContaining({ key: "anthropic", readable: true }),
    ]);
  });

  it("does not let a stale tombstone erase a value written after it", async () => {
    const store = makeStore();
    store.set("all", "provider_key", "anthropic", "sk-live-abc");
    relay.getAccountVault.mockResolvedValueOnce({
      items: [{ ...item("anthropic", null, "2020-01-01T00:00:00.000Z"), deleted: true, writerDeviceId: null }],
      cursor: null,
      truncated: false,
    });

    await store.sync();

    expect(store.get("all", "provider_key", "anthropic")).toBe("sk-live-abc");
    expect(store.list("all")).toEqual([
      expect.objectContaining({ key: "anthropic", readable: true }),
    ]);
  });
});
