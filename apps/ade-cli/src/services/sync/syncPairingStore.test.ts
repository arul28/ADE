import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import {
  verifyClerkAccountAttestation,
  type VerifiedAccountAttestation,
} from "../account/accountAttestationVerifier";
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
    const stat = fs.statSync(filePath);
    expect(stat.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
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

describe("staged re-pair privilege direction", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const PIN = "428193";

  function createStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rotation-privilege-"));
    roots.push(root);
    const pinStore = createSyncPinStore({ filePath: path.join(root, "pin.json") });
    pinStore.setPin(PIN);
    return createSyncPairingStore({ filePath: path.join(root, "paired.json"), pinStore });
  }

  const desktopPeer = {
    deviceId: "desktop-rotation",
    deviceName: "MacBook Pro",
    platform: "macOS",
    deviceType: "desktop",
    siteId: "desktop-rotation-site",
    dbVersion: 0,
  } satisfies SyncPeerMetadata;

  // A staged rotation must never park a privilege the re-pair took away: the
  // committed record is what every gate reads, so a late withdrawal is a leak.
  it("withdraws a runtime-host grant immediately even though the secret stages", () => {
    const store = createStore();
    store.pairPeer(desktopPeer, PIN, { allowDirectPinRuntimeHost: true });
    expect(store.getPairingRecord(desktopPeer.deviceId)?.runtimeHostGranted).toBe(true);

    // Re-pairing over Relay cannot authorize a runtime host.
    const rotated = store.pairPeer(desktopPeer, PIN, { allowDirectPinRuntimeHost: false });

    expect(store.hasPendingRotation(desktopPeer.deviceId)).toBe(true);
    expect(store.getPairingRecord(desktopPeer.deviceId)?.runtimeHostGranted).toBe(false);
    expect(store.authenticate(desktopPeer.deviceId, rotated.secret)).toBe(true);
    expect(store.getPairingRecord(desktopPeer.deviceId)?.runtimeHostGranted).toBe(false);
  });

  it("keeps an existing grant while a re-pair that would elevate is unproven", () => {
    const store = createStore();
    store.pairPeer(desktopPeer, PIN, { allowDirectPinRuntimeHost: true });
    store.pairPeer(desktopPeer, PIN, { allowDirectPinRuntimeHost: true });

    expect(store.getPairingRecord(desktopPeer.deviceId)?.runtimeHostGranted).toBe(true);
  });
});

