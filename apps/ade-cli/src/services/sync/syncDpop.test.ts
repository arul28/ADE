import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSyncDpopChallenge,
  createSyncDpopNonceCache,
  evaluatePairedHelloDpop,
  sha256Hex,
  verifySyncDpopProof,
} from "./syncDpop";

const DEVICE_ID = "phone-1";
const SECRET = "paired-secret";

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x963 = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64");
  return { privateKey, x963 };
}

function signProof(privateKey: ReturnType<typeof makeKeyPair>["privateKey"], args: {
  deviceId?: string;
  secret?: string;
  timestamp?: number;
  nonce?: string;
}) {
  const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = args.nonce ?? `n-${Math.random()}`;
  const challenge = buildSyncDpopChallenge({
    deviceId: args.deviceId ?? DEVICE_ID,
    secretSha256Hex: sha256Hex(args.secret ?? SECRET),
    timestamp,
    nonce,
  });
  // DER ECDSA-SHA256, matching SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256).
  const signature = createSign("sha256").update(challenge, "utf8").sign(privateKey).toString("base64");
  return { timestamp, nonce, signature };
}

describe("verifySyncDpopProof", () => {
  it("accepts a fresh proof and rejects its replay", () => {
    const { privateKey, x963 } = makeKeyPair();
    const cache = createSyncDpopNonceCache();
    const proof = signProof(privateKey, {});
    const check = (p: typeof proof) => verifySyncDpopProof({
      publicKeyX963Base64: x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: p,
      checkAndRecordNonce: (nonce) => cache.checkAndRecord(DEVICE_ID, nonce),
    });
    expect(check(proof)).toEqual({ ok: true });
    expect(check(proof)).toEqual({ ok: false, reason: "replayed_nonce" });
  });

  it("rejects a proof bound to a different paired secret (cross-host replay)", () => {
    const { privateKey, x963 } = makeKeyPair();
    const proof = signProof(privateKey, { secret: "other-hosts-secret" });
    const verdict = verifySyncDpopProof({
      publicKeyX963Base64: x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof,
      checkAndRecordNonce: () => false,
    });
    expect(verdict).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects timestamps outside the skew window in both directions", () => {
    const { privateKey, x963 } = makeKeyPair();
    const now = Math.floor(Date.now() / 1000);
    for (const timestamp of [now - 500, now + 500]) {
      const proof = signProof(privateKey, { timestamp });
      const verdict = verifySyncDpopProof({
        publicKeyX963Base64: x963,
        deviceId: DEVICE_ID,
        secret: SECRET,
        proof,
        checkAndRecordNonce: () => false,
      });
      expect(verdict).toEqual({ ok: false, reason: "stale_timestamp" });
    }
  });

  it("does not burn the nonce on an invalid signature", () => {
    const { privateKey, x963 } = makeKeyPair();
    const cache = createSyncDpopNonceCache();
    const proof = signProof(privateKey, { nonce: "reusable-nonce" });
    const tampered = { ...proof, signature: Buffer.from("garbage").toString("base64") };
    const check = (p: typeof proof) => verifySyncDpopProof({
      publicKeyX963Base64: x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: p,
      checkAndRecordNonce: (nonce) => cache.checkAndRecord(DEVICE_ID, nonce),
    });
    expect(check(tampered).ok).toBe(false);
    // The attacker's garbage attempt must not have spent the victim's nonce.
    expect(check(proof)).toEqual({ ok: true });
  });

  it("fails closed when the replay cache cannot safely record another nonce", () => {
    const { privateKey, x963 } = makeKeyPair();
    const proof = signProof(privateKey, {});
    expect(verifySyncDpopProof({
      publicKeyX963Base64: x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof,
      checkAndRecordNonce: () => "saturated",
    })).toEqual({ ok: false, reason: "nonce_cache_saturated" });
  });

  it("fails closed on malformed keys and proofs", () => {
    const { privateKey } = makeKeyPair();
    const proof = signProof(privateKey, {});
    const base = { deviceId: DEVICE_ID, secret: SECRET, checkAndRecordNonce: () => false };
    expect(verifySyncDpopProof({ ...base, publicKeyX963Base64: "not-a-key", proof }))
      .toEqual({ ok: false, reason: "invalid_key" });
    expect(verifySyncDpopProof({
      ...base,
      publicKeyX963Base64: Buffer.alloc(65, 7).toString("base64"), // wrong prefix byte
      proof,
    })).toEqual({ ok: false, reason: "invalid_key" });
    expect(verifySyncDpopProof({
      ...base,
      publicKeyX963Base64: "irrelevant",
      proof: { timestamp: Number.NaN, nonce: "", signature: "" },
    })).toEqual({ ok: false, reason: "invalid_proof" });
  });
});

