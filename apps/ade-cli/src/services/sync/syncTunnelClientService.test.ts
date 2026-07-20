import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  CONTROL_PING_INTERVAL_MS,
  CONTROL_PONG_DEADLINE_MS,
  computeBackoffMs,
  createSyncTunnelClientService,
  parseControlMessage,
  RELAY_CLOSE_BRIDGE_REJECTED,
  RELAY_CLOSE_HOST_UNAVAILABLE,
} from "./syncTunnelClientService";
import type { SyncLoopbackProbeResult } from "./syncLoopbackProbe";
import type { SyncCloudRelayStore } from "./syncCloudRelayStore";
import { createSharedSyncListener } from "./sharedSyncListener";
import {
  buildAccountMachineRegistration,
  type AccountMachineRegistrationSnapshot,
} from "../account/accountMachinePublisherService";

// syncCloudRelayStore itself (legacy-field cleanup, identity mint, URL
// derivation, signature builders) is covered in syncCloudRelayStore.test.ts.

function fakeStore(relayUrl = "https://relay.example.com"): SyncCloudRelayStore {
  const identity = { machineKey: "a".repeat(32), secret: "b".repeat(48) };
  return {
    getConfig: () => identity,
    getMachineIdentity: () => identity,
    getRelayUrl: () => relayUrl,
    setRelayUrl: () => identity,
    getRelayWssUrl: () => `wss://relay.example.com/connect/${identity.machineKey}`,
  } as unknown as SyncCloudRelayStore;
}

describe("computeBackoffMs", () => {
  it("grows exponentially and caps at 60s", () => {
    const max = (attempt: number) => computeBackoffMs(attempt, () => 0.999999);
    expect(max(0)).toBeLessThanOrEqual(1_000);
    expect(max(1)).toBeLessThanOrEqual(2_000);
    expect(max(2)).toBeLessThanOrEqual(4_000);
    expect(max(3)).toBeLessThanOrEqual(8_000);
    expect(max(20)).toBeLessThanOrEqual(60_000);
    expect(max(20)).toBeGreaterThan(50_000);
  });

  it("applies full jitter within the ceiling", () => {
    expect(computeBackoffMs(5, () => 0)).toBe(0);
    expect(computeBackoffMs(5, () => 0.5)).toBe(16_000);
  });
});

describe("parseControlMessage", () => {
  it("parses an open envelope with a valid id", () => {
    expect(parseControlMessage(JSON.stringify({ t: "open", id: "abcdef01" }))).toEqual({ t: "open", id: "abcdef01" });
  });

  it("rejects an open envelope with a malformed id", () => {
    expect(parseControlMessage(JSON.stringify({ t: "open", id: "not hex!" }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "open" }))).toBeNull();
  });

  it("rejects JSON ping/pong and junk", () => {
    expect(parseControlMessage(JSON.stringify({ t: "ping" }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "pong" }))).toBeNull();
    expect(parseControlMessage("not json")).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "other" }))).toBeNull();
  });
});

