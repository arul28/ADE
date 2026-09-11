import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  applyProjectHostHello,
  bindProjectHostRecoverySend,
  configureProjectHostRecoveryStoreForTests,
  getProjectHostRecoveryState,
  noteProjectHostDisconnected,
  noteProjectHostUnavailable,
  recoverProjectHost,
  releaseProjectHostRecoveryClient,
  resetProjectHostRecoveryStore,
  retryProjectHost,
} from "./projectHostRecoveryStore";
import { SYNC_HOST_RECOVER_ACTION } from "../../../shared/types/syncHostRecovery";

/** Stand-ins for the two sync clients a browser can hold at once. */
const activeClient = { name: "active-machine" };
const otherClient = { name: "background-machine" };

const conflictSnapshot = {
  state: "conflict" as const,
  headline: "Another ADE is blocking this machine",
  body: "A development runtime is using the connection your phone needs.",
  recoveryEligible: true,
  conflict: {
    reason: "listener" as const,
    ownerKind: "development" as const,
    ownerLabel: "Development runtime",
    projectLabel: "improving-browser lane",
    impact: "May interrupt improving-browser lane.",
    recoveryEligible: true,
    technicalDetail: "pid: 4242",
  },
};

const readySnapshot = {
  state: "ready" as const,
  headline: "Connected",
  body: "This machine's project connection is ready.",
  conflict: null,
  recoveryEligible: false,
};

