import { describe, expect, it, vi } from "vitest";

import {
  IndexedDbStorage,
  MemoryStorage,
  WEB_TRUST_RESET_VERSION,
  WebClientEnvStore,
  type WebClientEnvironmentRecord,
} from "./envStore";

function legacyEnvironment(envId: string): WebClientEnvironmentRecord {
  return {
    envId,
    machineName: "Legacy Mac",
    hostDeviceId: "host-1",
    addressCandidates: [],
    port: 8787,
    pairedDeviceId: "browser-1",
    secret: "legacy-secret",
    dpopKeys: {} as CryptoKeyPair,
    siteId: "site-1",
    localDeviceId: "local-1",
    localDeviceName: "ADE Browser",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("web-client trust reset migration", () => {
  it("bounds a v2 schema upgrade blocked by a tab holding the v1 database", async () => {
    const request = {} as IDBOpenDBRequest;
    const open = vi.fn(() => request);
    const storage = new IndexedDbStorage({
      indexedDb: { open },
      upgradeBlockedTimeoutMs: 0,
    });

    const pendingRead = storage.get("account", "oauthSession");
    expect(open).toHaveBeenCalledWith("ade-web-client", 2);
    expect(request.onblocked).toBeTypeOf("function");
    request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);

    await expect(pendingRead).rejects.toThrow("Close other ADE tabs and try again");
  });

  it("closes an open database when a future schema version requests an upgrade", async () => {
    const request = {} as IDBOpenDBRequest;
    const getRequest = {} as IDBRequest<unknown>;
    const close = vi.fn();
    const transaction = {
      abort: vi.fn(),
      error: null,
      objectStore: () => ({ get: () => getRequest }),
      onabort: null,
      oncomplete: null,
      onerror: null,
    } as unknown as IDBTransaction;
    const db = {
      close,
      onversionchange: null,
      transaction: () => transaction,
    } as unknown as IDBDatabase;
    const storage = new IndexedDbStorage({
      indexedDb: { open: () => request },
    });

    const pendingRead = storage.get("account", "oauthSession");
    Object.defineProperty(request, "result", { value: db });
    request.onsuccess?.(new Event("success"));
    expect(db.onversionchange).toBeTypeOf("function");
    await vi.waitFor(() => expect(getRequest.onsuccess).toBeTypeOf("function"));
    Object.defineProperty(getRequest, "result", { value: undefined });
    getRequest.onsuccess?.(new Event("success"));
    transaction.oncomplete?.(new Event("complete"));

    await expect(pendingRead).resolves.toBeNull();
    db.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
    expect(close).toHaveBeenCalledOnce();
  });

  it("clears legacy environments and selection but preserves unrelated metadata", async () => {
    const storage = new MemoryStorage();
    await storage.put("environments", "legacy", legacyEnvironment("legacy"));
    await storage.put("meta", "selectedEnvId", "legacy");
    await storage.put("meta", "accountSessionHint", "preserved");

    const store = new WebClientEnvStore(storage);

    await expect(store.listEnvironments()).resolves.toEqual([]);
    await expect(store.getSelectedEnvId()).resolves.toBeNull();
    await expect(storage.get("meta", "accountSessionHint")).resolves.toBe("preserved");
    await expect(storage.get("meta", "machineTrustResetVersion")).resolves.toBe(
      WEB_TRUST_RESET_VERSION,
    );
  });

  it("does not clear environments saved after the one-time migration", async () => {
    const storage = new MemoryStorage();
    const store = new WebClientEnvStore(storage);
    await store.saveEnvironment(legacyEnvironment("new-pairing"));
    await store.setSelectedEnvId("new-pairing");

    const nextLaunch = new WebClientEnvStore(storage);

    await expect(nextLaunch.listEnvironments()).resolves.toHaveLength(1);
    await expect(nextLaunch.getSelectedEnvId()).resolves.toBe("new-pairing");
  });

  it("removes only the signed-out account's environments and clears its selection", async () => {
    const storage = new MemoryStorage();
    const store = new WebClientEnvStore(storage);
    await store.saveEnvironment(legacyEnvironment("manual"));
    await store.saveEnvironment({
      ...legacyEnvironment("owned"),
      accountOwnerUserId: "account-a",
    });
    await store.saveEnvironment({
      ...legacyEnvironment("other"),
      accountOwnerUserId: "account-b",
    });
    await store.setSelectedEnvId("owned");

    await expect(store.removeAccountOwnedEnvironments("account-a")).resolves.toEqual([
      "owned",
    ]);
    await expect(store.getSelectedEnvId()).resolves.toBeNull();
    await expect(store.listEnvironments()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ envId: "manual" }),
        expect.objectContaining({ envId: "other", accountOwnerUserId: "account-b" }),
      ]),
    );
    await expect(store.listEnvironments()).resolves.toHaveLength(2);
  });

  it("prunes signed-out and wrong-account environments before launch", async () => {
    const storage = new MemoryStorage();
    const store = new WebClientEnvStore(storage);
    await store.saveEnvironment(legacyEnvironment("manual"));
    await store.saveEnvironment({
      ...legacyEnvironment("current"),
      accountOwnerUserId: "account-b",
    });
    await store.saveEnvironment({
      ...legacyEnvironment("stale"),
      accountOwnerUserId: "account-a",
    });

    await expect(store.pruneAccountOwnedEnvironments("account-b")).resolves.toEqual({
      removedIds: ["stale"],
      environments: expect.arrayContaining([
        expect.objectContaining({ envId: "manual" }),
        expect.objectContaining({ envId: "current" }),
      ]),
    });
    await expect(store.listEnvironments()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ envId: "manual" }),
        expect.objectContaining({ envId: "current" }),
      ]),
    );
    await expect(store.pruneAccountOwnedEnvironments(null)).resolves.toEqual({
      removedIds: ["current"],
      environments: [expect.objectContaining({ envId: "manual" })],
    });
    await expect(store.listEnvironments()).resolves.toEqual([
      expect.objectContaining({ envId: "manual" }),
    ]);
  });
});
