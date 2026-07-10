import { describe, expect, it } from "vitest";
import {
  discoveredRuntimeFromBonjourService,
  discoveredRuntimesFromTailscaleStatus,
  dropSelfDiscoveredMachines,
  mergeCrossSourceDiscoveredMachines,
} from "./runtimeDiscovery";
import type { RemoteRuntimeDiscoveredMachine } from "../../../shared/types/remoteRuntime";

function bonjourMachine(
  overrides: Partial<RemoteRuntimeDiscoveredMachine> = {},
): RemoteRuntimeDiscoveredMachine {
  return {
    id: "device-123::ADE Sync Studio._ade-sync._tcp.local",
    serviceName: "ADE Sync Studio",
    machineName: "Studio",
    hostIdentity: "device-123",
    hostName: "studio.local",
    port: 8787,
    addresses: ["192.168.1.42", "100.64.0.10"],
    primaryRoute: "192.168.1.42",
    tailscaleAddress: "100.64.0.10",
    runtimeKind: "daemon",
    runtimeVersion: "1.0.0",
    connectable: true,
    projectIds: ["p1"],
    projectCount: 1,
    lastSeenAt: 1,
    ...overrides,
  };
}

function tailscalePeerMachine(
  overrides: Partial<RemoteRuntimeDiscoveredMachine> = {},
): RemoteRuntimeDiscoveredMachine {
  return {
    id: "tailscale:peer-1",
    serviceName: "Tailscale peer",
    machineName: "studio",
    hostIdentity: "peer-1",
    hostName: "studio",
    port: 22,
    addresses: ["100.64.0.10", "studio.tail000000.ts.net"],
    primaryRoute: "100.64.0.10",
    tailscaleAddress: "100.64.0.10",
    runtimeKind: "tailscale-peer",
    runtimeVersion: null,
    os: "macOS",
    connectable: true,
    projectIds: [],
    projectCount: null,
    lastSeenAt: 1,
    ...overrides,
  };
}

