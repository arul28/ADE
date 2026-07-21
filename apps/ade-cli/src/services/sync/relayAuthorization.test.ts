import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SyncRelayAuthorizationLease,
  SyncRelayReauthorizePayload,
  SyncRelayReauthorizeResultPayload,
} from "../../../../desktop/src/shared/types";
import {
  buildRelayReauthorizationChallenge,
  createRelayAuthorizationLifecycle,
  sha256RelayToken,
} from "./relayAuthorization";

const DEVICE_ID = "browser-device";
const OWNER_USER_ID = "user-owner";
const NOW_MS = 1_800_000_000_000;

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

function reauthorizePayload(args: {
  privateKey: KeyObject;
  lease: SyncRelayAuthorizationLease;
  token: string;
  deviceId?: string;
  challenge?: string;
  nonce?: string;
  timestamp?: number;
}): SyncRelayReauthorizePayload {
  const deviceId = args.deviceId ?? DEVICE_ID;
  const timestamp = args.timestamp ?? Math.floor(NOW_MS / 1_000);
  const nonce = args.nonce ?? `nonce-${args.token}`;
  const canonical = buildRelayReauthorizationChallenge({
    deviceId,
    relayAccountTokenSha256: sha256RelayToken(args.token),
    challenge: args.challenge ?? args.lease.challenge,
    timestamp,
    nonce,
  });
  return {
    deviceId,
    relayAccountToken: args.token,
    proof: {
      timestamp,
      nonce,
      signature: createSign("sha256").update(canonical, "utf8").sign(args.privateKey).toString("base64"),
    },
  };
}

