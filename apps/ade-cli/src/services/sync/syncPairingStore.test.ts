import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import { createSyncPairingStore, PAIRING_ROTATION_WINDOW_MS } from "./syncPairingStore";
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

  it("counts durable pairings independently of live connections", () => {
    const { store } = createStore();
    const peer = {
      deviceId: "offline-phone-1",
      deviceName: "Offline iPhone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "offline-ios-site-1",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;

    expect(store.countPairingRecords()).toBe(0);
    store.pairPeerViaLocalTrust(peer);
    expect(store.countPairingRecords()).toBe(1);
    store.revoke(peer.deviceId);
    expect(store.countPairingRecords()).toBe(0);
  });

  it("does not treat an unreadable pairing registry as empty", () => {
    const { filePath, store } = createStore();
    fs.writeFileSync(filePath, "not json");
    expect(store.countPairingRecords()).toBeNull();
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

describe("PIN re-pair staged rotation", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const PIN = "428193";

  function createStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rotation-"));
    roots.push(root);
    const pinStore = createSyncPinStore({ filePath: path.join(root, "pin.json") });
    pinStore.setPin(PIN);
    return createSyncPairingStore({ filePath: path.join(root, "paired.json"), pinStore });
  }

  const peer = {
    deviceId: "iphone-rotation",
    deviceName: "Arul's iPhone",
    platform: "iOS",
    deviceType: "phone",
    siteId: "iphone-rotation-site",
    dbVersion: 0,
  } satisfies SyncPeerMetadata;

  it("commits a first-time pair immediately, with nothing staged", () => {
    const store = createStore();
    const first = store.pairPeer(peer, PIN);

    expect(first.pendingRotationExpiresAtMs).toBeNull();
    expect(store.hasPendingRotation(peer.deviceId)).toBe(false);
    expect(store.authenticate(peer.deviceId, first.secret)).toBe(true);
  });

  // THE regression test for this bug class: the connection dies between
  // `pairing_result` and `hello`, exactly where the old code had already
  // destroyed the working secret. Both secrets must work on the next attempt.
  it("keeps a previously working secret alive when a re-pair is never proven", () => {
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const rotated = store.pairPeer(peer, PIN);

    expect(rotated.secret).not.toBe(original.secret);
    expect(rotated.pendingRotationExpiresAtMs).toBeGreaterThan(Date.now());
    // The device that dropped mid-rotation still holds the original.
    expect(store.verifySecret(peer.deviceId, original.secret)).toBe("committed");
    // The device that DID save the replacement is equally able to connect.
    expect(store.verifySecret(peer.deviceId, rotated.secret)).toBe("pending");
    expect(store.authenticate(peer.deviceId, original.secret)).toBe(true);
  });

  it("promotes the staged secret the first time a hello authenticates with it", () => {
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const rotated = store.pairPeer(peer, PIN);

    expect(store.authenticate(peer.deviceId, rotated.secret)).toBe(true);

    expect(store.hasPendingRotation(peer.deviceId)).toBe(false);
    expect(store.authenticate(peer.deviceId, original.secret)).toBe(false);
    expect(store.authenticate(peer.deviceId, rotated.secret)).toBe(true);
  });

  it("keeps both secrets live until a commit-capable client acknowledges hello_ok", () => {
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const rotated = store.pairPeer(
      { ...peer, deviceName: "Committed iPhone" },
      PIN,
      { dpopPublicKey: VALID_DPOP_PUBLIC_KEY },
    );

    expect(store.authenticate(
      peer.deviceId,
      rotated.secret,
      { deferPendingCommit: true },
    )).toBe(true);
    expect(store.getPairingRecordForSecret(peer.deviceId, rotated.secret)).toMatchObject({
      peerName: "Committed iPhone",
      dpopPublicKey: VALID_DPOP_PUBLIC_KEY,
    });
    expect(store.verifySecret(peer.deviceId, original.secret)).toBe("committed");
    expect(store.verifySecret(peer.deviceId, rotated.secret)).toBe("pending");

    expect(store.commitPendingRotation(peer.deviceId, rotated.secret)).toMatchObject({
      peerName: "Committed iPhone",
      dpopPublicKey: VALID_DPOP_PUBLIC_KEY,
    });
    expect(store.verifySecret(peer.deviceId, original.secret)).toBeNull();
    expect(store.verifySecret(peer.deviceId, rotated.secret)).toBe("committed");
  });

  it("refuses an explicit commit after its staged rotation expires", () => {
    vi.useFakeTimers();
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const rotated = store.pairPeer(peer, PIN);

    expect(store.authenticate(
      peer.deviceId,
      rotated.secret,
      { deferPendingCommit: true },
    )).toBe(true);
    vi.advanceTimersByTime(PAIRING_ROTATION_WINDOW_MS + 1_000);

    expect(store.commitPendingRotation(peer.deviceId, rotated.secret)).toBeNull();
    expect(store.verifySecret(peer.deviceId, original.secret)).toBe("committed");
    expect(store.verifySecret(peer.deviceId, rotated.secret)).toBeNull();
  });

  it("does not let a stale socket commit a newer staged rotation", () => {
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const stale = store.pairPeer(peer, PIN);
    expect(store.authenticate(
      peer.deviceId,
      stale.secret,
      { deferPendingCommit: true },
    )).toBe(true);

    const newer = store.pairPeer(peer, PIN);

    expect(store.commitPendingRotation(peer.deviceId, stale.secret)).toBeNull();
    expect(store.verifySecret(peer.deviceId, original.secret)).toBe("committed");
    expect(store.verifySecret(peer.deviceId, stale.secret)).toBeNull();
    expect(store.verifySecret(peer.deviceId, newer.secret)).toBe("pending");
  });

  it("reverts to the committed secret once the rotation window lapses", () => {
    vi.useFakeTimers();
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const rotated = store.pairPeer(peer, PIN);

    vi.advanceTimersByTime(PAIRING_ROTATION_WINDOW_MS + 1_000);

    expect(store.authenticate(peer.deviceId, rotated.secret)).toBe(false);
    expect(store.authenticate(peer.deviceId, original.secret)).toBe(true);
    expect(store.hasPendingRotation(peer.deviceId)).toBe(false);
  });

  it("keeps at most one outstanding rotation and never chains off an unproven one", () => {
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const firstRetry = store.pairPeer(peer, PIN);
    const secondRetry = store.pairPeer(peer, PIN);

    expect(store.verifySecret(peer.deviceId, original.secret)).toBe("committed");
    expect(store.verifySecret(peer.deviceId, firstRetry.secret)).toBeNull();
    expect(store.verifySecret(peer.deviceId, secondRetry.secret)).toBe("pending");
  });

  it("does not let a read-only verification promote the staged secret", () => {
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const rotated = store.pairPeer(peer, PIN);

    expect(store.verifySecret(peer.deviceId, rotated.secret)).toBe("pending");

    expect(store.hasPendingRotation(peer.deviceId)).toBe(true);
    expect(store.authenticate(peer.deviceId, original.secret)).toBe(true);
  });

  it("hides the staged record from every authorization read", () => {
    const store = createStore();
    store.pairPeer(peer, PIN);
    const rotated = store.pairPeer(
      { ...peer, deviceName: "Renamed iPhone" },
      PIN,
      { dpopPublicKey: VALID_DPOP_PUBLIC_KEY },
    );

    // The committed record is what every gate must read until the device
    // proves it has the replacement: the staged secret and the DPoP binding it
    // carries stay invisible. Descriptive fields are not credentials, so a
    // rename lands immediately rather than waiting on the acknowledgement.
    const beforeCommit = store.getPairingRecord(peer.deviceId);
    expect(beforeCommit?.peerName).toBe("Renamed iPhone");
    expect(beforeCommit?.dpopPublicKey ?? null).toBeNull();
    expect(beforeCommit).not.toHaveProperty("pendingRotation");
    expect(store.authenticate(peer.deviceId, rotated.secret)).toBe(true);

    store.authenticate(peer.deviceId, rotated.secret);

    const afterCommit = store.getPairingRecord(peer.deviceId);
    expect(afterCommit?.peerName).toBe("Renamed iPhone");
    expect(afterCommit?.dpopPublicKey).toBe(VALID_DPOP_PUBLIC_KEY);
  });

  // Only PIN pairing crosses the wire twice more before the device can save
  // what it was given. The in-process trust paths hand their secret straight
  // back to the caller, so they commit immediately — and supersede a staged
  // rotation nobody claimed rather than chaining off it.
  it("commits immediately on the in-process trust paths and clears a stale staged rotation", () => {
    const store = createStore();
    const original = store.pairPeer(peer, PIN);
    const stranded = store.pairPeer(peer, PIN);
    expect(store.hasPendingRotation(peer.deviceId)).toBe(true);

    const local = store.pairPeerViaLocalTrust(peer);

    expect(local.pendingRotationExpiresAtMs).toBeNull();
    expect(store.hasPendingRotation(peer.deviceId)).toBe(false);
    expect(store.verifySecret(peer.deviceId, local.secret)).toBe("committed");
    expect(store.verifySecret(peer.deviceId, stranded.secret)).toBeNull();
    expect(store.verifySecret(peer.deviceId, original.secret)).toBeNull();
  });
});
