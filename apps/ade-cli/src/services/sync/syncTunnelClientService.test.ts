import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  computeBackoffMs,
  createSyncTunnelClientService,
  parseControlMessage,
} from "./syncTunnelClientService";
import type { SyncCloudRelayStore } from "./syncCloudRelayStore";
import { createSharedSyncListener } from "./sharedSyncListener";
import {
  buildAccountMachineRegistration,
  type AccountMachineRegistrationSnapshot,
} from "../account/accountMachinePublisherService";

// syncCloudRelayStore itself (legacy-field cleanup, identity mint, URL
// derivation, signature builders) is covered in syncCloudRelayStore.test.ts.

function fakeStore(relayUrl = "https://relay.example.com"): SyncCloudRelayStore {
  let identity = { machineKey: "a".repeat(32), secret: "b".repeat(48) };
  return {
    getConfig: () => identity,
    getMachineIdentity: () => identity,
    getRelayUrl: () => relayUrl,
    setRelayUrl: () => identity,
    getRelayWssUrl: () => `wss://relay.example.com/connect/${identity.machineKey}`,
    rotateMachineIdentity: (expectedMachineKey: string) => {
      if (identity.machineKey === expectedMachineKey) {
        identity = { machineKey: "c".repeat(32), secret: "d".repeat(48) };
      }
      return identity;
    },
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

  it("passes ping/pong and rejects junk", () => {
    expect(parseControlMessage(JSON.stringify({ t: "ping" }))).toEqual({ t: "ping" });
    expect(parseControlMessage(JSON.stringify({ t: "pong" }))).toEqual({ t: "pong" });
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
            skipReason: tunnelStatus.lastError,
            lastControlError: tunnelStatus.lastControlError,
            lastControlOpenAt: tunnelStatus.lastControlOpenAt,
            lastBridgeValidationAt: tunnelStatus.lastBridgeValidationAt,
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
      expect(service.getStatus().connected).toBe(false);
      expect(service.getStatus().lastError).toBe("Sign in to ADE to use ADE Relay.");
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let lease polling bypass the reconnect backoff", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    globalThis.fetch = fetchMock;
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getRelayBridgeProof: () => "e".repeat(43),
      getAccountLease: async () => ({
        userId: "relay-owner",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      accountStatusPollMs: 5,
      configStore: fakeStore(),
    });

    try {
      await service.start();
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(900);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await service.dispose();
      random.mockRestore();
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("does not tear down a connecting control socket for a transient lease refresh failure", async () => {
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    const relay = new WebSocketServer({ noServer: true });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    let upgradeCount = 0;
    const pendingUpgrade: { release?: () => void } = {};
    let markUpgradeStarted: (() => void) | null = null;
    const upgradeStarted = new Promise<void>((resolve) => {
      markUpgradeStarted = resolve;
    });
    server.on("upgrade", (request, socket, head) => {
      upgradeCount += 1;
      pendingUpgrade.release = () => {
        relay.handleUpgrade(request, socket, head, (ws) => {
          relay.emit("connection", ws, request);
        });
      };
      markUpgradeStarted?.();
    });
    let leaseChecks = 0;
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const logger = { warn: vi.fn() };
    const service = createSyncTunnelClientService({
      logger,
      getSyncPort: () => 8787,
      getRelayBridgeProof: () => "e".repeat(43),
      getAccountLease: async () => {
        leaseChecks += 1;
        if (leaseChecks === 2) throw new Error("temporary refresh failure");
        return { userId: "relay-owner", expiresAt: leaseExpiresAt };
      },
      accountStatusPollMs: 5,
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
    });

    try {
      await service.start();
      await upgradeStarted;
      await vi.waitFor(() => expect(leaseChecks).toBeGreaterThanOrEqual(3));
      expect(upgradeCount).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "sync_tunnel.account_lease_failed",
        expect.objectContaining({ retained: true }),
      );

      pendingUpgrade.release?.();
      await vi.waitFor(() => expect(service.getStatus().connected).toBe(true));
      expect(upgradeCount).toBe(1);
    } finally {
      await service.dispose();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces the real control close code and reason", async () => {
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const connectedControl: { socket?: import("ws").WebSocket } = {};
    relay.on("connection", (socket) => {
      connectedControl.socket = socket;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = createSyncTunnelClientService({
      logger,
      getSyncPort: () => 8787,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
    });

    try {
      await service.start();
      await vi.waitFor(() => expect(service.getStatus().connected).toBe(true));
      connectedControl.socket?.close(4505, "replaced by newer host");
      await vi.waitFor(() => {
        expect(service.getStatus()).toMatchObject({
          connected: false,
          lastControlError: "Relay control closed (4505): replaced by newer host",
        });
      }, { timeout: 500 });
      expect(logger.info).toHaveBeenCalledWith(
        "sync_tunnel.control_close",
        expect.objectContaining({
          code: 4505,
          reason: "replaced by newer host",
          opened: true,
        }),
      );
    } finally {
      await service.dispose();
      random.mockRestore();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("captures a bounded unexpected-response status and body without replacing it with the ws error", async () => {
    const responseBody = "x".repeat(700);
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    server.on("upgrade", (_request, socket) => {
      socket.end([
        "HTTP/1.1 401 Unauthorized",
        "Content-Type: text/plain",
        `Content-Length: ${responseBody.length}`,
        "Connection: close",
        "",
        responseBody,
      ].join("\r\n"));
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = createSyncTunnelClientService({
      logger,
      getSyncPort: () => 8787,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(`http://127.0.0.1:${relayPort}`),
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(service.getStatus().lastControlError).toContain(
          "Relay control upgrade failed with HTTP 401",
        );
      });
      expect(service.getStatus().lastControlError).not.toContain(
        "WebSocket was closed before the connection was established",
      );
      const unexpectedLog = logger.warn.mock.calls.find(
        ([event, data]) => event === "sync_tunnel.control_error" && data?.status === 401,
      );
      expect(unexpectedLog?.[1]?.body).toHaveLength(512);
    } finally {
      await service.dispose();
      random.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rotates and republishes a relay identity only after a confirmed claim conflict", async () => {
    const server = createServer();
    const relay = new WebSocketServer({ noServer: true });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const pendingUpgrade: { release?: () => void } = {};
    let markUpgradeStarted: (() => void) | null = null;
    const upgradeStarted = new Promise<void>((resolve) => {
      markUpgradeStarted = resolve;
    });
    server.on("upgrade", (request, socket, head) => {
      pendingUpgrade.release = () => {
        relay.handleUpgrade(request, socket, head, (ws) => {
          relay.emit("connection", ws, request);
        });
      };
      markUpgradeStarted?.();
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    globalThis.fetch = fetchMock;
    const onIdentityRotated = vi.fn();
    const store = fakeStore(`http://127.0.0.1:${relayPort}`);
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => "f".repeat(32),
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: store,
      onIdentityRotated,
      loopbackProbe: async (port, expectedNonce) => ({
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
      await upgradeStarted;
      await expect(service.validateCurrentBridge()).resolves.toBe(true);
      expect(onIdentityRotated).not.toHaveBeenCalled();
      pendingUpgrade.release?.();
      delete pendingUpgrade.release;
      await vi.waitFor(() => expect(service.getStatus().connected).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(store.getMachineIdentity().machineKey).toBe("c".repeat(32));
      expect(service.getStatus().machineKey).toBe("c".repeat(32));
      expect(onIdentityRotated).toHaveBeenCalledOnce();
    } finally {
      pendingUpgrade.release?.();
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
    relay.on("connection", (socket, request) => {
      connections.push(request.url ?? "");
      if (connections.length === 1) {
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
      expect(service.getStatus().lastFailureAt).not.toBeNull();
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
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
