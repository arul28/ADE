import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import { createSyncPairingStore } from "./syncPairingStore";
import { createSyncPinStore } from "./syncPinStore";

const VALID_DPOP_PUBLIC_KEY = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.alloc(64, 0x01),
]).toString("base64");

describe("sync SSH pairing trust", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function createStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ssh-pairing-"));
    roots.push(root);
    const filePath = path.join(root, "paired.json");
    const pinStore = createSyncPinStore({ filePath: path.join(root, "pin.json") });
    return {
      filePath,
      pinStore,
      store: createSyncPairingStore({
        filePath,
        pinStore,
      }),
    };
  }

  it("issues an ordinary DPoP-bound pairing after local OS-user authentication", () => {
    const { filePath, store } = createStore();
    const peer = {
      deviceId: "ios-device-1",
      deviceName: "Arul's iPhone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "ios-site-1",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;

    const paired = store.pairPeerViaLocalTrust(peer, {
      dpopPublicKey: VALID_DPOP_PUBLIC_KEY,
    });

    expect(paired.deviceId).toBe(peer.deviceId);
    expect(paired.secret).toHaveLength(48);
    expect(store.authenticate(peer.deviceId, paired.secret)).toBe(true);
    const record = store.getPairingRecord(peer.deviceId);
    expect(record).toMatchObject({
      peerName: peer.deviceName,
      peerDeviceType: "phone",
      dpopPublicKey: VALID_DPOP_PUBLIC_KEY,
      runtimeHostGranted: false,
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(filePath, "utf8")).not.toContain(paired.secret);
  });

  it("grants desktop runtime access only after the SSH trust gate", () => {
    const { store } = createStore();
    const peer = {
      deviceId: "desktop-device-1",
      deviceName: "MacBook Pro",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "desktop-site-1",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;

    store.pairPeerViaLocalTrust(peer, { dpopPublicKey: VALID_DPOP_PUBLIC_KEY });

    expect(store.getPairingRecord(peer.deviceId)?.runtimeHostGranted).toBe(true);
  });

  it.each([
    { label: "direct desktop", deviceType: "desktop" as const, allowDirectPinRuntimeHost: true, expected: true },
    { label: "Relay desktop", deviceType: "desktop" as const, allowDirectPinRuntimeHost: false, expected: false },
    { label: "direct phone", deviceType: "phone" as const, allowDirectPinRuntimeHost: true, expected: false },
  ])("keeps PIN runtime-host capability scoped to a $label", ({
    deviceType,
    allowDirectPinRuntimeHost,
    expected,
  }) => {
    const { store, pinStore } = createStore();
    pinStore.setPin("428193");
    const peer = {
      deviceId: `pin-${deviceType}-${allowDirectPinRuntimeHost}`,
      deviceName: `PIN ${deviceType}`,
      platform: deviceType === "phone" ? "iOS" : "macOS",
      deviceType,
      siteId: `pin-${deviceType}-site`,
      dbVersion: 0,
    } satisfies SyncPeerMetadata;

    store.pairPeer(peer, "428193", { allowDirectPinRuntimeHost });

    expect(store.getPairingRecord(peer.deviceId)?.runtimeHostGranted).toBe(expected);
  });
});
