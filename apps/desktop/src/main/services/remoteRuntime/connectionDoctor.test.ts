import { describe, expect, it, vi } from "vitest";
import type { DesktopPairedMachineCredentials } from "../../../shared/types/pairedRuntime";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import type { RemoteRuntimeTargetRoute } from "../../../shared/types/remoteRuntime";
import { runRemoteRuntimeDoctor } from "./connectionDoctor";

const credentials: DesktopPairedMachineCredentials = {
  version: 1,
  hostIdentity: {
    deviceId: "host-1",
    siteId: "site-1",
    name: "Studio",
    platform: "macOS",
    deviceType: "desktop",
  },
  deviceId: "desktop-1",
  siteId: "desktop-site-1",
  deviceName: "Laptop",
  secret: "secret",
  dpopPrivateKey: "private",
  dpopPublicKey: "public",
  endpoints: [
    "ws://192.168.1.20:8787",
    "ws://100.70.0.2:8787",
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const target: RemoteRuntimeTarget = {
  id: "target-1",
  name: "Studio",
  hostname: "studio.local",
  sshUser: null,
  port: 22,
  sshKeyPath: null,
  routes: [{
    hostname: "100.70.0.2",
    port: 22,
    source: "tailscale",
    lastSucceededAt: null,
  }],
  lastSeenArch: null,
  runtimeBinaryVersion: null,
  lastConnectedAt: null,
};

describe("runRemoteRuntimeDoctor", () => {
  it("returns mixed paired and SSH probe results without mutating connection state", async () => {
    const probePaired = vi.fn(async (endpoint: string) => {
      if (endpoint.includes("100.70")) throw new Error("tailnet offline");
    });
    const probeSsh = vi.fn(async (
      _target: RemoteRuntimeTarget,
      route: RemoteRuntimeTargetRoute,
    ) => {
      if (route.hostname === "studio.local") throw new Error("ssh refused");
    });

    const result = await runRemoteRuntimeDoctor({
      target,
      credentials,
      dependencies: { probePaired, probeSsh },
    });

    expect(result.checks).toEqual([
      expect.objectContaining({
        route: "lan",
        endpoint: "ws://192.168.1.20:8787/",
        ok: true,
        latencyMs: expect.any(Number),
      }),
      expect.objectContaining({
        route: "tailnet",
        endpoint: "ws://100.70.0.2:8787/",
        ok: false,
        error: "tailnet offline",
      }),
      expect.objectContaining({
        route: "ssh",
        endpoint: "studio.local:22",
        ok: false,
        error: "ssh refused",
      }),
      expect.objectContaining({
        route: "ssh",
        endpoint: "100.70.0.2:22",
        ok: true,
        latencyMs: expect.any(Number),
      }),
    ]);
    expect(probePaired).toHaveBeenCalledTimes(2);
    expect(probeSsh).toHaveBeenCalledTimes(2);
  });
});
