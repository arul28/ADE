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
  it("bounds a schema upgrade blocked by a tab holding the previous database", async () => {
    const request = {} as IDBOpenDBRequest;
    const open = vi.fn(() => request);
    const storage = new IndexedDbStorage({
      indexedDb: { open },
      upgradeBlockedTimeoutMs: 0,
    });

    const pendingRead = storage.get("account", "oauthSession");
    expect(open).toHaveBeenCalledWith("ade-web-client", 3);
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

  it("preserves signed-out direct trust but prunes a different signed-in account", async () => {
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
      removedIds: [],
      environments: expect.arrayContaining([
        expect.objectContaining({ envId: "manual" }),
        expect.objectContaining({ envId: "current" }),
      ]),
    });
    await expect(store.listEnvironments()).resolves.toHaveLength(2);
  });
});

describe("machine project catalog cache", () => {
  const project = (id: string, iconDataUrl: string | null = null) => ({
    id,
    displayName: `Project ${id}`,
    rootPath: `/repos/${id}`,
    defaultBaseRef: "main",
    lastOpenedAt: null,
    iconDataUrl,
    laneCount: 3,
    isAvailable: true,
    isCached: false,
    isOpen: false,
  });

  const catalog = (machineKey: string, overrides: Record<string, unknown> = {}) => ({
    machineKey,
    machineName: `Mac ${machineKey}`,
    hostDeviceId: null,
    envId: null,
    ownerUserId: "user-1",
    projects: [project(`${machineKey}-p1`)],
    savedAt: 1_000,
    ...overrides,
  });

  it("bounds a saved catalog: caps projects, drops oversized icons, evicts the oldest machine past the cap", async () => {
    const store = new WebClientEnvStore(new MemoryStorage());
    const oversizedIcon = `data:image/png;base64,${"A".repeat(30_000)}`;
    await store.saveMachineCatalog(catalog("m-big", {
      savedAt: 5_000,
      projects: [
        project("kept", oversizedIcon),
        ...Array.from({ length: 40 }, (_, i) => project(`extra-${i}`)),
      ],
    }));
    const [saved] = await store.listMachineCatalogs();
    expect(saved.projects).toHaveLength(24);
    expect(saved.projects[0]).toMatchObject({ id: "kept", iconDataUrl: null });

    for (let i = 0; i < 8; i += 1) {
      await store.saveMachineCatalog(catalog(`m-${i}`, { savedAt: 10_000 + i }));
    }
    const machines = await store.listMachineCatalogs();
    expect(machines).toHaveLength(8);
    // The newest save wins a slot; the oldest record (m-big at 5 000) is evicted.
    expect(machines.map((record) => record.machineKey)).not.toContain("m-big");
    expect(machines[0].machineKey).toBe("m-7");
  });

  it("prunes only other accounts' catalogs, keeping the current owner's and ownerless records", async () => {
    const store = new WebClientEnvStore(new MemoryStorage());
    await store.saveMachineCatalog(catalog("mine", { ownerUserId: "user-1" }));
    await store.saveMachineCatalog(catalog("theirs", { ownerUserId: "user-2" }));
    await store.saveMachineCatalog(catalog("ownerless", { ownerUserId: null }));

    await expect(store.pruneMachineCatalogs("user-1")).resolves.toEqual(["theirs"]);
    const afterSignIn = (await store.listMachineCatalogs()).map((record) => record.machineKey).sort();
    expect(afterSignIn).toEqual(["mine", "ownerless"]);

    // Sign-out (null owner) must not leave the signed-out account's project
    // names on the welcome surface, but browser-local ownerless records stay.
    await expect(store.pruneMachineCatalogs(null)).resolves.toEqual(["mine"]);
    const afterSignOut = (await store.listMachineCatalogs()).map((record) => record.machineKey);
    expect(afterSignOut).toEqual(["ownerless"]);
  });
});
