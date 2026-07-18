import { describe, expect, it } from "vitest";
import { createRegisteredSyncPeerGate, type RegisteredSyncPeerCounter } from "./syncPeerCompactionGate";

describe("createRegisteredSyncPeerGate", () => {
  it("reads the durable peer count at every compaction decision", () => {
    let registeredPeerCount: number | null = 0;
    const syncService: RegisteredSyncPeerCounter = {
      getRegisteredPeerCount: () => registeredPeerCount,
    };
    const hasSyncPeers = createRegisteredSyncPeerGate({
      syncEnabled: true,
      getSyncService: () => syncService,
    });

    expect(hasSyncPeers()).toBe(false);
    registeredPeerCount = 1;
    expect(hasSyncPeers()).toBe(true);
    registeredPeerCount = 0;
    expect(hasSyncPeers()).toBe(false);
  });

  it("fails closed before the service exists and when the registry is unreadable", () => {
    let syncService: RegisteredSyncPeerCounter | null = null;
    const hasSyncPeers = createRegisteredSyncPeerGate({
      syncEnabled: true,
      getSyncService: () => syncService,
    });

    expect(hasSyncPeers()).toBe(true);
    syncService = { getRegisteredPeerCount: () => null };
    expect(hasSyncPeers()).toBe(true);
    syncService = {
      getRegisteredPeerCount: () => {
        throw new Error("registry unreadable");
      },
    };
    expect(hasSyncPeers()).toBe(true);
  });

  it("allows compaction when sync is disabled", () => {
    const hasSyncPeers = createRegisteredSyncPeerGate({
      syncEnabled: false,
      getSyncService: () => null,
    });

    expect(hasSyncPeers()).toBe(false);
  });
});
