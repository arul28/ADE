import { describe, expect, it, vi } from "vitest";
import { createRelayTunnelAuthorityGate } from "./relayTunnelAuthorityGate";

function createTunnel() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
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

describe("createRelayTunnelAuthorityGate", () => {
  it("does not dial the relay while another process holds the sync host lease", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(false);
    const info = vi.fn();

    const gate = createRelayTunnelAuthorityGate(
      { hasSyncListener: true, tunnel, logger: { info } },
      { holdsLease: lease.holdsLease, subscribe: lease.subscribe },
    );

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

    const gate = createRelayTunnelAuthorityGate(
      { hasSyncListener: true, tunnel },
      { holdsLease: lease.holdsLease, subscribe: lease.subscribe },
    );
    expect(tunnel.start).not.toHaveBeenCalled();

    lease.set(true);

    expect(gate.isRunning()).toBe(true);
    expect(tunnel.clearControlSuppression).toHaveBeenCalledTimes(1);
    expect(tunnel.start).toHaveBeenCalledTimes(1);
  });

  it("starts immediately when the lease is already held", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    const gate = createRelayTunnelAuthorityGate(
      { hasSyncListener: true, tunnel },
      { holdsLease: lease.holdsLease, subscribe: lease.subscribe },
    );

    expect(gate.isRunning()).toBe(true);
    expect(tunnel.start).toHaveBeenCalledTimes(1);
  });

  it("never dials without the shared sync listener, lease or not", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    const gate = createRelayTunnelAuthorityGate(
      { hasSyncListener: false, tunnel },
      { holdsLease: lease.holdsLease, subscribe: lease.subscribe },
    );

    expect(gate.isRunning()).toBe(false);
    expect(tunnel.start).not.toHaveBeenCalled();
  });

  it("stops the tunnel when the lease is lost", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);
    const info = vi.fn();

    const gate = createRelayTunnelAuthorityGate(
      { hasSyncListener: true, tunnel, logger: { info } },
      { holdsLease: lease.holdsLease, subscribe: lease.subscribe },
    );
    expect(gate.isRunning()).toBe(true);

    lease.set(false);

    expect(gate.isRunning()).toBe(false);
    expect(tunnel.stop).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "sync.tunnel_stopped_without_sync_host_lease",
      expect.any(Object),
    );
  });

  it("does not restart on repeated acquire notifications", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(false);

    createRelayTunnelAuthorityGate(
      { hasSyncListener: true, tunnel },
      { holdsLease: lease.holdsLease, subscribe: lease.subscribe },
    );
    lease.set(true);
    lease.set(true);

    expect(tunnel.start).toHaveBeenCalledTimes(1);
  });

  it("detaches its subscription on dispose without stopping the shared tunnel", () => {
    const tunnel = createTunnel();
    const lease = createLeaseHarness(true);

    const gate = createRelayTunnelAuthorityGate(
      { hasSyncListener: true, tunnel },
      { holdsLease: lease.holdsLease, subscribe: lease.subscribe },
    );
    gate.dispose();

    expect(lease.subscriberCount()).toBe(0);
    // A disposed project scope must not sever relay for the scopes still open.
    expect(tunnel.stop).not.toHaveBeenCalled();

    lease.set(false);
    expect(tunnel.stop).not.toHaveBeenCalled();
  });
});
