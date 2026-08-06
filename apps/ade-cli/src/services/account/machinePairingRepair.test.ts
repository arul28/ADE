import { describe, expect, it, vi } from "vitest";
import {
  createAccountMachinePublisherService,
  type AccountMachineRegistrationSnapshot,
} from "./accountMachinePublisherService";
import { repairMachinePairing } from "./machinePairingRepair";

function snapshot(): AccountMachineRegistrationSnapshot {
  return {
    role: "brain",
    runtimeRole: "host",
    runtimeName: "Studio",
    pairingConnectInfo: {
      hostIdentity: {
        deviceId: "device-studio",
        siteId: "site-studio",
        name: "Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      port: 8787,
      addressCandidates: [{ kind: "lan", host: "192.168.1.20" }],
    },
    routeHealth: {
      listener: {
        listenerBound: true,
        loopbackAdeValidated: true,
        port: 8787,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: "2026-07-16T00:00:00.000Z",
      },
      tailscale: {
        enabled: false,
        tailscalePublished: false,
        tailscaleReachable: false,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: null,
      },
      relay: {
        enabled: false,
        relayControlConnected: false,
        relayBridgeValidated: false,
        relayEndToEndVerifiedAt: null,
        relayEndToEndFailure: null,
        relayEndToEndRoundTripMs: null,
        lastFailureAt: null,
        skipReason: null,
        lastControlError: null,
        lastControlOpenAt: null,
        lastBridgeValidationAt: null,
      },
    },
  } as AccountMachineRegistrationSnapshot;
}

const REVOKED = () => new Response(
  JSON.stringify({ code: "machine_revoked", revokedAt: "2026-07-05T11:00:00.000Z" }),
  { status: 403, headers: { "content-type": "application/json" } },
);

/** "You were removed AND this attempt proved no fresh sign-in." Retryable. */
const NEEDS_FRESH_AUTH = () => new Response(
  JSON.stringify({
    code: "pairing_authentication_required",
    revokedAt: "2026-07-05T11:00:00.000Z",
  }),
  { status: 403, headers: { "content-type": "application/json" } },
);

type FetchImpl = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function makeDirectory(fetchImpl: FetchImpl) {
  return createAccountMachinePublisherService({
    getAccessToken: async () => "account-secret-token",
    getSnapshot: async () => snapshot(),
    getMachineKey: () => "machine-studio",
    directoryBaseUrl: () => "https://directory.example",
    fetchImpl,
  });
}

/** Stands in for the live push publisher: both halves in one object. */
function makePush(revoked: boolean) {
  const state = { revoked, revokedAt: revoked ? "2026-07-05T11:00:00.000Z" : null };
  return {
    state,
    getMachineRevocation: () => ({ ...state }),
    clearMachineRevocation: vi.fn(() => {
      state.revoked = false;
      state.revokedAt = null;
    }),
  };
}

describe("repairMachinePairing", () => {
  it("clears BOTH halves and resumes publishing when the directory accepts the re-pair", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => REVOKED());
    const directory = makeDirectory(fetchImpl);

    // The account owner removed this machine: the directory latches it and the
    // heartbeat stops.
    await directory.publishNow();
    expect(directory.getMachineRevocation().revoked).toBe(true);
    await directory.publishNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const push = makePush(true);
    fetchImpl.mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await repairMachinePairing({ directory, push });

    expect(result).toMatchObject({
      repaired: true,
      wasRevoked: true,
      published: true,
      pushRestored: true,
      reason: null,
    });
    // The one request that may clear a revocation is a deliberate pairing.
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).pairing).toBe(true);
    expect(directory.getMachineRevocation().revoked).toBe(false);
    expect(push.clearMachineRevocation).toHaveBeenCalledTimes(1);
    expect(push.state.revoked).toBe(false);

    // And the heartbeat that follows a repair is still just a heartbeat.
    await directory.publishNow();
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).pairing).toBeUndefined();
    directory.dispose();
  });

  it("leaves the push gate latched when the directory rejects the re-pair", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => REVOKED());
    const directory = makeDirectory(fetchImpl);
    await directory.publishNow();
    const push = makePush(true);

    // Still revoked account-side: un-gating delivery here would put the machine
    // back on the roster while the account does not include it.
    const result = await repairMachinePairing({ directory, push });

    expect(result).toMatchObject({
      repaired: false,
      wasRevoked: true,
      published: false,
      pushRestored: false,
    });
    expect(result.reason).toMatch(/removed from your ADE account|did not accept/i);
    expect(push.clearMachineRevocation).not.toHaveBeenCalled();
    expect(push.state.revoked).toBe(true);
    directory.dispose();
  });

  it("clears the durable flag through the store when no publisher is running", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const directory = makeDirectory(fetchImpl);
    let machineRevokedAt: string | null = "2026-07-05T11:00:00.000Z";
    const pushStore = {
      isMachineRevoked: () => machineRevokedAt != null,
      clearMachineRevoked: vi.fn(() => {
        machineRevokedAt = null;
      }),
    };

    const result = await repairMachinePairing({ directory, pushStore });

    expect(result).toMatchObject({ repaired: true, wasRevoked: true, pushRestored: true });
    expect(pushStore.clearMachineRevoked).toHaveBeenCalledTimes(1);
    expect(machineRevokedAt).toBeNull();
    directory.dispose();
  });

  it("does nothing, and sends no pairing registration, when nothing is gated and onlyIfRevoked is set", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const directory = makeDirectory(fetchImpl);
    const push = makePush(false);

    const result = await repairMachinePairing({ directory, push, onlyIfRevoked: true });

    expect(result).toMatchObject({
      repaired: false,
      wasRevoked: false,
      published: false,
      state: "not_revoked",
    });
    // Automatic sign-in recovery must not turn every login into a pairing.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(push.clearMachineRevocation).not.toHaveBeenCalled();
    directory.dispose();
  });

  it("reports an unavailable publisher instead of clearing the push half on its own", async () => {
    const push = makePush(true);

    const result = await repairMachinePairing({ directory: null, push });

    expect(result).toMatchObject({
      repaired: false,
      wasRevoked: true,
      published: false,
      pushRestored: false,
      state: "publisher_unavailable",
    });
    expect(push.clearMachineRevocation).not.toHaveBeenCalled();
  });

  it("forwards the directory's refusal code so callers never parse the sentence", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => NEEDS_FRESH_AUTH());
    const directory = makeDirectory(fetchImpl);
    await directory.publishNow();
    const push = makePush(true);
    const warn = vi.fn();

    const refused = await repairMachinePairing({ directory, push, logger: { warn } });

    // The two refusals are indistinguishable by `state`, and `reason` is copy
    // shown to a human. Only this code may drive a recovery decision.
    expect(refused).toMatchObject({
      repaired: false,
      published: false,
      state: "http_error",
      reasonCode: "pairing_authentication_required",
    });
    expect(refused.reason).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "account.machine_repair_failed",
      expect.objectContaining({ reasonCode: "pairing_authentication_required" }),
    );

    // Retryable, not a dead end: this refusal says "try again with fresh auth",
    // so the very next re-pair — the one the device-flow sign-in enables — must
    // still reach the directory and be able to succeed.
    fetchImpl.mockResolvedValue(new Response("{}", { status: 200 }));
    const retried = await repairMachinePairing({ directory, push });
    expect(retried).toMatchObject({
      repaired: true,
      wasRevoked: true,
      published: true,
      pushRestored: true,
    });
    expect(retried.reasonCode).toBeUndefined();
    expect(directory.getMachineRevocation().revoked).toBe(false);
    directory.dispose();
  });

  it("omits the refusal code whenever the brain has none, rather than inventing one", async () => {
    // Older brains predate the field entirely, and a refusal the brain does not
    // recognise carries no code — both must read as "unknown" at the caller, so
    // the field is absent rather than set to a placeholder.
    const bare403 = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    const directory = makeDirectory(bare403);
    const unknown = await repairMachinePairing({ directory, push: makePush(true) });
    expect(unknown.repaired).toBe(false);
    expect("reasonCode" in unknown).toBe(false);
    directory.dispose();

    // Purely local outcomes never carry a directory code either.
    const unavailable = await repairMachinePairing({ directory: null, push: makePush(true) });
    expect("reasonCode" in unavailable).toBe(false);

    const idle = makeDirectory(vi.fn(async () => new Response("{}", { status: 200 })));
    const notRevoked = await repairMachinePairing({
      directory: idle,
      push: makePush(false),
      onlyIfRevoked: true,
    });
    expect("reasonCode" in notRevoked).toBe(false);
    idle.dispose();
  });

  it("keeps an old brain's code-free refusal readable, exactly as it was", async () => {
    // Compatibility floor: a directory result with no `reasonCode` must still
    // produce the same repair result it always did, so an older brain talking
    // to a newer desktop degrades to the sentence rather than throwing.
    const directory = {
      getMachineRevocation: () => ({ revoked: true, revokedAt: "2026-07-05T11:00:00.000Z" }),
      publishPairing: async () => ({
        published: false,
        revoked: true,
        state: "http_error" as const,
        reason: "Sign in to your ADE account again on this computer to reconnect it.",
      }),
    };

    const result = await repairMachinePairing({ directory, push: makePush(true) });

    expect(result).toMatchObject({
      repaired: false,
      wasRevoked: true,
      published: false,
      state: "http_error",
      reason: "Sign in to your ADE account again on this computer to reconnect it.",
    });
    expect("reasonCode" in result).toBe(false);
  });
});
