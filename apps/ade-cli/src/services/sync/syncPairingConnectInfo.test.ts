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

describe("buildAddressCandidates", () => {
  it("keeps a matching single-LAN last host canonical", () => {
    expect(buildAddressCandidates(localDevice({
      lastHost: "192.168.1.249",
      ipAddresses: ["192.168.1.249"],
    }))).toEqual([
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
    }))).toEqual([
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
    }))).toEqual([
      { host: "192.168.1.249", kind: "lan" },
      { host: "192.168.1.10", kind: "saved" },
      { host: "127.0.0.1", kind: "loopback" },
    ]);
  });
});
