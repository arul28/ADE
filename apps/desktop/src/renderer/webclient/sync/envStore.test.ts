import { describe, expect, it } from "vitest";

import {
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

    await expect(store.pruneAccountOwnedEnvironments("account-b")).resolves.toEqual([
      "stale",
    ]);
    await expect(store.listEnvironments()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ envId: "manual" }),
        expect.objectContaining({ envId: "current" }),
      ]),
    );
    await expect(store.pruneAccountOwnedEnvironments(null)).resolves.toEqual([
      "current",
    ]);
    await expect(store.listEnvironments()).resolves.toEqual([
      expect.objectContaining({ envId: "manual" }),
    ]);
  });
});
