import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSyncPairingStore } from "./syncPairingStore";
import { createSyncPinStore } from "./syncPinStore";
import type { SyncPeerMetadata } from "../../../shared/types";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeHarness(prefix: string): {
  pairingFile: string;
  pinStore: ReturnType<typeof createSyncPinStore>;
  store: ReturnType<typeof createSyncPairingStore>;
} {
  const dir = tempDir(prefix);
  const pinStore = createSyncPinStore({ filePath: path.join(dir, "pin.json") });
  const pairingFile = path.join(dir, "pairings.json");
  const store = createSyncPairingStore({ filePath: pairingFile, pinStore });
  return { pairingFile, pinStore, store };
}

const samplePeer: SyncPeerMetadata = {
  deviceId: "peer-device-1",
  deviceName: "Arul iPhone",
  platform: "iOS",
  deviceType: "phone",
  siteId: "00000000-0000-4000-8000-000000000001",
  dbVersion: 0,
};

describe("syncPairingStore", () => {
  describe("pairPeer", () => {
    it("throws pin_not_set when no PIN has been configured", () => {
      const { store } = makeHarness("ade-pairing-no-pin-");
      try {
        store.pairPeer(samplePeer, "123456");
        expect.fail("pairPeer should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error & { code?: string }).code).toBe("pin_not_set");
      }
    });

    it("throws invalid_pin when the supplied PIN does not match", () => {
      const { store, pinStore } = makeHarness("ade-pairing-wrong-pin-");
      pinStore.setPin("428193");
      try {
        store.pairPeer(samplePeer, "111111");
        expect.fail("pairPeer should have thrown");
      } catch (err) {
        expect((err as Error & { code?: string }).code).toBe("invalid_pin");
      }
    });

    it("trims whitespace before comparing the PIN", () => {
      const { store, pinStore } = makeHarness("ade-pairing-trim-");
      pinStore.setPin("428193");
      const result = store.pairPeer(samplePeer, "  428193\n");
      expect(result.deviceId).toBe(samplePeer.deviceId);
      expect(result.secret).toMatch(/^[0-9a-f]{48}$/);
    });

    it("persists a peer record with hashed secret and peer metadata", () => {
      const { store, pinStore, pairingFile } = makeHarness("ade-pairing-persist-");
      pinStore.setPin("000111");
      const result = store.pairPeer(samplePeer, "000111");

      const records = JSON.parse(fs.readFileSync(pairingFile, "utf8")) as Record<
        string,
        { secretHash: string; peerName: string; peerPlatform: string; peerDeviceType: string; lastUsedAt: string | null }
      >;
      const record = records[samplePeer.deviceId];
      expect(record).toBeTruthy();
      expect(record.peerName).toBe(samplePeer.deviceName);
      expect(record.peerPlatform).toBe(samplePeer.platform);
      expect(record.peerDeviceType).toBe(samplePeer.deviceType);
      expect(record.lastUsedAt).toBeNull();
      // secret is never stored in plaintext
      expect(record.secretHash).not.toBe(result.secret);
      expect(record.secretHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces a distinct secret each time even for the same device id", () => {
      const { store, pinStore } = makeHarness("ade-pairing-unique-");
      pinStore.setPin("424242");
      const first = store.pairPeer(samplePeer, "424242");
      const second = store.pairPeer(samplePeer, "424242");
      expect(first.secret).not.toBe(second.secret);
    });

    it("updates an existing device pairing without resetting createdAt", () => {
      const { store, pinStore, pairingFile } = makeHarness("ade-pairing-existing-");
      pinStore.setPin("424242");

      store.pairPeer(samplePeer, "424242");
      const before = JSON.parse(fs.readFileSync(pairingFile, "utf8"));
      const createdAt = before[samplePeer.deviceId].createdAt;

      store.pairPeer({ ...samplePeer, deviceName: "Arul's iPhone" }, "424242");

      const after = JSON.parse(fs.readFileSync(pairingFile, "utf8"));
      expect(Object.keys(after)).toEqual([samplePeer.deviceId]);
      expect(after[samplePeer.deviceId].createdAt).toBe(createdAt);
      expect(after[samplePeer.deviceId].peerName).toBe("Arul's iPhone");
    });
  });

  describe("authenticate", () => {
    it("returns true for a previously paired device using the minted secret", () => {
      const { store, pinStore } = makeHarness("ade-pairing-auth-ok-");
      pinStore.setPin("123987");
      const { deviceId, secret } = store.pairPeer(samplePeer, "123987");
      expect(store.authenticate(deviceId, secret)).toBe(true);
    });

    it("returns false for an unknown device", () => {
      const { store } = makeHarness("ade-pairing-auth-unknown-");
      expect(store.authenticate("never-paired", "whatever")).toBe(false);
    });

    it("returns false when the secret does not match the stored hash", () => {
      const { store, pinStore } = makeHarness("ade-pairing-auth-bad-secret-");
      pinStore.setPin("555555");
      const { deviceId } = store.pairPeer(samplePeer, "555555");
      expect(store.authenticate(deviceId, "not-the-real-secret")).toBe(false);
    });

    it("updates lastUsedAt on successful authentication", () => {
      const { store, pinStore, pairingFile } = makeHarness("ade-pairing-auth-lastused-");
      pinStore.setPin("909090");
      const { deviceId, secret } = store.pairPeer(samplePeer, "909090");

      const before = JSON.parse(fs.readFileSync(pairingFile, "utf8"));
      expect(before[deviceId].lastUsedAt).toBeNull();

      expect(store.authenticate(deviceId, secret)).toBe(true);

      const after = JSON.parse(fs.readFileSync(pairingFile, "utf8"));
      expect(typeof after[deviceId].lastUsedAt).toBe("string");
      expect(after[deviceId].lastUsedAt.length).toBeGreaterThan(0);
    });
  });

  describe("revoke", () => {
    it("removes a paired device so subsequent authenticate calls fail", () => {
      const { store, pinStore } = makeHarness("ade-pairing-revoke-");
      pinStore.setPin("700000");
      const { deviceId, secret } = store.pairPeer(samplePeer, "700000");
      expect(store.authenticate(deviceId, secret)).toBe(true);

      store.revoke(deviceId);
      expect(store.authenticate(deviceId, secret)).toBe(false);
    });

    it("trims the deviceId and ignores empty or unknown ids", () => {
      const { store, pinStore, pairingFile } = makeHarness("ade-pairing-revoke-noop-");
      pinStore.setPin("700000");
      store.pairPeer(samplePeer, "700000");

      store.revoke("   ");
      store.revoke("not-a-real-device");

      const records = JSON.parse(fs.readFileSync(pairingFile, "utf8"));
      expect(Object.keys(records)).toEqual([samplePeer.deviceId]);

      store.revoke(`  ${samplePeer.deviceId}  `);
      const after = JSON.parse(fs.readFileSync(pairingFile, "utf8"));
      expect(after[samplePeer.deviceId]).toBeUndefined();
    });
  });
});
