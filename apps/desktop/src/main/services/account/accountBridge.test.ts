import { describe, expect, it, vi } from "vitest";
import {
  createAccountBridge,
  createBrainAccountActionCaller,
  describeAccountDeviceLoginFailure,
  describeMachinePairingRepairFailure,
  readAccountDeviceLoginProgress,
  readAccountDeviceLoginStart,
  readMachinePairingRepairResult,
  type BrainAccountActionCaller,
} from "./accountBridge";

// The bridge constructs the shared ade-cli account services at call time, so
// every one of them is stubbed at the module boundary. One stub serves the
// whole file: the device-login suite needs the richer shape, and the repair
// suite never exercises these beyond construction.
const startLogin = vi.fn();
vi.mock(
  "../../../../../ade-cli/src/services/account/sharedAccountAuthService",
  () => ({
    getSharedAccountAuthService: () => ({
      getStatus: () => ({
        signedIn: true,
        userId: "user_1",
        email: "ada@example.com",
        name: "Ada",
        expiresAt: null,
      }),
      getSessionReadState: () => "available",
      startLogin,
      pollLogin: vi.fn(),
      cancelLogin: vi.fn(),
      signOut: vi.fn(),
    }),
    registerAccountConfigProjectRoot: vi.fn(),
    resolveAccountOAuthConfig: () => ({ issuer: "https://clerk.test", clientId: "id" }),
    resolveOfficialAccountDirectoryBaseUrl: () => "https://directory.test",
  }),
);

vi.mock(
  "../../../../../ade-cli/src/services/account/accountMachineDirectoryService",
  () => ({ AccountMachineDirectoryService: class {} }),
);

vi.mock(
  "../../../../../ade-cli/src/services/projects/machineLayout",
  () => ({ resolveMachineAdeLayout: () => ({ secretsDir: "/tmp/ade-account-bridge-test" }) }),
);

const DEVICE_START = {
  domain: "account",
  action: "startDeviceLogin",
  result: {
    sessionId: "sess_1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://directory.test/device",
    verificationUriComplete: "https://directory.test/device?user_code=WDJB-MJHT",
    expiresAt: "2026-08-05T00:15:00.000Z",
    intervalSec: 5,
  },
  statusHints: {},
};

