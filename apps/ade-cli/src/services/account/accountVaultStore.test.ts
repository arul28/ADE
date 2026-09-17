import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAccountVaultStore,
  type AccountVaultRelay,
} from "./accountVaultStore";
import type { AccountVaultItem } from "../push/pushRelayClient";

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

  it("does nothing at all when signed out", async () => {
    accountUserId = null;
    await makeStore().sync();

    expect(relay.putAccountVault).not.toHaveBeenCalled();
    expect(relay.getAccountVault).not.toHaveBeenCalled();
  });
});
