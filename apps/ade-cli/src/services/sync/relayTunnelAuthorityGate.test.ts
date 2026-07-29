import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TunnelHostListener } from "./syncTunnelClientService";
import {
  createRelayTunnelAuthorityGate,
  SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS,
} from "./relayTunnelAuthorityGate";

const listener = {
  getPort: () => 8787,
  getExpectedLoopbackNonce: () => "n".repeat(32),
  getRelayBridgeProof: () => "p".repeat(43),
  onLoopbackValidated: () => () => {},
} satisfies TunnelHostListener;

function createTunnel() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    attachHostListener: vi.fn(),
    clearControlSuppression: vi.fn(),
  };
}

function createLeaseHarness(initiallyHeld: boolean) {
  let held = initiallyHeld;
  const handlers = new Set<(next: boolean) => void>();
  return {
    holdsLease: () => held,
    subscribe: (handler: (next: boolean) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    set(next: boolean) {
      held = next;
      for (const handler of [...handlers]) handler(next);
    },
    subscriberCount: () => handlers.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRelayTunnelAuthorityGate", () => {
  it("does not dial the relay while another process holds the sync host lease", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(false);
    const info = vi.fn();

    const gate = createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
      logger: { info },
    });

    expect(gate.isRunning()).toBe(false);
    expect(tunnel.start).not.toHaveBeenCalled();
    // The whole failure mode was silent, so the decline has to be logged.
    expect(info).toHaveBeenCalledWith(
      "sync.tunnel_start_skipped",
      expect.objectContaining({ hasSyncListener: true, holdsSyncHostLease: false }),
    );
  });

  it("starts once the lease is acquired and clears eviction suppression first", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(false);

    const gate = createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });
    expect(tunnel.start).not.toHaveBeenCalled();

    lease.set(true);

    expect(gate.isRunning()).toBe(true);
    expect(tunnel.clearControlSuppression).toHaveBeenCalledTimes(1);
    expect(tunnel.start).toHaveBeenCalledTimes(1);
  });

  it("re-attaches the host listener on every start", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });
    expect(tunnel.attachHostListener).toHaveBeenLastCalledWith(listener);

    // stop() drops the listener reference, so a gate-driven restart that did
    // not re-attach would come back with a live control socket and no bridge —
    // every phone connect rejected with "host sync listener unavailable".
    lease.set(false);
    vi.advanceTimersByTime(SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS + 1);
    expect(tunnel.stop).toHaveBeenCalledTimes(1);

    lease.set(true);
    expect(tunnel.attachHostListener).toHaveBeenCalledTimes(2);
    expect(tunnel.attachHostListener).toHaveBeenLastCalledWith(listener);
    expect(tunnel.start).toHaveBeenCalledTimes(2);
  });

  it("does not re-arm eviction suppression for a gate built while the lease is already held", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    // Opening a second project constructs a second gate. Clearing suppression
    // there would reset the 4505 re-attempt budget and let the eviction war
    // restart on every project open.
    createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });

    expect(tunnel.start).toHaveBeenCalledTimes(1);
    expect(tunnel.clearControlSuppression).not.toHaveBeenCalled();
  });

  it("rides out the authority gap of an in-process sync host switch", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    const gate = createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });

    // performSyncHostSwitch deactivates the previous host before activating the
    // target, so authority blips false mid-switch. Tearing the machine's relay
    // down and back up on every project switch would be pure churn.
    lease.set(false);
    vi.advanceTimersByTime(SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS / 2);
    lease.set(true);
    vi.advanceTimersByTime(SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS * 2);

    expect(tunnel.stop).not.toHaveBeenCalled();
    expect(tunnel.start).toHaveBeenCalledTimes(1);
    expect(gate.isRunning()).toBe(true);
  });

  it("never dials without the shared sync listener, lease or not", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    const gate = createRelayTunnelAuthorityGate({
      hostListener: null,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });

    expect(gate.isRunning()).toBe(false);
    expect(tunnel.start).not.toHaveBeenCalled();
  });

  it("stops the tunnel when the lease stays lost past the grace", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);
    const info = vi.fn();

    const gate = createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
      logger: { info },
    });
    expect(gate.isRunning()).toBe(true);

    lease.set(false);
    expect(tunnel.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS + 1);

    expect(gate.isRunning()).toBe(false);
    expect(tunnel.stop).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "sync.tunnel_stopped_without_sync_host_lease",
      expect.any(Object),
    );
  });

  // stop() and start() are async, so a lease reacquired while a stop is still
  // in flight must not be torn down by that stop when it settles.
  it("keeps the tunnel running when the lease returns mid-stop", async () => {
    const tunnel = createTunnel();
    let releaseStop: (() => void) | undefined;
    tunnel.stop.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));
    const lease = createLeaseHarness(true);

    const gate = createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });

    lease.set(false);
    vi.advanceTimersByTime(SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS + 1);
    expect(tunnel.stop).toHaveBeenCalledTimes(1);

    // Lease comes back before the stop settles.
    lease.set(true);
    expect(gate.isRunning()).toBe(true);

    releaseStop?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.isRunning()).toBe(true);
    // The settling stop re-established the tunnel rather than leaving it down.
    expect(tunnel.start).toHaveBeenCalled();
    expect(tunnel.attachHostListener).toHaveBeenLastCalledWith(listener);
  });

  it("does not restart on repeated acquire notifications", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(false);

    createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });
    lease.set(true);
    lease.set(true);

    expect(tunnel.start).toHaveBeenCalledTimes(1);
  });

  it("detaches its subscription and pending timer on dispose without stopping the shared tunnel", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    const gate = createRelayTunnelAuthorityGate({
      hostListener: listener,
      tunnel,
      holdsLease: lease.holdsLease,
      subscribe: lease.subscribe,
    });
    lease.set(false);
    gate.dispose();
    vi.advanceTimersByTime(SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS * 3);

    expect(lease.subscriberCount()).toBe(0);
    // A disposed project scope must not sever relay for the scopes still open.
    expect(tunnel.stop).not.toHaveBeenCalled();
  });
});