function createHarness(options: {
  capable?: boolean;
  expiresAtMs?: number;
  verify?: (token: string, expectedUserId: string) => Promise<{ userId: string; expiresAtMs: number }>;
  capture?: () => Promise<{ userId: string; generation: number } | null>;
} = {}) {
  const keys = makeKeyPair();
  const results: Array<{ payload: SyncRelayReauthorizeResultPayload; requestId: string | null }> = [];
  const close = vi.fn();
  const verify = vi.fn(options.verify ?? (async (token: string) => ({
    userId: OWNER_USER_ID,
    expiresAtMs: NOW_MS + Number(token.slice("token-".length)) * 30_000,
  })));
  let challengeSequence = 0;
  const lifecycle = createRelayAuthorizationLifecycle({
    capable: options.capable ?? true,
    deviceId: () => DEVICE_ID,
    pinnedPublicKey: () => keys.x963,
    captureHostAuthorization: options.capture ?? (async () => ({
      userId: OWNER_USER_ID,
      generation: 1,
    })),
    verifyAccountToken: verify,
    sendResult: (payload, requestId) => results.push({ payload, requestId }),
    close,
    logger: { warn: vi.fn(), info: vi.fn() },
    randomChallenge: () => `challenge-${++challengeSequence}`,
  });
  lifecycle.initialize({
    ownerUserId: OWNER_USER_ID,
    expiresAtMs: options.expiresAtMs ?? NOW_MS + 5_000,
    challenge: "challenge-initial",
  });
  return { lifecycle, keys, results, close, verify };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Relay authorization lifecycle", () => {
  it("keeps one capable connection authorized across more than three token lifetimes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const harness = createHarness();

    for (let lifetime = 2; lifetime <= 5; lifetime += 1) {
      const lease = harness.lifecycle.metadata()!;
      await harness.lifecycle.handle(reauthorizePayload({
        privateKey: harness.keys.privateKey,
        lease,
        token: `token-${lifetime}`,
      }), `refresh-${lifetime}`);
      expect(harness.results.at(-1)).toMatchObject({
        requestId: `refresh-${lifetime}`,
        payload: { ok: true },
      });
    }

    expect(harness.close).not.toHaveBeenCalled();
    expect(harness.lifecycle.metadata()?.challenge).toBe("challenge-4");
  });

  it("rejects stale tokens and device, key, challenge, and timestamp mismatches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const harness = createHarness();
    const lease = harness.lifecycle.metadata()!;
    const attacker = makeKeyPair();
    const requests = [
      reauthorizePayload({ privateKey: harness.keys.privateKey, lease, token: "token-0" }),
      reauthorizePayload({ privateKey: harness.keys.privateKey, lease, token: "token-2", deviceId: "other-device" }),
      reauthorizePayload({ privateKey: attacker.privateKey, lease, token: "token-2" }),
      reauthorizePayload({ privateKey: harness.keys.privateKey, lease, token: "token-2", challenge: "wrong" }),
      reauthorizePayload({
        privateKey: harness.keys.privateKey,
        lease,
        token: "token-2",
        timestamp: Math.floor(NOW_MS / 1_000) - 500,
      }),
    ];

    for (const [index, request] of requests.entries()) {
      await harness.lifecycle.handle(request, `bad-${index}`);
    }

    expect(harness.results.map(({ payload }) => payload.ok ? "ok" : payload.error.code)).toEqual([
      "token_not_advanced",
      "invalid_proof",
      "invalid_proof",
      "invalid_proof",
      "stale_proof",
    ]);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("treats host or refreshed-token account changes as terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const wrongHost = createHarness({
      capture: async () => ({ userId: "different-host-user", generation: 1 }),
    });
    await wrongHost.lifecycle.handle(reauthorizePayload({
      privateKey: wrongHost.keys.privateKey,
      lease: wrongHost.lifecycle.metadata()!,
      token: "token-2",
    }), "wrong-host");
    expect(wrongHost.results.at(-1)?.payload).toMatchObject({
      ok: false,
      error: { code: "relay_account_changed", retryable: false },
    });
    expect(wrongHost.close).toHaveBeenCalledWith("ADE account session changed");

    const wrongTokenOwner = createHarness({
      verify: async () => ({ userId: "different-token-user", expiresAtMs: NOW_MS + 60_000 }),
    });
    await wrongTokenOwner.lifecycle.handle(reauthorizePayload({
      privateKey: wrongTokenOwner.keys.privateKey,
      lease: wrongTokenOwner.lifecycle.metadata()!,
      token: "token-2",
    }), "wrong-token-owner");
    expect(wrongTokenOwner.results.at(-1)?.payload).toMatchObject({
      ok: false,
      error: { code: "relay_account_changed" },
    });
    expect(wrongTokenOwner.close).toHaveBeenCalledWith("ADE account session changed");
  });

  it("replays the exact successful result after a lost ACK but rejects nonce reuse with changed input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const harness = createHarness();
    const lease = harness.lifecycle.metadata()!;
    const first = reauthorizePayload({
      privateKey: harness.keys.privateKey,
      lease,
      token: "token-2",
      nonce: "lost-ack-nonce",
    });
    await harness.lifecycle.handle(first, "first");
    const firstResult = harness.results.at(-1)?.payload;
    await harness.lifecycle.handle(first, "retry");
    expect(harness.results.at(-1)?.payload).toEqual(firstResult);

    const changed = reauthorizePayload({
      privateKey: harness.keys.privateKey,
      lease: harness.lifecycle.metadata()!,
      token: "token-3",
      nonce: "lost-ack-nonce",
    });
    await harness.lifecycle.handle(changed, "replay");
    expect(harness.results.at(-1)?.payload).toMatchObject({
      ok: false,
      error: { code: "replayed_nonce" },
    });
  });

  it("keeps a capable peer open through verifier failure grace and preserves legacy expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const transient = createHarness({
      expiresAtMs: NOW_MS + 100,
      verify: async () => {
        throw Object.assign(new Error("JWKS unavailable"), { code: "verification_unavailable" });
      },
    });
    await transient.lifecycle.handle(reauthorizePayload({
      privateKey: transient.keys.privateKey,
      lease: transient.lifecycle.metadata()!,
      token: "token-2",
    }), "transient");
    expect(transient.results.at(-1)?.payload).toMatchObject({
      ok: false,
      error: { code: "verification_failed", retryable: true },
    });
    await vi.advanceTimersByTimeAsync(10_099);
    expect(transient.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transient.close).toHaveBeenCalledWith("ADE Relay account proof expired");

    const legacy = createHarness({ capable: false, expiresAtMs: Date.now() + 100 });
    expect(legacy.lifecycle.metadata()).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(legacy.close).toHaveBeenCalledWith("ADE Relay account proof expired");
  });

  it("preserves the lease and challenge when a project host adopts the socket", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const first = createHarness();
    const handedOff = first.lifecycle.snapshot();
    const second = createHarness();
    second.lifecycle.initialize(handedOff);

    expect(second.lifecycle.snapshot()).toEqual(handedOff);
    expect(second.lifecycle.metadata()?.challenge).toBe("challenge-initial");
  });

  it("invalidates a delayed verifier when the lifecycle is disposed for handoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    let resolveVerification!: (value: { userId: string; expiresAtMs: number }) => void;
    const verification = new Promise<{ userId: string; expiresAtMs: number }>((resolve) => {
      resolveVerification = resolve;
    });
    const harness = createHarness({ verify: async () => await verification });
    const original = harness.lifecycle.snapshot();
    const work = harness.lifecycle.handle(reauthorizePayload({
      privateKey: harness.keys.privateKey,
      lease: harness.lifecycle.metadata()!,
      token: "token-2",
    }), "delayed");
    await vi.waitFor(() => expect(harness.verify).toHaveBeenCalledTimes(1));

    harness.lifecycle.dispose();
    resolveVerification({ userId: OWNER_USER_ID, expiresAtMs: NOW_MS + 60_000 });
    await work;

    expect(harness.results).toEqual([]);
    expect(harness.lifecycle.snapshot()).toEqual(original);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("carries a lost-success receipt through handoff for an exact retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const first = createHarness();
    const request = reauthorizePayload({
      privateKey: first.keys.privateKey,
      lease: first.lifecycle.metadata()!,
      token: "token-2",
      nonce: "handoff-lost-success",
    });
    await first.lifecycle.handle(request, "lost");
    const success = first.results.at(-1)?.payload;
    const snapshot = first.lifecycle.snapshot();
    first.lifecycle.dispose();

    const adopted = createHarness();
    adopted.lifecycle.initialize(snapshot);
    await adopted.lifecycle.handle(request, "retry-after-handoff");

    expect(snapshot?.successes).toHaveLength(1);
    expect(adopted.results).toEqual([{ payload: success, requestId: "retry-after-handoff" }]);
    expect(adopted.verify).not.toHaveBeenCalled();
  });

  it.each([
    { code: "account_mismatch", result: "relay_account_changed", retryable: false, closes: true },
    { code: "token_expired", result: "token_expired", retryable: true, closes: false },
    { code: "verification_unavailable", result: "verification_failed", retryable: true, closes: false },
    { code: "invalid_token", result: "invalid_proof", retryable: false, closes: false },
  ])("classifies production verifier $code failures", async ({ code, result, retryable, closes }) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const harness = createHarness({
      verify: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    await harness.lifecycle.handle(reauthorizePayload({
      privateKey: harness.keys.privateKey,
      lease: harness.lifecycle.metadata()!,
      token: "token-2",
    }), code);

    expect(harness.results.at(-1)?.payload).toMatchObject({
      ok: false,
      error: { code: result, retryable },
    });
    expect(harness.close).toHaveBeenCalledTimes(closes ? 1 : 0);
  });
});