describe("projectHostRecoveryStore", () => {
  beforeEach(() => {
    resetProjectHostRecoveryStore();
    bindProjectHostRecoverySend(async () => null, activeClient);
  });
  afterEach(() => {
    resetProjectHostRecoveryStore();
  });

  it("takes over immediately on a verified conflict", () => {
    applyProjectHostHello(conflictSnapshot, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("takeover");
    expect(getProjectHostRecoveryState().snapshot?.conflict?.ownerLabel).toBe("Development runtime");
  });

  // A repair whose restart never reports back must not leave the card an inert
  // spinner: an explicit Retry ends the "repair running" assumption.
  it("lets an explicit retry escape a repair that never reports back", async () => {
    const conflictSnapshot = {
      state: "conflict",
      headline: "Another ADE is blocking this machine",
      body: "Another ADE runtime is using the connection your phone needs.",
      recoveryEligible: false,
      conflict: {
        reason: "lock",
        ownerKind: "unknown",
        ownerLabel: "Another ADE runtime",
        projectLabel: null,
        impact: null,
        recoveryEligible: false,
        technicalDetail: "",
      },
    };
    bindProjectHostRecoverySend(async (action) => (
      action === SYNC_HOST_RECOVER_ACTION
        ? {
          operationId: "op-1",
          ok: false,
          status: "restarting",
          snapshot: conflictSnapshot,
          steps: [],
          message: "Restarting this machine's ADE brain.",
        }
        : conflictSnapshot
    ), activeClient);

    await recoverProjectHost();
    expect(getProjectHostRecoveryState().phase).toBe("recovering");

    await retryProjectHost();
    expect(getProjectHostRecoveryState().phase).toBe("takeover");
  });

  it("retries a generic starting failure then takes over", async () => {
    const sleep = vi.fn(async () => undefined);
    configureProjectHostRecoveryStoreForTests({ sleep });
    bindProjectHostRecoverySend(async () => ({
      state: "starting",
      headline: "Starting services",
      body: "This machine is starting its project connection.",
      conflict: null,
      recoveryEligible: false,
    }), activeClient);
    noteProjectHostUnavailable({
      code: "host_unavailable",
      message: "This machine is starting its project connection.",
      details: {
        code: "host_unavailable",
        reason: "starting",
        snapshot: {
          state: "starting",
          headline: "Starting services",
          body: "This machine is starting its project connection.",
          conflict: null,
          recoveryEligible: false,
        },
      },
    }, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("retrying");
    await Promise.resolve();
    await Promise.resolve();
    expect(sleep).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(getProjectHostRecoveryState().phase).toBe("takeover");
    });
  });

  // The transition the phone hits first: the host reports "starting", then the
  // next command fails with a verified conflict that carries `details.conflict`
  // and no `details.snapshot`. Falling back to the held starting snapshot there
  // lost the owner label and, with it, Fix connection.
  it("takes the conflict from an error that carries no snapshot", () => {
    configureProjectHostRecoveryStoreForTests({ sleep: () => new Promise<void>(() => {}) });
    applyProjectHostHello({
      state: "starting",
      headline: "Starting services",
      body: "This machine is starting its project connection.",
      conflict: null,
      recoveryEligible: false,
    }, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("retrying");

    noteProjectHostUnavailable({
      code: "host_unavailable",
      message: "A development runtime is using the connection your phone needs.",
      details: {
        code: "host_unavailable",
        reason: "conflict",
        recoveryEligible: true,
        conflict: conflictSnapshot.conflict,
      },
    }, activeClient);

    const state = getProjectHostRecoveryState();
    expect(state.phase).toBe("takeover");
    expect(state.snapshot?.state).toBe("conflict");
    expect(state.snapshot?.conflict?.ownerLabel).toBe("Development runtime");
    expect(state.snapshot?.recoveryEligible).toBe(true);
  });

  it("Fix connection records a recovery result", async () => {
    applyProjectHostHello(conflictSnapshot, activeClient);
    bindProjectHostRecoverySend(async () => ({
      operationId: "op-1",
      ok: true,
      status: "succeeded",
      snapshot: {
        state: "ready",
        headline: "Connected",
        body: "This machine's project connection is ready.",
        conflict: null,
        recoveryEligible: false,
      },
      steps: [{ id: "stop", status: "done" }],
      message: "Project connection is ready.",
    }), activeClient);
    await recoverProjectHost();
    expect(getProjectHostRecoveryState().phase).toBe("ready");
  });

  it("keeps its transport across a disconnect and reconnect", async () => {
    const send = vi.fn(async () => ({
      operationId: "op-1",
      ok: true,
      status: "succeeded",
      snapshot: readySnapshot,
      steps: [{ id: "stop", status: "done" }],
      message: "Project connection is ready.",
    }));
    bindProjectHostRecoverySend(send, activeClient);
    applyProjectHostHello(conflictSnapshot, activeClient);

    // The repair restarts the brain, so the socket drops and comes back before
    // anyone can press anything.
    noteProjectHostDisconnected(activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("ready");
    applyProjectHostHello(conflictSnapshot, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("takeover");

    await recoverProjectHost();
    expect(send).toHaveBeenCalledWith("sync.recoverHost", {});
    expect(getProjectHostRecoveryState().phase).toBe("ready");
  });

  it("holds the progress screen when a restart drops the socket", async () => {
    configureProjectHostRecoveryStoreForTests({ sleep: () => new Promise<void>(() => {}) });
    applyProjectHostHello(conflictSnapshot, activeClient);
    bindProjectHostRecoverySend(async () => ({
      operationId: "op-2",
      ok: false,
      status: "restarting",
      snapshot: {
        state: "starting",
        headline: "Starting this machine",
        body: "This machine is still starting its project connection.",
        conflict: null,
        recoveryEligible: true,
      },
      steps: [{ id: "stop", status: "done" }, { id: "restart", status: "active" }],
      message: "Restarting this machine.",
    }), activeClient);

    await recoverProjectHost();
    expect(getProjectHostRecoveryState().phase).toBe("recovering");

    noteProjectHostDisconnected(activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("recovering");

    // Reconnecting to a host that is still starting is the restart, not a
    // failure: keep waiting until it reports ready.
    applyProjectHostHello({
      state: "starting",
      headline: "Starting this machine",
      body: "This machine is still starting its project connection.",
      conflict: null,
      recoveryEligible: true,
    }, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("recovering");

    applyProjectHostHello(readySnapshot, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("ready");
  });

  it("keeps recovering when the recover command dies with the socket", async () => {
    applyProjectHostHello(conflictSnapshot, activeClient);
    bindProjectHostRecoverySend(async () => {
      throw Object.assign(new Error("Connection lost — outcome unknown."), {
        code: "connection_lost_outcome_unknown",
      });
    }, activeClient);
    await recoverProjectHost();
    expect(getProjectHostRecoveryState().phase).toBe("recovering");
  });

  it("starts silent retries again after a canceled retry task", async () => {
    const sleeps: Array<() => void> = [];
    configureProjectHostRecoveryStoreForTests({
      sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
    });
    bindProjectHostRecoverySend(async () => ({
      state: "starting",
      headline: "Starting services",
      body: "This machine is starting its project connection.",
      conflict: null,
      recoveryEligible: false,
    }), activeClient);

    noteProjectHostUnavailable({
      code: "host_unavailable",
      message: "This machine is starting its project connection.",
      details: {
        code: "host_unavailable",
        reason: "starting",
        snapshot: {
          state: "starting",
          headline: "Starting services",
          body: "This machine is starting its project connection.",
          conflict: null,
          recoveryEligible: false,
        },
      },
    }, activeClient);
    await Promise.resolve();
    expect(sleeps).toHaveLength(1);

    applyProjectHostHello(conflictSnapshot, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("takeover");
    sleeps[0]?.();
    await Promise.resolve();

    applyProjectHostHello({
      state: "ready",
      headline: "Connected",
      body: "This machine's project connection is ready.",
      conflict: null,
      recoveryEligible: false,
    }, activeClient);
    applyProjectHostHello({
      state: "starting",
      headline: "Starting services",
      body: "This machine is starting its project connection.",
      conflict: null,
      recoveryEligible: false,
    }, activeClient);
    await Promise.resolve();
    expect(sleeps).toHaveLength(2);
  });

  it("ignores a hello from a client that is not the active machine", () => {
    applyProjectHostHello(conflictSnapshot, otherClient);
    expect(getProjectHostRecoveryState().phase).toBe("ready");
    expect(getProjectHostRecoveryState().snapshot).toBeNull();

    applyProjectHostHello(conflictSnapshot, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("takeover");
  });

  it("ignores a host_unavailable failure from a background client", () => {
    const hostUnavailable = {
      code: "host_unavailable",
      message: "This machine is starting its project connection.",
      details: {
        code: "host_unavailable",
        reason: "starting",
        snapshot: {
          state: "starting",
          headline: "Starting services",
          body: "This machine is starting its project connection.",
          conflict: null,
          recoveryEligible: false,
        },
      },
    };
    configureProjectHostRecoveryStoreForTests({ sleep: () => new Promise<void>(() => {}) });

    noteProjectHostUnavailable(hostUnavailable, otherClient);
    expect(getProjectHostRecoveryState().phase).toBe("ready");

    noteProjectHostUnavailable(hostUnavailable, activeClient);
    expect(getProjectHostRecoveryState().phase).toBe("retrying");
  });

  it("keeps a disconnect from a background client off the active screen", () => {
    applyProjectHostHello(conflictSnapshot, activeClient);
    noteProjectHostDisconnected(otherClient);
    expect(getProjectHostRecoveryState().phase).toBe("takeover");
  });

  it("does not disarm the active binding when a background client disposes", async () => {
    const send = vi.fn(async () => ({
      operationId: "op-1",
      ok: true,
      status: "succeeded",
      snapshot: readySnapshot,
      steps: [{ id: "stop", status: "done" }],
      message: "Project connection is ready.",
    }));
    bindProjectHostRecoverySend(send, activeClient);
    applyProjectHostHello(conflictSnapshot, activeClient);

    releaseProjectHostRecoveryClient(otherClient);
    expect(getProjectHostRecoveryState().phase).toBe("takeover");

    await recoverProjectHost();
    expect(send).toHaveBeenCalledWith("sync.recoverHost", {});
    expect(getProjectHostRecoveryState().phase).toBe("ready");
  });

  it("dispatches the repair over the active client, not the last one bound", async () => {
    const activeSend = vi.fn(async () => ({
      operationId: "op-active",
      ok: true,
      status: "succeeded",
      snapshot: readySnapshot,
      steps: [{ id: "stop", status: "done" }],
      message: "Project connection is ready.",
    }));
    const otherSend = vi.fn(async () => ({
      operationId: "op-other",
      ok: true,
      status: "succeeded",
      snapshot: readySnapshot,
      steps: [{ id: "stop", status: "done" }],
      message: "Project connection is ready.",
    }));
    // A second machine connects in the background, then the user switches back.
    bindProjectHostRecoverySend(otherSend, otherClient);
    bindProjectHostRecoverySend(activeSend, activeClient);
    applyProjectHostHello(conflictSnapshot, activeClient);

    await recoverProjectHost();

    expect(activeSend).toHaveBeenCalledWith("sync.recoverHost", {});
    expect(otherSend).not.toHaveBeenCalled();
  });

  it("cannot send once no session is active", async () => {
    const send = vi.fn(async () => ({
      operationId: "op-1",
      ok: true,
      status: "succeeded",
      snapshot: readySnapshot,
      steps: [{ id: "stop", status: "done" }],
      message: "Project connection is ready.",
    }));
    bindProjectHostRecoverySend(send, activeClient);
    applyProjectHostHello(conflictSnapshot, activeClient);

    // Parking the last live session leaves no machine to act on.
    bindProjectHostRecoverySend(null, null);
    expect(getProjectHostRecoveryState().phase).toBe("ready");

    await recoverProjectHost();
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels a silent retry when the host becomes ready", async () => {
    const sleeps: Array<() => void> = [];
    configureProjectHostRecoveryStoreForTests({
      sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
    });
    bindProjectHostRecoverySend(async () => ({
      state: "starting",
      headline: "Starting services",
      body: "This machine is starting its project connection.",
      conflict: null,
      recoveryEligible: false,
    }), activeClient);

    noteProjectHostUnavailable({
      code: "host_unavailable",
      reason: "starting",
      snapshot: {
        state: "starting",
        headline: "Starting services",
        body: "This machine is starting its project connection.",
        conflict: null,
        recoveryEligible: false,
      },
    }, activeClient);
    await Promise.resolve();
    expect(sleeps).toHaveLength(1);

    applyProjectHostHello({
      state: "ready",
      headline: "Connected",
      body: "This machine's project connection is ready.",
      conflict: null,
      recoveryEligible: false,
    }, activeClient);
    applyProjectHostHello({
      state: "starting",
      headline: "Starting services",
      body: "This machine is starting its project connection.",
      conflict: null,
      recoveryEligible: false,
    }, activeClient);
    await Promise.resolve();
    expect(sleeps).toHaveLength(2);
  });
});
