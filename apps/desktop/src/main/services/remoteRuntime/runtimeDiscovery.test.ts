import { describe, expect, it } from "vitest";
import { discoveredRuntimeFromBonjourService } from "./runtimeDiscovery";

describe("runtimeDiscovery", () => {
  it("parses ADE sync Bonjour metadata into a discovered machine", () => {
    const discovered = discoveredRuntimeFromBonjourService({
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
        projects: "project-a, project-b",
        projectCount: "2",
        host: "192.168.1.42",
        addresses: "127.0.0.1,100.75.20.63",
        tailscaleDnsName: "studio.tailnet.ts.net",
        tailscaleIp: "100.75.20.63",
      },
    }, 1234);

    expect(discovered).toMatchObject({
      id: "device-123::ADE Sync Studio 8787._ade-sync._tcp.local",
      serviceName: "ADE Sync Studio 8787",
      machineName: "Studio",
      hostIdentity: "device-123",
      hostName: "studio.local",
      port: 8787,
      addresses: ["192.168.1.42", "100.75.20.63", "127.0.0.1"],
      primaryRoute: "192.168.1.42",
      tailscaleAddress: "studio.tailnet.ts.net",
      runtimeKind: "daemon",
      runtimeVersion: "0.0.0",
      projectIds: ["project-a", "project-b"],
      projectCount: 2,
      lastSeenAt: 1234,
    });
  });

  it("falls back to service metadata when TXT identity is partial", () => {
    const discovered = discoveredRuntimeFromBonjourService({
      name: "ADE Sync Laptop 8787",
      host: "laptop.local",
      port: 0,
      addresses: ["127.0.0.1"],
      txt: {
        port: "8787",
        runtimeKind: "",
      },
    }, 5678);

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
});