// Account sign-in used to throw on any record it had not created itself, which
// permanently stranded a device that paired by QR/PIN and later lost its stored
// secret. Adoption is now allowed, but only for a record carrying the pinned
// device key that the caller's DPoP proof was checked against.
describe("account adoption of a legacy manual pairing", () => {
  const roots: string[] = [];
  const ISSUER = "https://pairing-store-clerk.test";
  const OAUTH_CLIENT_ID = "pairing-store-client";
  const OWNER_USER_ID = "user_adoption_owner";
  const OTHER_USER_ID = "user_adoption_other";
  const PIN = "428193";
  const OTHER_DPOP_PUBLIC_KEY = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.alloc(64, 0x02),
  ]).toString("base64");
  let jwksServer: Server;
  let jwksUrl = "";
  let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    signingKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    const jwks = { keys: [{ ...publicJwk, alg: "RS256", kid: "pairing-store-key", use: "sig" }] };
    jwksServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(jwks));
    });
    await new Promise<void>((resolve, reject) => {
      jwksServer.once("error", reject);
      jwksServer.listen(0, "127.0.0.1", resolve);
    });
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;
  });

  afterAll(async () => {
    // A `beforeAll` failure leaves this undefined; without the guard the
    // teardown throws a second, unrelated error that buries the real one.
    if (!jwksServer) return;
    await new Promise<void>((resolve, reject) => {
      jwksServer.close((error) => error ? reject(error) : resolve());
    });
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /** The verifier brands its result, so only a real token can produce one. */
  async function attestationFor(userId: string): Promise<VerifiedAccountAttestation> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "pairing-store-key" })
      .setIssuer(ISSUER)
      .setSubject(userId)
      .setAudience(OAUTH_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(signingKey);
    return verifyClerkAccountAttestation({
      token,
      expectedUserId: userId,
      config: { issuer: ISSUER, jwksUrl, oauthClientId: OAUTH_CLIENT_ID },
    });
  }

  function createStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-adoption-"));
    roots.push(root);
    const filePath = path.join(root, "paired.json");
    const pinStore = createSyncPinStore({ filePath: path.join(root, "pin.json") });
    pinStore.setPin(PIN);
    return { filePath, pinStore, store: createSyncPairingStore({ filePath, pinStore }) };
  }

  const peer = {
    deviceId: "legacy-manual-store-phone",
    deviceName: "iPhone",
    platform: "iOS",
    deviceType: "phone",
    siteId: "legacy-manual-store-site",
    dbVersion: 0,
  } satisfies SyncPeerMetadata;

  /** Removes the field entirely, which is the true on-disk legacy shape. */
  function dropAccountOwnerField(filePath: string, deviceId: string): void {
    const records = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    delete records[deviceId]?.accountOwnerUserId;
    fs.writeFileSync(filePath, `${JSON.stringify(records, null, 2)}\n`);
  }

  it("adopts a keyed local pairing, keeping its pinned key and creation time", async () => {
    const { filePath, store } = createStore();
    const legacy = store.pairPeer(peer, PIN, { dpopPublicKey: VALID_DPOP_PUBLIC_KEY });
    dropAccountOwnerField(filePath, peer.deviceId);
    const before = store.getPairingRecord(peer.deviceId);
    expect(before).not.toHaveProperty("accountOwnerUserId");

    const adopted = store.pairPeerViaAccount(peer, await attestationFor(OWNER_USER_ID), {
      // A hello may advertise a key inline; adoption must ignore it in favour
      // of the key already pinned on the record.
      dpopPublicKey: OTHER_DPOP_PUBLIC_KEY,
    });

    expect(adopted.pendingRotationExpiresAtMs).toBeNull();
    const after = store.getPairingRecord(peer.deviceId);
    expect(after?.accountOwnerUserId).toBe(OWNER_USER_ID);
    expect(after?.dpopPublicKey).toBe(VALID_DPOP_PUBLIC_KEY);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(store.verifySecret(peer.deviceId, adopted.secret)).toBe("committed");
    expect(store.verifySecret(peer.deviceId, legacy.secret)).toBeNull();
  });

  it("refuses to adopt a local pairing that has no pinned device key", async () => {
    const { filePath, store } = createStore();
    const legacy = store.pairPeer(peer, PIN);
    dropAccountOwnerField(filePath, peer.deviceId);
    const attestation = await attestationFor(OWNER_USER_ID);

    expect(() => store.pairPeerViaAccount(peer, attestation, {
      dpopPublicKey: VALID_DPOP_PUBLIC_KEY,
    })).toThrow(/device key/i);
    expect(store.getPairingRecord(peer.deviceId)?.accountOwnerUserId ?? null).toBeNull();
    expect(store.verifySecret(peer.deviceId, legacy.secret)).toBe("committed");
  });

  it("refuses to adopt a pairing owned by a different account", async () => {
    const { store } = createStore();
    const owned = store.pairPeerViaAccount(peer, await attestationFor(OTHER_USER_ID), {
      dpopPublicKey: VALID_DPOP_PUBLIC_KEY,
    });
    const attestation = await attestationFor(OWNER_USER_ID);

    expect(() => store.pairPeerViaAccount(peer, attestation, {
      dpopPublicKey: VALID_DPOP_PUBLIC_KEY,
    })).toThrow(/different ADE account/i);
    expect(store.getPairingRecord(peer.deviceId)?.accountOwnerUserId).toBe(OTHER_USER_ID);
    expect(store.verifySecret(peer.deviceId, owned.secret)).toBe("committed");
  });

  it("lets a PIN re-pair declassify an adopted pairing back to local immediately", async () => {
    const { filePath, store } = createStore();
    store.pairPeer(peer, PIN, { dpopPublicKey: VALID_DPOP_PUBLIC_KEY });
    dropAccountOwnerField(filePath, peer.deviceId);
    store.pairPeerViaAccount(peer, await attestationFor(OWNER_USER_ID));
    expect(store.getPairingRecord(peer.deviceId)?.accountOwnerUserId).toBe(OWNER_USER_ID);

    // Declassification is a reduction, so it lands on the committed record even
    // though the replacement secret only stages.
    const repaired = store.pairPeer(peer, PIN, { dpopPublicKey: VALID_DPOP_PUBLIC_KEY });

    expect(store.hasPendingRotation(peer.deviceId)).toBe(true);
    expect(store.getPairingRecord(peer.deviceId)?.accountOwnerUserId).toBeNull();
    expect(store.authenticate(peer.deviceId, repaired.secret)).toBe(true);
    expect(store.getPairingRecord(peer.deviceId)?.accountOwnerUserId).toBeNull();
    expect(store.revokeAccountOwnedExcept(null)).toEqual([]);
  });

  // Adoption grants the account a way to USE a hand-made pairing; it must not
  // hand the account power to DESTROY it. Without `localTrustOrigin` the
  // adopted record joins the set `revokeAccountOwnedExcept` deletes, so one
  // account hello would silently make a QR/PIN/SSH pairing disappear the next
  // time the Mac signed out — stranding the device with no recovery except
  // walking back to the machine, which is the entire failure this change exists
  // to remove.
  it("keeps an adopted manual pairing alive when the Mac signs out", async () => {
    const { filePath, pinStore, store } = createStore();
    store.pairPeer(peer, PIN, { dpopPublicKey: VALID_DPOP_PUBLIC_KEY });
    dropAccountOwnerField(filePath, peer.deviceId);
    const adopted = store.pairPeerViaAccount(peer, await attestationFor(OWNER_USER_ID));
    expect(store.getPairingRecord(peer.deviceId)?.accountOwnerUserId).toBe(OWNER_USER_ID);
    expect(store.getPairingRecord(peer.deviceId)?.localTrustOrigin).toBe(true);

    // Sign-out. Surviving is not enough: every reconnect path rejects a record
    // whose owner no longer matches the signed-in account, so the record has to
    // come back DEMOTED to pure local trust or it is intact and unusable —
    // the same dead end, moved.
    expect(store.revokeAccountOwnedExcept(null)).toEqual([]);
    expect(store.getPairingRecord(peer.deviceId)?.accountOwnerUserId).toBeNull();
    expect(store.getPairingRecord(peer.deviceId)?.localTrustOrigin).toBe(true);
    expect(store.verifySecret(peer.deviceId, adopted.secret)).toBe("committed");

    // And it must be durable, not just correct in memory.
    const reopened = createSyncPairingStore({ filePath, pinStore });
    expect(reopened.getPairingRecord(peer.deviceId)?.accountOwnerUserId).toBeNull();

    // A switch to a different account leaves the now-local record alone.
    expect(store.revokeAccountOwnedExcept("user_someone_else")).toEqual([]);
    expect(store.verifySecret(peer.deviceId, adopted.secret)).toBe("committed");
  });

  it("still revokes an account-first pairing on sign-out", async () => {
    const { store } = createStore();
    store.pairPeerViaAccount(peer, await attestationFor(OWNER_USER_ID));
    expect(store.getPairingRecord(peer.deviceId)?.localTrustOrigin).not.toBe(true);
    expect(store.revokeAccountOwnedExcept(null)).toEqual([peer.deviceId]);
    expect(store.getPairingRecord(peer.deviceId)).toBeNull();
  });

  it("refuses to adopt a local pairing whose pinned key is only whitespace", async () => {
    const { filePath, store } = createStore();
    store.pairPeer(peer, PIN, { dpopPublicKey: VALID_DPOP_PUBLIC_KEY });
    dropAccountOwnerField(filePath, peer.deviceId);
    // A whitespace field is not a pinned key. Treating it as one would let the
    // DPoP check fall through to trusting whatever key the caller presented.
    const records = JSON.parse(fs.readFileSync(filePath, "utf8"));
    records[peer.deviceId].dpopPublicKey = "   ";
    fs.writeFileSync(filePath, JSON.stringify(records));

    const attestation = await attestationFor(OWNER_USER_ID);
    expect(() => store.pairPeerViaAccount(peer, attestation))
      .toThrow(/without a device key cannot be adopted/);
  });
});