describe("createSyncTunnelClientService", () => {
  it("publishes Relay when control connects before a non-default shared listener", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const connections: string[] = [];
    relay.on("connection", (_socket, request) => {
      connections.push(request.url ?? "");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const machineKey = "a".repeat(32);
    const relayUrl = `wss://relay.example.com/connect/${machineKey}`;
    const service = createSyncTunnelClientService({
      getSyncPort: () => listener.getPort(),
      getExpectedLoopbackNonce: () => listener.getExpectedLoopbackNonce(),
      getRelayBridgeProof: () => listener.getRelayBridgeProof(),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
    });
    listener.onLoopbackValidated(() => {
      void service.validateCurrentBridge();
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(service.getStatus().connected).toBe(true);
      });
      expect(service.getStatus().relayBridgeValidated).toBe(false);

      const syncPort = await listener.ensureListening([0]);
      expect(syncPort).not.toBe(8787);
      await vi.waitFor(() => {
        expect(service.getStatus()).toMatchObject({
          connected: true,
          relayBridgeValidated: true,
          validatedPort: syncPort,
        });
      });

      const tunnelStatus = service.getStatus();
      const listenerStatus = listener.getLoopbackValidationStatus();
      const snapshot = {
        role: "brain",
        runtimeRole: "host",
        runtimeName: "Studio",
        pairingConnectInfo: {
          hostIdentity: {
            deviceId: "device-studio",
            siteId: "site-studio",
            name: "Studio",
            platform: "macOS",
            deviceType: "desktop",
          },
          port: syncPort,
          addressCandidates: [{ kind: "relay", host: relayUrl }],
        },
        routeHealth: {
          listener: {
            listenerBound: true,
            loopbackAdeValidated: listenerStatus.loopbackAdeValidated,
            port: syncPort,
            lastFailureAt: listenerStatus.lastFailureAt,
            reason: listenerStatus.reason,
            lastSuccessAt: listenerStatus.lastSuccessAt,
          },
          tailscale: {
            enabled: false,
            tailscalePublished: false,
            tailscaleReachable: false,
            lastFailureAt: null,
            reason: "Tailscale is unavailable.",
            lastSuccessAt: null,
          },
          relay: {
            enabled: true,
            relayControlConnected: tunnelStatus.connected,
            relayBridgeValidated: tunnelStatus.relayBridgeValidated,
            lastFailureAt: tunnelStatus.lastFailureAt,
            reason: tunnelStatus.lastError,
            lastSuccessAt: tunnelStatus.lastSuccessAt,
          },
        },
      } satisfies AccountMachineRegistrationSnapshot;
      expect(buildAccountMachineRegistration({ machineKey, snapshot })?.reachableEndpoints).toEqual([
        { kind: "relay", url: relayUrl },
      ]);
      // The Relay never sent an external {t:"open"}; only its control socket exists.
      expect(connections).toHaveLength(1);
      expect(connections[0]).not.toContain("/pipe/");
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await listener.close();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("keeps Relay offline signed out, resumes on sign-in, and closes when token refresh fails", async () => {
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    let signedIn = false;
    let leaseValid = true;
    let connections = 0;
    relay.on("connection", () => {
      connections += 1;
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getRelayBridgeProof: () => "e".repeat(43),
      isAccountSignedIn: () => signedIn,
      getAccountLease: async () => signedIn && leaseValid
        ? { userId: "relay-owner" }
        : null,
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
    });

    try {
      await service.start();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.getStatus()).toMatchObject({
        connected: false,
        activeTunnels: 0,
        lastError: "Sign in to ADE to use ADE Relay.",
      });

      signedIn = true;
      await vi.waitFor(() => {
        expect(connections).toBe(1);
        expect(service.getStatus().connected).toBe(true);
      }, { timeout: 3_000 });

      leaseValid = false;
      await vi.waitFor(() => {
        expect(service.getStatus()).toMatchObject({
          connected: false,
          activeTunnels: 0,
          lastError: "Sign in to ADE to use ADE Relay.",
        });
      }, { timeout: 3_000 });
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("does not start overlapping Relay claims while account status is polling", async () => {
    let signedIn = true;
    let releaseClaim!: (response: Response) => void;
    const claim = new Promise<Response>((resolve) => {
      releaseClaim = resolve;
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => await claim);
    globalThis.fetch = fetchMock;
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getRelayBridgeProof: () => "e".repeat(43),
      isAccountSignedIn: () => signedIn,
      accountStatusPollMs: 5,
      configStore: fakeStore(),
    });

    try {
      const starting = service.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      signedIn = false;
      releaseClaim(new Response(null, { status: 204 }));
      await starting;
      await vi.waitFor(() => {
        expect(service.getStatus().connected).toBe(false);
        expect(service.getStatus().lastError).toBe("Sign in to ADE to use ADE Relay.");
      });
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps account polling from bypassing reconnect backoff after a failed claim", async () => {
    const originalFetch = globalThis.fetch;
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    globalThis.fetch = fetchMock;
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getRelayBridgeProof: () => "e".repeat(43),
      accountStatusPollMs: 5,
      configStore: fakeStore(),
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(service.getStatus()).toMatchObject({
        connected: false,
        lastError: "claim failed (503)",
      });
    } finally {
      await service.dispose();
      random.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("gates an open immediately when sign-out happens before the next account poll", async () => {
    const local = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      local.once("listening", resolve);
      local.once("error", reject);
    });
    const localAddress = local.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;
    let localConnections = 0;
    local.on("connection", () => { localConnections += 1; });

    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const relayAddress = relay.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
    let controlSocket: WebSocket | null = null;
    const relayConnections: string[] = [];
    const controlMessages: unknown[] = [];
    relay.on("connection", (socket, request) => {
      relayConnections.push(request.url ?? "");
      if (!request.url?.includes("/pipe/")) {
        controlSocket = socket;
        socket.on("message", (raw) => controlMessages.push(JSON.parse(raw.toString()) as unknown));
      }
    });

    let signedIn = true;
    const expectedNonce = "c".repeat(32);
    const loopbackProbe = vi.fn(async (port: number) => ({
      ok: true as const,
      port,
      statusCode: 426,
      statusMessage: "Upgrade Required",
      markerValue: expectedNonce,
      checkedAt: new Date().toISOString(),
      reason: null,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => localPort,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      isAccountSignedIn: () => signedIn,
      accountStatusPollMs: 10_000,
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
      loopbackProbe,
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(service.getStatus().relayBridgeValidated).toBe(true);
        expect(controlSocket).not.toBeNull();
      });
      const probesBeforeSignOut = loopbackProbe.mock.calls.length;

      signedIn = false;
      (controlSocket as unknown as WebSocket).send(JSON.stringify({ t: "open", id: "abcdef01" }));

      await vi.waitFor(() => {
        expect(controlMessages).toContainEqual({
          t: "reject",
          id: "abcdef01",
          code: RELAY_CLOSE_HOST_UNAVAILABLE,
          reason: "bridge validation failed",
        });
      });
      expect(loopbackProbe).toHaveBeenCalledTimes(probesBeforeSignOut);
      expect(relayConnections).toHaveLength(1);
      expect(localConnections).toBe(0);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("does not open a queued tunnel from a superseded control socket", async () => {
    const local = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      local.once("listening", resolve);
      local.once("error", reject);
    });
    const localAddress = local.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;
    let localConnections = 0;
    local.on("connection", () => { localConnections += 1; });

    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const relayAddress = relay.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
    const controlSockets: WebSocket[] = [];
    let pipeConnections = 0;
    relay.on("connection", (socket, request) => {
      if (request.url?.includes("/pipe/")) {
        pipeConnections += 1;
      } else {
        controlSockets.push(socket);
      }
    });

    const expectedNonce = "c".repeat(32);
    let probeCalls = 0;
    let finishQueuedProbe!: (result: SyncLoopbackProbeResult) => void;
    const queuedProbe = new Promise<SyncLoopbackProbeResult>((resolve) => {
      finishQueuedProbe = resolve;
    });
    const loopbackProbe = vi.fn(async (port: number): Promise<SyncLoopbackProbeResult> => {
      probeCalls += 1;
      if (probeCalls === 1) {
        return {
          ok: true,
          port,
          statusCode: 426,
          statusMessage: "Upgrade Required",
          markerValue: expectedNonce,
          checkedAt: new Date().toISOString(),
          reason: null,
        };
      }
      return await queuedProbe;
    });
    const originalFetch = globalThis.fetch;
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => localPort,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
      loopbackProbe,
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(service.getStatus().relayBridgeValidated).toBe(true);
        expect(controlSockets).toHaveLength(1);
      });
      controlSockets[0].send(JSON.stringify({ t: "open", id: "abcdef01" }));
      await vi.waitFor(() => expect(probeCalls).toBe(2));

      controlSockets[0].close();
      await vi.waitFor(() => expect(controlSockets).toHaveLength(2));
      finishQueuedProbe({
        ok: true,
        port: localPort,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(pipeConnections).toBe(0);
      expect(localConnections).toBe(0);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      random.mockRestore();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("terminates and reconnects a control socket that misses its native pong deadline", async () => {
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    let connections = 0;
    let pings = 0;
    relay.on("connection", (socket) => {
      connections += 1;
      socket.on("ping", () => { pings += 1; });
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    globalThis.fetch = fetchMock;
    const service = createSyncTunnelClientService({
      getSyncPort: () => null,
      getRelayBridgeProof: () => null,
      controlPingIntervalMs: 10,
      controlPongDeadlineMs: 10,
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
    });

    try {
      expect(CONTROL_PING_INTERVAL_MS).toBe(30_000);
      expect(CONTROL_PONG_DEADLINE_MS).toBe(10_000);
      await service.start();
      await vi.waitFor(() => {
        expect(connections).toBeGreaterThanOrEqual(2);
      }, { timeout: 1_000 });
      expect(pings).toBeGreaterThanOrEqual(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await service.dispose();
      random.mockRestore();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("refuses a relay pipe before forwarding when loopback is not ADE", async () => {
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const connections: string[] = [];
    const controlMessages: unknown[] = [];
    relay.on("connection", (socket, request) => {
      connections.push(request.url ?? "");
      if (connections.length === 1) {
        socket.on("message", (raw) => {
          controlMessages.push(JSON.parse(raw.toString()) as unknown);
        });
        socket.send(JSON.stringify({ t: "open", id: "abcdef01" }));
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const expectedNonce = "c".repeat(32);
    const loopbackProbe = vi.fn(async (port: number, receivedNonce: string) => ({
      ok: false,
      port,
      statusCode: 426,
      statusMessage: "Upgrade Required",
      markerValue: "d".repeat(32),
      checkedAt: new Date().toISOString(),
      reason: `foreign listener does not match ${receivedNonce}`,
    }));
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
      loopbackProbe,
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(service.getStatus().lastError).toContain("Relay bridge refused");
      });
      expect(connections).toHaveLength(1);
      expect(connections[0]).toContain(`/host/${"a".repeat(32)}`);
      expect(loopbackProbe).toHaveBeenCalledWith(8787, expectedNonce);
      expect(service.getStatus()).toMatchObject({
        connected: true,
        activeTunnels: 0,
        relayBridgeValidated: false,
      });
      await vi.waitFor(() => {
        expect(controlMessages).toContainEqual({
          t: "reject",
          id: "abcdef01",
          code: RELAY_CLOSE_BRIDGE_REJECTED,
          reason: "bridge validation failed",
        });
      });
      expect(service.getStatus().lastFailureAt).not.toBeNull();
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("rejects an open as host-unavailable when the local sync socket cannot connect", async () => {
    const unavailable = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      unavailable.once("listening", resolve);
      unavailable.once("error", reject);
    });
    const unavailableAddress = unavailable.address();
    const unavailablePort = typeof unavailableAddress === "object" && unavailableAddress
      ? unavailableAddress.port
      : 0;
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));

    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const relayAddress = relay.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
    const connections: string[] = [];
    const controlMessages: unknown[] = [];
    relay.on("connection", (socket, request) => {
      connections.push(request.url ?? "");
      if (!request.url?.includes("/pipe/")) {
        socket.on("message", (raw) => {
          controlMessages.push(JSON.parse(raw.toString()) as unknown);
        });
        socket.send(JSON.stringify({ t: "open", id: "abcdef01" }));
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const expectedNonce = "c".repeat(32);
    const service = createSyncTunnelClientService({
      getSyncPort: () => unavailablePort,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
      loopbackProbe: async (port) => ({
        ok: true,
        port,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      }),
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(controlMessages).toContainEqual({
          t: "reject",
          id: "abcdef01",
          code: RELAY_CLOSE_HOST_UNAVAILABLE,
          reason: "host sync listener unavailable",
        });
      });
      expect(connections.some((url) => url.includes("/pipe/abcdef01"))).toBe(true);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("probes serially on every open and constructs no tunnel when validation fails", async () => {
    const local = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      local.once("listening", resolve);
      local.once("error", reject);
    });
    const localAddress = local.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;
    let localConnections = 0;
    const localFrames: string[] = [];
    local.on("connection", (socket) => {
      localConnections += 1;
      socket.on("message", (raw) => localFrames.push(raw.toString()));
    });

    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const relayAddress = relay.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
    let controlSocket: WebSocket | null = null;
    let pipeConnections = 0;
    const controlMessages: unknown[] = [];
    relay.on("connection", (socket, request) => {
      if (request.url?.includes("/pipe/")) {
        pipeConnections += 1;
      } else {
        controlSocket = socket;
        socket.on("message", (raw) => {
          controlMessages.push(JSON.parse(raw.toString()) as unknown);
        });
      }
    });

    const expectedNonce = "c".repeat(32);
    let probeCalls = 0;
    let finishOpenProbe!: (result: SyncLoopbackProbeResult) => void;
    const openProbe = new Promise<SyncLoopbackProbeResult>((resolve) => {
      finishOpenProbe = resolve;
    });
    const loopbackProbe = vi.fn(async (port: number): Promise<SyncLoopbackProbeResult> => {
      probeCalls += 1;
      if (probeCalls === 1) {
        return {
          ok: true,
          port,
          statusCode: 426,
          statusMessage: "Upgrade Required",
          markerValue: expectedNonce,
          checkedAt: new Date().toISOString(),
          reason: null,
        };
      }
      return await openProbe;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => localPort,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
      loopbackProbe,
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(service.getStatus().relayBridgeValidated).toBe(true);
        expect(controlSocket).not.toBeNull();
      });
      (controlSocket as unknown as WebSocket).send(JSON.stringify({ t: "open", id: "abcdef01" }));
      await vi.waitFor(() => {
        expect(probeCalls).toBe(2);
      });
      expect(pipeConnections).toBe(0);
      expect(localConnections).toBe(0);
      expect(localFrames).toEqual([]);
      expect(service.getStatus().activeTunnels).toBe(0);

      finishOpenProbe({
        ok: false,
        port: localPort,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: "d".repeat(32),
        checkedAt: new Date().toISOString(),
        reason: "listener identity changed",
      });
      await vi.waitFor(() => {
        expect(controlMessages).toContainEqual({
          t: "reject",
          id: "abcdef01",
          code: RELAY_CLOSE_BRIDGE_REJECTED,
          reason: "bridge validation failed",
        });
      });
      expect(pipeConnections).toBe(0);
      expect(localConnections).toBe(0);
      expect(localFrames).toEqual([]);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("preserves application close codes and reasons across the pipe/local bridge", async () => {
    const local = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      local.once("listening", resolve);
      local.once("error", reject);
    });
    const localAddress = local.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;
    const localSockets: WebSocket[] = [];
    const localCloses: Array<{ code: number; reason: string }> = [];
    local.on("connection", (socket) => {
      const index = localSockets.push(socket) - 1;
      socket.on("close", (code, reason) => {
        localCloses[index] = { code, reason: reason.toString() };
      });
    });

    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const relayAddress = relay.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
    let controlSocket: WebSocket | null = null;
    const pipeSockets: WebSocket[] = [];
    const pipeCloses: Array<{ code: number; reason: string }> = [];
    relay.on("connection", (socket, request) => {
      if (request.url?.includes("/pipe/")) {
        const index = pipeSockets.push(socket) - 1;
        socket.on("close", (code, reason) => {
          pipeCloses[index] = { code, reason: reason.toString() };
        });
      } else {
        controlSocket = socket;
      }
    });
    const expectedNonce = "c".repeat(32);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => localPort,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
      loopbackProbe: async (port) => ({
        ok: true,
        port,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      }),
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(service.getStatus().relayBridgeValidated).toBe(true);
        expect(controlSocket).not.toBeNull();
      });
      (controlSocket as unknown as WebSocket).send(JSON.stringify({ t: "open", id: "abcdef01" }));
      await vi.waitFor(() => {
        expect(pipeSockets).toHaveLength(1);
        expect(localSockets).toHaveLength(1);
      });
      localSockets[0]?.close(4666, "local app close");
      await vi.waitFor(() => {
        expect(pipeCloses[0]).toEqual({ code: 4666, reason: "local app close" });
      });

      (controlSocket as unknown as WebSocket).send(JSON.stringify({ t: "open", id: "abcdef02" }));
      await vi.waitFor(() => {
        expect(pipeSockets).toHaveLength(2);
        expect(localSockets).toHaveLength(2);
      });
      pipeSockets[1]?.close(4777, "pipe app close");
      await vi.waitFor(() => {
        expect(localCloses[1]).toEqual({ code: 4777, reason: "pipe app close" });
        expect(service.getStatus().activeTunnels).toBe(0);
      });
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("does not open a pipe when the account lease expires during loopback validation", async () => {
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const connections: string[] = [];
    relay.on("connection", (socket, request) => {
      connections.push(request.url ?? "");
      if (connections.length === 1) {
        socket.send(JSON.stringify({ t: "open", id: "abcdef01" }));
      }
    });
    let leaseValid = true;
    let finishProbe: ((result: {
      ok: true;
      port: number;
      statusCode: number;
      statusMessage: string;
      markerValue: string;
      checkedAt: string;
      reason: null;
    }) => void) | null = null;
    let markProbeStarted: (() => void) | null = null;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const expectedNonce = "c".repeat(32);
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      getAccountLease: async () => leaseValid ? { userId: "relay-owner" } : null,
      accountStatusPollMs: 5,
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
      loopbackProbe: async (port) => {
        markProbeStarted?.();
        return await new Promise((resolve) => {
          finishProbe = resolve;
        });
      },
    });

    try {
      await service.start();
      await probeStarted;
      leaseValid = false;
      await vi.waitFor(() => {
        expect(service.getStatus().accountLeaseValid).toBe(false);
      });
      finishProbe!({
        ok: true,
        port: 8787,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(connections).toHaveLength(1);
      expect(service.getStatus()).toMatchObject({
        accountLeaseValid: false,
        activeTunnels: 0,
        relayBridgeValidated: false,
        lastError: "Sign in to ADE to use ADE Relay.",
      });
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("authenticates the tunnel client's local socket as the trusted relay bridge", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const localOrigins: string[] = [];
    listener.setConnectionHandler((connection) => {
      localOrigins.push(connection.transportOrigin);
    });
    const syncPort = await listener.ensureListening([0]);
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const connections: string[] = [];
    relay.on("connection", (socket, request) => {
      connections.push(request.url ?? "");
      if (connections.length === 1) {
        socket.send(JSON.stringify({ t: "open", id: "abcdef01" }));
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => syncPort,
      getExpectedLoopbackNonce: () => listener.getExpectedLoopbackNonce(),
      getRelayBridgeProof: () => listener.getRelayBridgeProof(),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(connections).toHaveLength(2);
        expect(localOrigins).toEqual(["relay-bridge"]);
      });
      expect(connections[1]).toContain(`/pipe/abcdef01`);
      expect(service.getStatus()).toMatchObject({
        connected: true,
        relayBridgeValidated: true,
      });
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await listener.close();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });
});