describe("accountBridge device sign-in", () => {
  /**
   * The load-bearing property of this whole path. The directory mints the
   * pairing grant on its `/device/*` flow, and the auth service that receives
   * it keeps it in memory for the publisher that shares its process. That
   * publisher runs in the brain — so a device flow driven by Electron main
   * would earn a grant nothing could ever spend.
   */
  it("runs the flow inside the brain, where the grant's only consumer lives", async () => {
    const callBrainAccountAction = vi.fn(async () => DEVICE_START);
    const bridge = createAccountBridge({
      getProjectRoot: () => "/repos/ade",
      callBrainAccountAction,
    });

    const start = await bridge.startDeviceLogin();

    expect(callBrainAccountAction).toHaveBeenCalledWith("startDeviceLogin", {
      projectRoot: "/repos/ade",
    });
    // The loopback flow is untouched: it is still the normal sign-in path.
    expect(startLogin).not.toHaveBeenCalled();
    expect(start.verificationUriComplete).toBe(
      "https://directory.test/device?user_code=WDJB-MJHT",
    );
  });

  it("re-derives the account status locally instead of trusting the RPC record", async () => {
    const bridge = createAccountBridge({
      getProjectRoot: () => null,
      // A poll payload with no authStatus at all — the brain persisted the
      // session to the machine credential store this process also reads.
      callBrainAccountAction: async () => ({ result: { status: "signed_in", message: null } }),
    });

    const poll = await bridge.pollDeviceLogin("sess_1");

    expect(poll.status).toBe("signed_in");
    expect(poll.authStatus).toMatchObject({
      signedIn: true,
      userId: "user_1",
      configured: true,
      sessionReadState: "available",
    });
  });

  it("reconciles locally paired machines once a device sign-in completes", async () => {
    const reconcileAccountOwnership = vi.fn(() => ({
      currentOwnerUserId: "user_1",
      removedTargetIds: [],
      removedCredentialHostIds: [],
      removedCredentials: [],
    }));
    const bridge = createAccountBridge({
      getProjectRoot: () => null,
      reconcileAccountOwnership,
      callBrainAccountAction: async () => ({ result: { status: "signed_in" } }),
    });

    await bridge.pollDeviceLogin("sess_1");

    expect(reconcileAccountOwnership).toHaveBeenCalledWith("user_1");
  });

  it("does not reconcile while the sign-in is still pending", async () => {
    const reconcileAccountOwnership = vi.fn();
    const bridge = createAccountBridge({
      getProjectRoot: () => null,
      reconcileAccountOwnership,
      callBrainAccountAction: async () => ({ result: { status: "pending", intervalSec: 7 } }),
    });

    const poll = await bridge.pollDeviceLogin("sess_1");

    expect(poll.status).toBe("pending");
    expect(poll.intervalSec).toBe(7);
    expect(reconcileAccountOwnership).not.toHaveBeenCalled();
  });

  it("explains a missing brain instead of starting a flow that cannot help", async () => {
    const bridge = createAccountBridge({ getProjectRoot: () => null });

    await expect(bridge.startDeviceLogin()).rejects.toThrow(
      /background service isn't running/i,
    );
  });

  it("keeps the raw RPC string out of the copy and on the cause", async () => {
    const raw = new Error("method account.call failed: connect ECONNREFUSED /tmp/ade.sock");
    const bridge = createAccountBridge({
      getProjectRoot: () => null,
      callBrainAccountAction: async () => {
        throw raw;
      },
    });

    await expect(bridge.startDeviceLogin()).rejects.toThrow(/background service isn't running/i);
    await expect(bridge.startDeviceLogin()).rejects.toMatchObject({ cause: raw });
  });

  it("cancels through the brain and never fails the caller for it", async () => {
    const callBrainAccountAction = vi.fn(async () => {
      throw new Error("session already gone");
    });
    const bridge = createAccountBridge({ getProjectRoot: () => null, callBrainAccountAction });

    await expect(bridge.cancelDeviceLogin("sess_1")).resolves.toBeUndefined();
    expect(callBrainAccountAction).toHaveBeenCalledWith("cancelLogin", { sessionId: "sess_1" });
  });
});

describe("readAccountDeviceLoginStart", () => {
  it("unwraps the account.call envelope", () => {
    expect(readAccountDeviceLoginStart(DEVICE_START).sessionId).toBe("sess_1");
  });

  it("throws rather than showing a card that names no code", () => {
    expect(() => readAccountDeviceLoginStart({ result: { sessionId: "s" } }))
      .toThrow(/couldn't start a sign-in/i);
    expect(() => readAccountDeviceLoginStart(null)).toThrow(/couldn't start a sign-in/i);
  });
});

describe("readAccountDeviceLoginProgress", () => {
  it("reads an unrecognised answer as an error, never as a sign-in", () => {
    expect(readAccountDeviceLoginProgress({ result: { status: "who knows" } }).status)
      .toBe("error");
    expect(readAccountDeviceLoginProgress(null).status).toBe("error");
  });

  it("passes the directory's backoff through", () => {
    expect(readAccountDeviceLoginProgress({ result: { status: "slow_down", intervalSec: 10 } }))
      .toEqual({ status: "slow_down", message: null, intervalSec: 10 });
  });
});

describe("describeAccountDeviceLoginFailure", () => {
  it("translates each failure class into an action the user can take", () => {
    expect(
      describeAccountDeviceLoginFailure(
        new Error("ADE_ACCOUNT_TOKEN is already providing account authentication"),
      ).message,
    ).toMatch(/signs in with ADE_ACCOUNT_TOKEN/);
    expect(describeAccountDeviceLoginFailure(new Error("ETIMEDOUT")).message)
      .toMatch(/timed out/i);
    expect(describeAccountDeviceLoginFailure(new Error("boom")).message)
      .toBe("ADE couldn't start a sign-in on this computer. Try again in a moment.");
  });
});

const BRAIN_SUCCESS = {
  domain: "account",
  action: "repairMachinePairing",
  result: {
    repaired: true,
    wasRevoked: true,
    published: true,
    pushRestored: true,
    state: "registered",
    reason: null,
  },
  statusHints: {},
};

describe("accountBridge.repairMachinePairing", () => {
  it("forwards to the brain, because only that process owns the live push gate", async () => {
    const callBrainAccountAction = vi.fn(async () => BRAIN_SUCCESS);
    const bridge = createAccountBridge({
      getProjectRoot: () => null,
      callBrainAccountAction,
    });

    const result = await bridge.repairMachinePairing();

    expect(callBrainAccountAction).toHaveBeenCalledWith("repairMachinePairing");
    expect(result.repaired).toBe(true);
    expect(result.pushRestored).toBe(true);
  });

  it("reports the brain's refusal as a result, not a throw", async () => {
    const bridge = createAccountBridge({
      getProjectRoot: () => null,
      callBrainAccountAction: async () => ({
        result: {
          repaired: false,
          wasRevoked: true,
          published: false,
          pushRestored: false,
          state: "directory_rejected",
          reason: "The account directory did not accept this machine.",
        },
      }),
    });

    const result = await bridge.repairMachinePairing();

    expect(result.repaired).toBe(false);
    expect(result.reason).toBe("The account directory did not accept this machine.");
  });

  it("surfaces a rejected brain call as legible copy and keeps the cause", async () => {
    const raw = new Error("method account.call failed: connect ECONNREFUSED /tmp/ade.sock");
    const bridge = createAccountBridge({
      getProjectRoot: () => null,
      callBrainAccountAction: async () => {
        throw raw;
      },
    });

    await expect(bridge.repairMachinePairing()).rejects.toThrow(
      /background service isn't running/i,
    );
    // The raw RPC string never reaches the user, but the logs keep it.
    await expect(bridge.repairMachinePairing()).rejects.toMatchObject({ cause: raw });
  });

  it("explains a missing brain instead of pretending the machine was repaired", async () => {
    const bridge = createAccountBridge({ getProjectRoot: () => null });

    await expect(bridge.repairMachinePairing()).rejects.toThrow(
      /background service isn't running/i,
    );
  });
});

describe("createBrainAccountActionCaller", () => {
  it("calls the brain's account.call with a bounded budget", async () => {
    const callSync = vi.fn(async () => BRAIN_SUCCESS);
    const call = createBrainAccountActionCaller(
      { callSync } as unknown as BrainAccountActionCaller,
      30_000,
    );

    await call?.("repairMachinePairing");

    expect(callSync).toHaveBeenCalledWith(
      "account.call",
      { action: "repairMachinePairing" },
      { timeoutMs: 30_000 },
    );
  });

  it("is absent without a runtime pool, so the bridge explains instead of crashing", () => {
    expect(createBrainAccountActionCaller(null, 30_000)).toBeUndefined();
  });

  it("lets a brain rejection through for the bridge to translate", async () => {
    const call = createBrainAccountActionCaller(
      {
        callSync: async () => {
          throw new Error("Remote ADE service timed out waiting for method account.call (30000ms).");
        },
      },
      30_000,
    );

    await expect(call?.("repairMachinePairing")).rejects.toThrow(/timed out/);
  });
});

describe("readMachinePairingRepairResult", () => {
  it("unwraps the account.call envelope and normalizes partial payloads", () => {
    expect(
      readMachinePairingRepairResult({
        result: { repaired: true, published: true, state: "  registered  " },
      }),
    ).toEqual({
      repaired: true,
      wasRevoked: false,
      published: true,
      pushRestored: false,
      state: "registered",
      reason: null,
      // Absent on the wire reads as "unknown", never as a negative answer —
      // which is exactly what a brain older than `reasonCode` sends.
      reasonCode: null,
    });
  });

  it("carries the brain's refusal code through, including ones it predates", () => {
    expect(
      readMachinePairingRepairResult({
        result: {
          repaired: false,
          state: "http_error",
          reason: "Sign in to your ADE account again on this computer to reconnect it.",
          reasonCode: " pairing_authentication_required ",
        },
      }).reasonCode,
    ).toBe("pairing_authentication_required");
    // Not filtered against a known-code list: a newer brain's vocabulary stays
    // visible instead of vanishing at the boundary, and the renderer fails
    // closed on anything it does not recognise.
    expect(
      readMachinePairingRepairResult({
        repaired: false,
        state: "http_error",
        reasonCode: "some_future_refusal",
      }).reasonCode,
    ).toBe("some_future_refusal");
    // Junk is normalized to "unknown", not passed off as a code.
    expect(
      readMachinePairingRepairResult({ repaired: false, reasonCode: "   " }).reasonCode,
    ).toBeNull();
    expect(
      readMachinePairingRepairResult({ repaired: false, reasonCode: 7 }).reasonCode,
    ).toBeNull();
  });

  it("throws on an unreadable payload rather than reporting a false failure", () => {
    // A fabricated `repaired: false` would send the user to re-run a repair
    // that already worked, and would erode what `repaired: false` means.
    expect(() => readMachinePairingRepairResult({ ok: true })).toThrow(/couldn't read the result/i);
    expect(() => readMachinePairingRepairResult(null)).toThrow(/couldn't read the result/i);
  });
});

describe("describeMachinePairingRepairFailure", () => {
  it("translates each failure class into an action the user can take", () => {
    expect(
      describeMachinePairingRepairFailure(
        new Error("This ADE brain is not publishing this machine to your account yet."),
      ).message,
    ).toMatch(/Open a project on this computer/);
    expect(describeMachinePairingRepairFailure(new Error("ETIMEDOUT")).message)
      .toMatch(/timed out/i);
    expect(describeMachinePairingRepairFailure(new Error("HTTP 401 unauthorized")).message)
      .toMatch(/Sign in to ADE again/);
    expect(describeMachinePairingRepairFailure(new Error("boom")).message)
      .toBe("ADE couldn't reconnect this computer to your account. Try again in a moment.");
  });
});