describe("createSyncDpopNonceCache", () => {
  it("does not let one device's flood reopen another device's replay window", () => {
    const cache = createSyncDpopNonceCache({
      maxEntries: 4,
      maxEntriesPerDevice: 2,
    });
    const now = Date.now();

    expect(cache.checkAndRecord("victim-device", "victim-nonce", now)).toBe(false);
    expect(cache.checkAndRecord("flooding-device", "flood-1", now)).toBe(false);
    expect(cache.checkAndRecord("flooding-device", "flood-2", now)).toBe(false);
    expect(cache.checkAndRecord("flooding-device", "flood-3", now)).toBe(false);

    expect(cache.checkAndRecord("victim-device", "victim-nonce", now)).toBe(true);
  });

  it("fails closed instead of evicting another device at the total entry cap", () => {
    const cache = createSyncDpopNonceCache({
      maxEntries: 2,
      maxEntriesPerDevice: 2,
    });
    const now = Date.now();

    expect(cache.checkAndRecord("device-a", "nonce-a", now)).toBe(false);
    expect(cache.checkAndRecord("device-b", "nonce-b", now)).toBe(false);
    expect(cache.checkAndRecord("device-c", "nonce-c", now)).toBe("saturated");
    expect(cache.checkAndRecord("device-a", "nonce-a", now)).toBe(true);
  });
});

describe("evaluatePairedHelloDpop policy", () => {
  it("adopts an offered key via TOFU only when the proof verifies", () => {
    const { privateKey, x963 } = makeKeyPair();
    const cache = createSyncDpopNonceCache();
    let adopted: string | null = null;
    const good = evaluatePairedHelloDpop({
      storedPublicKey: null,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: { ...signProof(privateKey, {}), publicKey: x963 },
      requireDpop: false,
      nonceCache: cache,
      adoptPublicKey: (key) => { adopted = key; },
    });
    expect(good).toBeNull();
    expect(adopted).toBe(x963);

    adopted = null;
    const bad = evaluatePairedHelloDpop({
      storedPublicKey: null,
      deviceId: DEVICE_ID,
      secret: "wrong-secret-for-this-proof",
      proof: { ...signProof(privateKey, {}), publicKey: x963 },
      requireDpop: false,
      nonceCache: cache,
      adoptPublicKey: (key) => { adopted = key; },
    });
    expect(bad).toBe("invalid_signature");
    expect(adopted).toBeNull();
  });

  it("fails closed once a key is on record: proof required, offered key ignored", () => {
    const stored = makeKeyPair();
    const attacker = makeKeyPair();
    const cache = createSyncDpopNonceCache();
    expect(evaluatePairedHelloDpop({
      storedPublicKey: stored.x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: null,
      requireDpop: false,
      nonceCache: cache,
    })).toBe("proof_required");
    // A stolen secret + attacker's own key must not swap the stored key.
    expect(evaluatePairedHelloDpop({
      storedPublicKey: stored.x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: { ...signProof(attacker.privateKey, {}), publicKey: attacker.x963 },
      requireDpop: false,
      nonceCache: cache,
    })).toBe("invalid_signature");
    // The legitimate device still passes.
    expect(evaluatePairedHelloDpop({
      storedPublicKey: stored.x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: signProof(stored.privateKey, {}),
      requireDpop: false,
      nonceCache: cache,
    })).toBeNull();
  });

  it("requireDpop rejects keyless legacy hellos but never blocks upgraded devices", () => {
    // Regression for the /quality gate: requireDpop must bind on EVERY ingress
    // path (the brain handler shipped with a hardcoded `false` at first).
    const { privateKey, x963 } = makeKeyPair();
    const cache = createSyncDpopNonceCache();
    expect(evaluatePairedHelloDpop({
      storedPublicKey: null,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: null,
      requireDpop: true,
      nonceCache: cache,
    })).toBe("dpop_required");
    expect(evaluatePairedHelloDpop({
      storedPublicKey: null,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: null,
      requireDpop: false,
      nonceCache: cache,
    })).toBeNull();
    expect(evaluatePairedHelloDpop({
      storedPublicKey: x963,
      deviceId: DEVICE_ID,
      secret: SECRET,
      proof: signProof(privateKey, {}),
      requireDpop: true,
      nonceCache: cache,
    })).toBeNull();
  });
});
