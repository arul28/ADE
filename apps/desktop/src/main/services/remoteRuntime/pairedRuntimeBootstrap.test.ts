import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPairedMachineCredentials } from "../../../shared/types/pairedRuntime";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import type { SyncRuntimeTransport } from "./syncRuntimeTransport";

const initializeMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const createForwardClientMock = vi.hoisted(() => vi.fn(() => ({
  ensureForward: vi.fn(),
  dispose: vi.fn(),
})));

vi.mock("./runtimeRpcClient", () => ({
  RuntimeRpcClient: vi.fn().mockImplementation(() => ({
    initialize: initializeMock,
    call: callMock,
    close: closeMock,
  })),
}));

vi.mock("./syncPortForwardClient", () => ({
  createSyncPortForwardClient: createForwardClientMock,
}));

import { bootstrapPairedRuntime } from "./pairedRuntimeBootstrap";
import { PairedRuntimeCompatibilityError } from "./pairedRuntimeErrors";

const credentials: DesktopPairedMachineCredentials = {
  version: 1,
  hostIdentity: {
    deviceId: "host-1",
    siteId: "host-site-1",
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
  endpoints: ["ws://studio.local:8787"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const target: RemoteRuntimeTarget = {
  id: "target-1",
  name: "Studio",
  hostname: "studio.local",
  transport: "paired",
  pairedMachine: { hostIdentity: "host-1", machineKey: null },
  sshUser: null,
  port: null,
  sshKeyPath: null,
  lastSeenArch: null,
  runtimeBinaryVersion: null,
  lastConnectedAt: null,
};

function transport(features = { rpcChannel: true, portForward: true }): SyncRuntimeTransport {
  return {
    channelId: "rpc-1",
    connection: {
      endpoint: "ws://studio.local:8787/",
      credentials,
      hello: {
        peer: {},
        brain: {
          deviceId: "host-1",
          deviceName: "Studio",
          platform: "macOS",
          deviceType: "desktop",
          siteId: "host-site-1",
          dbVersion: 0,
        },
        serverDbVersion: 0,
        heartbeatIntervalMs: 5_000,
        pollIntervalMs: 1_500,
        features,
      } as any,
      send: vi.fn(),
      onEnvelope: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onClose: vi.fn(() => () => {}),
      bufferedAmount: vi.fn(() => 0),
      close: vi.fn(),
    },
    onData: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    write: vi.fn(),
    close: vi.fn(),
  };
}

describe("bootstrapPairedRuntime", () => {
  beforeEach(() => {
    initializeMock.mockReset();
    callMock.mockReset();
    closeMock.mockReset();
    createForwardClientMock.mockClear();
  });

  it("uses the same initialize validation and returns the winning paired route", async () => {
    initializeMock.mockResolvedValue({
      runtimeInfo: { version: "1.0.0", multiProject: true },
      capabilities: { projects: true },
    });
    callMock.mockResolvedValue([]);
    const updated = {
      ...target,
      lastSeenArch: "darwin",
      runtimeBinaryVersion: "1.0.0",
      lastConnectedAt: 100,
    };
    const registry = {
      update: vi.fn(() => updated),
    };
    const pairedStore = {
      getForReference: vi.fn(() => credentials),
      markEndpointSucceeded: vi.fn(() => credentials),
    };

    const result = await bootstrapPairedRuntime({
      target,
      registry: registry as any,
      pairedStore: pairedStore as any,
      appVersion: "1.0.0",
      options: { openTransport: vi.fn(async () => transport()) },
    });

    expect(initializeMock).toHaveBeenCalledWith("ade-desktop-remote", "1.0.0");
    expect(pairedStore.getForReference).toHaveBeenCalledWith(target.pairedMachine);
    expect(result.result).toMatchObject({
      target: updated,
      arch: "darwin",
      version: "1.0.0",
      route: {
        kind: "lan",
        endpoint: "ws://studio.local:8787/",
        latencyMs: expect.any(Number),
      },
    });
    expect(pairedStore.markEndpointSucceeded).toHaveBeenCalledWith(
      "host-1",
      "ws://studio.local:8787/",
      expect.any(Number),
    );
    expect(createForwardClientMock).toHaveBeenCalledWith(result.transport.connection);
  });

  it("surfaces initialize incompatibility with an SSH update suggestion", async () => {
    initializeMock.mockResolvedValue({
      runtimeInfo: { version: "0.1.0", multiProject: false },
      capabilities: { projects: false },
    });

    await expect(bootstrapPairedRuntime({
      target,
      registry: { update: vi.fn() } as any,
      pairedStore: {
        getForReference: vi.fn(() => credentials),
        markEndpointSucceeded: vi.fn(),
      } as any,
      appVersion: "1.0.0",
      options: { openTransport: vi.fn(async () => transport()) },
    })).rejects.toEqual(expect.objectContaining({
      name: PairedRuntimeCompatibilityError.name,
      message: expect.stringMatching(/connect .* with SSH to update/i),
    }));
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