describe("runtimeDiscovery", () => {
  it("parses ADE sync Bonjour metadata into a discovered machine", () => {
    const discovered = discoveredRuntimeFromBonjourService(
      {
        name: "ADE Sync Studio 8787",
        fqdn: "ADE Sync Studio 8787._ade-sync._tcp.local",
        host: "studio.local",
        port: 8787,
        addresses: ["127.0.0.1", "192.168.1.42"],
        txt: {
          deviceId: "device-123",
          deviceName: "Studio",
          runtimeKind: "daemon",
          runtimeVersion: "0.0.0",
          platform: "macOS",
          projects: "project-a, project-b",
          projectCount: "2",
          host: "192.168.1.42",
          addresses: "127.0.0.1,100.64.0.10",
          tailscaleDnsName: "studio.tail000000.ts.net",
          tailscaleIp: "100.64.0.10",
        },
      },
      1234,
    );

    expect(discovered).toMatchObject({
      id: "device-123::ADE Sync Studio 8787._ade-sync._tcp.local",
      serviceName: "ADE Sync Studio 8787",
      machineName: "Studio",
      hostIdentity: "device-123",
      hostName: "studio.local",
      port: 8787,
      addresses: ["192.168.1.42", "100.64.0.10", "127.0.0.1"],
      primaryRoute: "192.168.1.42",
      tailscaleAddress: "100.64.0.10",
      runtimeKind: "daemon",
      runtimeVersion: "0.0.0",
      os: "macOS",
      connectable: true,
      projectIds: ["project-a", "project-b"],
      projectCount: 2,
      lastSeenAt: 1234,
    });
  });

  it("falls back to service metadata when TXT identity is partial", () => {
    const discovered = discoveredRuntimeFromBonjourService(
      {
        name: "ADE Sync Laptop 8787",
        host: "laptop.local",
        port: 0,
        addresses: ["127.0.0.1"],
        txt: {
          port: "8787",
          runtimeKind: "",
        },
      },
      5678,
    );

    expect(discovered).toMatchObject({
      id: "ADE Sync Laptop 8787@laptop.local:8787",
      machineName: "laptop.local",
      hostIdentity: null,
      hostName: "laptop.local",
      port: 8787,
      addresses: ["127.0.0.1"],
      primaryRoute: "laptop.local",
      runtimeKind: null,
      runtimeVersion: null,
      projectIds: [],
      projectCount: null,
      lastSeenAt: 5678,
    });
  });

  it("keeps Windows Bonjour hosts visible but marks them unsupported", () => {
    const discovered = discoveredRuntimeFromBonjourService({
      name: "ADE Sync Build PC",
      host: "build-pc.local",
      port: 8787,
      addresses: ["192.168.1.50"],
      txt: {
        deviceId: "windows-host",
        deviceName: "Build PC",
        platform: "windows",
      },
    });

    expect(discovered).toMatchObject({
      machineName: "Build PC",
      os: "windows",
      connectable: false,
      unsupportedReason: "Windows machines can't run the ADE remote runtime yet.",
    });
  });

  it("turns Tailscale peers into SSH discovery targets", () => {
    const discovered = discoveredRuntimesFromTailscaleStatus(
      {
        Peer: {
          "nodekey:abc": {
            ID: "peer-1",
            HostName: "build-studio",
            DNSName: "build-studio.tail000000.ts.net.",
            OS: "macOS",
            TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::1"],
            Online: true,
          },
        },
      },
      9012,
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      id: "tailscale:peer-1",
      serviceName: "Tailscale peer",
      machineName: "build-studio",
      hostIdentity: "peer-1",
      hostName: "build-studio",
      port: 22,
      addresses: ["100.64.0.10", "build-studio.tail000000.ts.net"],
      primaryRoute: "100.64.0.10",
      tailscaleAddress: "100.64.0.10",
      runtimeKind: "tailscale-peer",
      runtimeVersion: null,
      os: "macOS",
      connectable: true,
      projectIds: [],
      projectCount: null,
      lastSeenAt: 9012,
    });
  });

  it("skips mobile Tailscale peers in the SSH discovery list", () => {
    const discovered = discoveredRuntimesFromTailscaleStatus(
      {
        Peer: {
          "nodekey:iphone": {
            ID: "peer-phone",
            HostName: "iPhone",
            DNSName: "iphone.tail000000.ts.net.",
            OS: "iOS",
            TailscaleIPs: ["100.64.0.11"],
            Online: true,
          },
          "nodekey:mac": {
            ID: "peer-mac",
            HostName: "studio",
            DNSName: "studio.tail000000.ts.net.",
            OS: "macOS",
            TailscaleIPs: ["100.64.0.10"],
            Online: true,
          },
        },
      },
      123,
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.machineName).toBe("studio");
  });

  it("keeps Windows peers visible but marks them unsupported", () => {
    const discovered = discoveredRuntimesFromTailscaleStatus({
      Peer: {
        "nodekey:windows": {
          ID: "peer-windows",
          HostName: "build-pc",
          DNSName: "build-pc.tail000000.ts.net.",
          OS: "windows",
          TailscaleIPs: ["100.64.0.12"],
          Online: true,
        },
      },
    }, 456);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      machineName: "build-pc",
      os: "windows",
      connectable: false,
      unsupportedReason: "Windows machines can't run the ADE remote runtime yet.",
    });
  });

  it("drops this machine's own Bonjour advertisement by local sync device id", () => {
    const machines = [
      bonjourMachine({ id: "self::svc", hostIdentity: "self-device" }),
      bonjourMachine({ id: "other::svc", hostIdentity: "other-device", machineName: "Other" }),
      tailscalePeerMachine({ hostIdentity: "peer-1" }),
    ];

    const filtered = dropSelfDiscoveredMachines(machines, "self-device");

    // The self Bonjour row is gone; the Tailscale peer (id space never carries
    // our own device id) and the other machine survive.
    expect(filtered.map((machine) => machine.id)).toEqual([
      "other::svc",
      "tailscale:peer-1",
    ]);
  });

  it("leaves discovery untouched when the local device id is unknown", () => {
    const machines = [bonjourMachine()];
    expect(dropSelfDiscoveredMachines(machines, null)).toBe(machines);
    expect(dropSelfDiscoveredMachines(machines, "  ")).toBe(machines);
  });

  it("merges a Tailscale peer into the Bonjour machine that shares its address", () => {
    const merged = mergeCrossSourceDiscoveredMachines([
      bonjourMachine({ os: undefined, addresses: ["192.168.1.42", "100.64.0.10"] }),
      tailscalePeerMachine({
        addresses: ["100.64.0.10", "studio.tail000000.ts.net"],
      }),
    ]);

    expect(merged).toHaveLength(1);
    const machine = merged[0]!;
    // Keeps the richer Bonjour identity...
    expect(machine.id).toBe("device-123::ADE Sync Studio._ade-sync._tcp.local");
    expect(machine.runtimeKind).toBe("daemon");
    // ...and gains the Tailscale route + reported OS.
    expect(machine.addresses).toContain("studio.tail000000.ts.net");
    expect(machine.tailscaleAddress).toBe("100.64.0.10");
    expect(machine.os).toBe("macOS");
  });

  it("keeps a Tailscale-only peer that matches no Bonjour machine", () => {
    const merged = mergeCrossSourceDiscoveredMachines([
      bonjourMachine({
        addresses: ["192.168.1.42"],
        tailscaleAddress: null,
      }),
      tailscalePeerMachine({
        id: "tailscale:peer-solo",
        machineName: "Laptop",
        addresses: ["100.99.0.5", "laptop.tail000000.ts.net"],
        tailscaleAddress: "100.99.0.5",
      }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((machine) => machine.id)).toContain("tailscale:peer-solo");
  });

  it("marks offline Tailscale peers as unavailable", () => {
    const discovered = discoveredRuntimesFromTailscaleStatus({
      Peer: {
        "nodekey:offline": {
          ID: "peer-offline",
          HostName: "sleeping-mac",
          DNSName: "sleeping-mac.tail000000.ts.net.",
          OS: "macOS",
          TailscaleIPs: ["100.64.0.13"],
          Online: false,
        },
      },
    });

    expect(discovered[0]).toMatchObject({
      runtimeKind: "tailscale-peer-offline",
      connectable: false,
      unsupportedReason: "Offline",
    });
  });
});
