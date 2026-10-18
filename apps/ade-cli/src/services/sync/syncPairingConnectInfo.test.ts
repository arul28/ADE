import { describe, expect, it } from "vitest";
import type { SyncDeviceRecord } from "../../../../desktop/src/shared/types";
import { buildAddressCandidates } from "./syncPairingConnectInfo";

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
  return localDevice({ deviceId: "device-brain", siteId: "site-brain", name: "Brain", ...overrides });
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

  it.each([
    { case: "with no address", device: {}, offered: [] },
    { case: "last seen at 127.0.0.1", device: { lastHost: "127.0.0.1" }, offered: [] },
    { case: "last seen at ::ffff:127.0.0.1", device: { lastHost: "::ffff:127.0.0.1" }, offered: [] },
    { case: "last seen at 2130706433", device: { lastHost: "2130706433" }, offered: [] },
    { case: "last seen at 0x7f000001 beside a LAN address", device: { lastHost: "0x7f000001", ipAddresses: ["192.168.1.250"] }, offered: [{ host: "192.168.1.250", kind: "lan" }] },
  ])("never offers loopback to a remote device, $case", ({ device, offered }) => {
    // A viewer that dialed loopback would reach its own listener here.
    expect(buildAddressCandidates(remoteDevice(device), { isLocalDevice: false })).toEqual(offered);
  });
});
