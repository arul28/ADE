import { describe, expect, it } from "vitest";
import type { SyncDeviceRecord } from "../../../../desktop/src/shared/types";
import { buildAddressCandidates, buildPairingConnectInfo } from "./syncPairingConnectInfo";

function localDevice(overrides: Partial<SyncDeviceRecord> = {}): SyncDeviceRecord {
  return {
    deviceId: "device-studio",
    siteId: "site-studio",
    name: "Studio",
    platform: "macOS",
    deviceType: "desktop",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    lastSeenAt: null,
    lastHost: null,
    lastPort: 8787,
    tailscaleIp: null,
    ipAddresses: [],
    metadata: {},
    ...overrides,
  };
}

function remoteDevice(overrides: Partial<SyncDeviceRecord> = {}): SyncDeviceRecord {
  return localDevice({
    deviceId: "device-brain",
    siteId: "site-brain",
    name: "Brain",
    ...overrides,
  });
}

describe("buildAddressCandidates", () => {
  it("keeps a matching single-LAN last host canonical", () => {
    expect(buildAddressCandidates(localDevice({
      lastHost: "192.168.1.249",
      ipAddresses: ["192.168.1.249"],
    }), { isLocalDevice: true })).toEqual([
      { host: "192.168.1.249", kind: "lan" },
      { host: "127.0.0.1", kind: "loopback" },
    ]);
  });

  it("keeps a matching Tailscale last host canonical", () => {
    expect(buildAddressCandidates(localDevice({
      lastHost: "Studio.Tailnet.ts.net",
      tailscaleIp: "100.70.80.90",
      ipAddresses: ["192.168.1.249"],
      metadata: { tailscaleDnsName: "studio.tailnet.ts.net" },
    }), { isLocalDevice: true })).toEqual([
      { host: "studio.tailnet.ts.net", kind: "tailscale" },
      { host: "192.168.1.249", kind: "lan" },
      { host: "100.70.80.90", kind: "tailscale" },
      { host: "127.0.0.1", kind: "loopback" },
    ]);
  });

  it("uses saved only for a genuinely stale last host", () => {
    expect(buildAddressCandidates(localDevice({
      lastHost: "192.168.1.10",
      ipAddresses: ["192.168.1.249"],
    }), { isLocalDevice: true })).toEqual([
      { host: "192.168.1.249", kind: "lan" },
      { host: "192.168.1.10", kind: "saved" },
      { host: "127.0.0.1", kind: "loopback" },
    ]);
  });

  it("offers the local device loopback even when it has no other address", () => {
    expect(buildAddressCandidates(localDevice(), { isLocalDevice: true })).toEqual([
      { host: "127.0.0.1", kind: "loopback" },
    ]);
  });

  it("offers a remote device with no address no candidate, not this machine's loopback", () => {
    // A viewer that dialed the first candidate would reach its own listener
    // here, so an address-less remote brain must yield nothing to dial.
    expect(buildAddressCandidates(remoteDevice(), { isLocalDevice: false })).toEqual([]);
  });

  it("offers a remote device with only a stale saved host no loopback", () => {
    expect(buildAddressCandidates(remoteDevice({
      lastHost: "192.168.1.10",
    }), { isLocalDevice: false })).toEqual([
      { host: "192.168.1.10", kind: "saved" },
    ]);
  });

  it("drops a loopback host recorded for a remote device, such as a relay peer seen from 127.0.0.1", () => {
    expect(buildAddressCandidates(remoteDevice({
      lastHost: "127.0.0.1",
      ipAddresses: ["192.168.1.250"],
    }), { isLocalDevice: false })).toEqual([
      { host: "192.168.1.250", kind: "lan" },
    ]);
    expect(buildAddressCandidates(remoteDevice({
      lastHost: "::ffff:127.0.0.1",
    }), { isLocalDevice: false })).toEqual([]);
  });

  it("keeps a remote device's address order with no loopback entry", () => {
    expect(buildAddressCandidates(remoteDevice({
      lastHost: "Brain.Tailnet.ts.net",
      tailscaleIp: "100.70.80.91",
      ipAddresses: ["192.168.1.250"],
      metadata: { tailscaleDnsName: "brain.tailnet.ts.net" },
    }), { isLocalDevice: false })).toEqual([
      { host: "brain.tailnet.ts.net", kind: "tailscale" },
      { host: "192.168.1.250", kind: "lan" },
      { host: "100.70.80.91", kind: "tailscale" },
    ]);
  });
});

describe("buildPairingConnectInfo", () => {
  it("keeps loopback in the pairing payload for the local device", () => {
    expect(buildPairingConnectInfo({
      localDevice: localDevice({
        lastHost: "192.168.1.249",
        ipAddresses: ["192.168.1.249"],
      }),
    }).addressCandidates).toEqual([
      { host: "192.168.1.249", kind: "lan" },
      { host: "127.0.0.1", kind: "loopback" },
    ]);
  });
});
