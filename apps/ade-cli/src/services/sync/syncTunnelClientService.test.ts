import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_VALIDATION_LEASE_MS,
  CONNECT_DEADLINE_MS,
  CONTROL_PING_INTERVAL_MS,
  CONTROL_PONG_DEADLINE_MS,
  computeBackoffMs,
  createSyncTunnelClientService,
  makeBufferedForwarder,
  MAX_BUFFERED_TUNNEL_BYTES,
  MAX_PENDING_TUNNEL_BYTES,
  MAX_RELAY_WEBSOCKET_FRAME_BYTES,
  parseControlMessage,
  RELAY_CLOSE_BRIDGE_REJECTED,
  RELAY_CLOSE_FORWARD_FAILED,
  RELAY_CLOSE_HOST_UNAVAILABLE,
  RELAY_READY_VERSION,
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

function epochFromControlUrl(requestUrl: string | undefined): string {
  const epoch = new URL(requestUrl ?? "/", "http://relay.invalid").searchParams.get("epoch");
  if (!epoch) throw new Error("expected epoch control registration");
  return epoch;
}

function epochOpen(requestUrl: string | undefined, id: string): string {
  return JSON.stringify({
    t: "open",
    id,
    epoch: epochFromControlUrl(requestUrl),
    readyVersion: RELAY_READY_VERSION,
  });
}

class StubWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  sendCallbackError: Error | null = null;

  constructor(readonly url: string) {
    super();
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(value: string): void {
    this.emit("message", Buffer.from(value));
  }

  remoteClose(code = 4505, reason = "control replaced"): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  send(
    data: unknown,
    optionsOrCallback?: unknown,
    callback?: (error?: Error) => void,
  ): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error("cannot send on a closed test socket");
    const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    const error = this.sendCallbackError;
    this.sendCallbackError = null;
    if (!error) this.sent.push(String(data));
    (done as ((error?: Error) => void) | undefined)?.(error ?? undefined);
  }

  ping(): void {}

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.closes.push({ code, reason });
    queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    });
  }

  terminate(): void {
    this.close(1006, "terminated");
  }
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
  it("parses epoch and legacy open envelopes with valid ids", () => {
    const epoch = "e".repeat(32);
    expect(parseControlMessage(JSON.stringify({
      t: "open",
      id: "abcdef01",
      epoch,
      readyVersion: RELAY_READY_VERSION,
    }))).toEqual({ t: "open", id: "abcdef01", epoch, readyVersion: RELAY_READY_VERSION });
    expect(parseControlMessage(JSON.stringify({ t: "open", id: "abcdef02" }))).toEqual({
      t: "open",
      id: "abcdef02",
    });
  });

  it("rejects an open envelope with a malformed id", () => {
    expect(parseControlMessage(JSON.stringify({ t: "open", id: "not hex!" }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "open" }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "open", id: "abcdef01", epoch: "short" }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({
      t: "open",
      id: "abcdef01",
      epoch: "e".repeat(32),
      readyVersion: 99,
    }))).toBeNull();
  });

  it("rejects JSON ping/pong and junk", () => {
    expect(parseControlMessage(JSON.stringify({ t: "ping" }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "pong" }))).toBeNull();
    expect(parseControlMessage("not json")).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "other" }))).toBeNull();
  });
});

describe("makeBufferedForwarder", () => {
  it("bounds pre-open buffering by aggregate bytes across both directions", () => {
    const first = new StubWebSocket("ws://first");
    const second = new StubWebSocket("ws://second");
    const onFailure = vi.fn();
    const forward = makeBufferedForwarder(onFailure);
    const firstBytes = Math.floor(MAX_PENDING_TUNNEL_BYTES / 2);

    forward(first as unknown as WebSocket, Buffer.alloc(firstBytes), true);
    forward(second as unknown as WebSocket, Buffer.alloc(MAX_PENDING_TUNNEL_BYTES - firstBytes), true);
    forward(first as unknown as WebSocket, Buffer.from([1]), true);

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("bridge frame buffer overflow");
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([]);
  });

  it("bounds Node send queues for live sends and pre-open flushes", () => {
    const firstLive = new StubWebSocket("ws://first-live");
    const secondLive = new StubWebSocket("ws://second-live");
    firstLive.open();
    secondLive.open();
    firstLive.bufferedAmount = Math.floor(MAX_BUFFERED_TUNNEL_BYTES / 2);
    secondLive.bufferedAmount = MAX_BUFFERED_TUNNEL_BYTES - firstLive.bufferedAmount;
    const liveFailure = vi.fn();
    const forwardLive = makeBufferedForwarder(liveFailure);

    forwardLive(firstLive as unknown as WebSocket, Buffer.from([1]), true);
    forwardLive(secondLive as unknown as WebSocket, Buffer.from([2]), true);

    expect(liveFailure).toHaveBeenCalledOnce();
    expect(liveFailure).toHaveBeenCalledWith("bridge send buffer overflow");
    expect(firstLive.sent).toHaveLength(1);
    expect(secondLive.sent).toEqual([]);

    const connecting = new StubWebSocket("ws://connecting");
    const flushFailure = vi.fn();
    const forwardOnOpen = makeBufferedForwarder(flushFailure);
    forwardOnOpen(connecting as unknown as WebSocket, Buffer.from("queued-before-open"), true);
    connecting.bufferedAmount = MAX_BUFFERED_TUNNEL_BYTES;

    connecting.open();

    expect(flushFailure).toHaveBeenCalledOnce();
    expect(flushFailure).toHaveBeenCalledWith("bridge send buffer overflow");
    expect(connecting.sent).toEqual([]);
  });

  it("passes through one protocol-legal frame larger than the steady-state send budget", () => {
    const target = new StubWebSocket("ws://large-frame");
    target.open();
    const onFailure = vi.fn();
    const forward = makeBufferedForwarder(onFailure);
    const frame = Buffer.alloc(MAX_BUFFERED_TUNNEL_BYTES + 1);

    forward(target as unknown as WebSocket, frame, true);

    expect(onFailure).not.toHaveBeenCalled();
    expect(target.sent).toHaveLength(1);
  });

  it("rejects a large frame behind queued bytes and any frame above the protocol limit", () => {
    const queuedTarget = new StubWebSocket("ws://queued-large-frame");
    queuedTarget.open();
    queuedTarget.bufferedAmount = 1;
    const queuedFailure = vi.fn();
    const forwardQueued = makeBufferedForwarder(queuedFailure);

    forwardQueued(
      queuedTarget as unknown as WebSocket,
      Buffer.alloc(MAX_BUFFERED_TUNNEL_BYTES + 1),
      true,
    );

    expect(queuedFailure).toHaveBeenCalledOnce();
    expect(queuedFailure).toHaveBeenCalledWith("bridge send buffer overflow");
    expect(queuedTarget.sent).toEqual([]);

    const oversizedTarget = new StubWebSocket("ws://oversized-frame");
    oversizedTarget.open();
    const oversizedFailure = vi.fn();
    const forwardOversized = makeBufferedForwarder(oversizedFailure);

    forwardOversized(
      oversizedTarget as unknown as WebSocket,
      Buffer.alloc(MAX_RELAY_WEBSOCKET_FRAME_BYTES + 1),
      true,
    );

    expect(oversizedFailure).toHaveBeenCalledOnce();
    expect(oversizedFailure).toHaveBeenCalledWith("bridge frame too large");
    expect(oversizedTarget.sent).toEqual([]);
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
    let controlUrl: string | undefined;
    const relayConnections: string[] = [];
    const controlMessages: unknown[] = [];
    relay.on("connection", (socket, request) => {
      relayConnections.push(request.url ?? "");
      if (!request.url?.includes("/pipe/")) {
        controlSocket = socket;
        controlUrl = request.url;
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
      (controlSocket as unknown as WebSocket).send(epochOpen(controlUrl, "abcdef01"));

      await vi.waitFor(() => {
        expect(controlMessages).toContainEqual(expect.objectContaining({
          t: "reject",
          id: "abcdef01",
          code: RELAY_CLOSE_HOST_UNAVAILABLE,
          reason: "bridge validation failed",
        }));
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

  it("abandons an open immediately when its control closes during validation", async () => {
    const sockets: StubWebSocket[] = [];
    let finishProbe!: (result: SyncLoopbackProbeResult) => void;
    const probeResult = new Promise<SyncLoopbackProbeResult>((resolve) => {
      finishProbe = resolve;
    });
    const expectedNonce = "c".repeat(32);
    const loopbackProbe = vi.fn(async () => await probeResult);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(),
      loopbackProbe,
      reconnectBackoffMs: () => 0,
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      sockets[0].open();
      sockets[0].receive(epochOpen(sockets[0].url, "abcdef01"));
      await vi.waitFor(() => expect(loopbackProbe).toHaveBeenCalledOnce());

      sockets[0].remoteClose();
      expect(sockets[0].readyState).toBe(WebSocket.CLOSED);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1].open();
      finishProbe({
        ok: true,
        port: 8787,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      });

      await vi.waitFor(() => expect(service.getStatus().relayBridgeValidated).toBe(true));
      expect(sockets[0].sent).toEqual([]);
      expect(sockets.some((socket) => socket.url.includes("/pipe/"))).toBe(false);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("abandons an open when control closes before bridge socket construction", async () => {
    const sockets: StubWebSocket[] = [];
    const expectedNonce = "c".repeat(32);
    let replaceOnProof = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => {
        if (replaceOnProof) sockets[0].remoteClose();
        return "e".repeat(43);
      },
      configStore: fakeStore(),
      loopbackProbe: async (port) => ({
        ok: true,
        port,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      }),
      reconnectBackoffMs: () => 0,
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      sockets[0].open();
      await vi.waitFor(() => expect(service.getStatus().relayBridgeValidated).toBe(true));
      replaceOnProof = true;
      sockets[0].receive(epochOpen(sockets[0].url, "abcdef02"));

      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(sockets[0].readyState).toBe(WebSocket.CLOSED);
      expect(sockets[0].sent).toEqual([]);
      expect(sockets.some((socket) => socket.url.includes("/pipe/"))).toBe(false);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not announce ready after the validated listener identity changes", async () => {
    const sockets: StubWebSocket[] = [];
    let nonce = "c".repeat(32);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => nonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(),
      loopbackProbe: async (port, expectedNonce) => ({
        ok: true,
        port,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      }),
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      const control = sockets[0];
      control.open();
      await vi.waitFor(() => expect(service.getStatus().relayBridgeValidated).toBe(true));
      control.receive(epochOpen(control.url, "abcdef03"));
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      const pipe = sockets.find((socket) => socket.url.includes("/pipe/"));
      const local = sockets.find((socket) => socket.url === "ws://127.0.0.1:8787");
      expect(pipe).toBeTruthy();
      expect(local).toBeTruthy();

      nonce = "d".repeat(32);
      pipe!.open();
      local!.open();

      await vi.waitFor(() => {
        expect(pipe!.readyState).toBe(WebSocket.CLOSED);
        expect(local!.readyState).toBe(WebSocket.CLOSED);
      });
      const lifecycle = control.sent.map((raw) => JSON.parse(raw) as { t?: string; reason?: string });
      expect(lifecycle).toContainEqual(expect.objectContaining({
        t: "reject",
        reason: "bridge identity changed",
      }));
      expect(lifecycle.some((message) => message.t === "ready")).toBe(false);
      expect(pipe!.closes).toContainEqual({ code: RELAY_CLOSE_BRIDGE_REJECTED, reason: "bridge identity changed" });
      expect(local!.closes).toContainEqual({ code: RELAY_CLOSE_BRIDGE_REJECTED, reason: "bridge identity changed" });
      expect(service.getStatus()).toMatchObject({ activeTunnels: 0, relayBridgeValidated: false });
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not mark a tunnel ready when the control send callback fails synchronously", async () => {
    const sockets: StubWebSocket[] = [];
    const logger = { debug: vi.fn() };
    const expectedNonce = "c".repeat(32);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      logger,
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(),
      loopbackProbe: async (port) => ({
        ok: true,
        port,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      }),
      reconnectBackoffMs: () => 0,
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      const control = sockets[0];
      control.open();
      await vi.waitFor(() => expect(service.getStatus().relayBridgeValidated).toBe(true));
      control.receive(epochOpen(control.url, "abcdef04"));
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      const pipe = sockets.find((socket) => socket.url.includes("/pipe/"));
      const local = sockets.find((socket) => socket.url === "ws://127.0.0.1:8787");
      expect(pipe).toBeTruthy();
      expect(local).toBeTruthy();

      control.sendCallbackError = new Error("injected ready send failure");
      pipe!.open();
      local!.open();

      await vi.waitFor(() => {
        expect(pipe!.readyState).toBe(WebSocket.CLOSED);
        expect(local!.readyState).toBe(WebSocket.CLOSED);
      });
      expect(control.sent.map((raw) => JSON.parse(raw) as { t?: string }))
        .not.toContainEqual(expect.objectContaining({ t: "ready" }));
      expect(logger.debug).not.toHaveBeenCalledWith("sync_tunnel.ready", expect.anything());
      expect(pipe!.closes).toContainEqual({
        code: RELAY_CLOSE_BRIDGE_REJECTED,
        reason: "relay readiness unavailable",
      });
      expect(local!.closes).toContainEqual({
        code: RELAY_CLOSE_BRIDGE_REJECTED,
        reason: "relay readiness unavailable",
      });
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a failed pipe diagnostic until a fresh tunnel reaches ready", async () => {
    const sockets: StubWebSocket[] = [];
    const expectedNonce = "c".repeat(32);
    const onPublicationStateChanged = vi.fn();
    const latestBridgeSockets = (connectionId: string): {
      pipe: StubWebSocket;
      local: StubWebSocket;
    } => {
      const [pipe, local] = sockets.slice(-2);
      if (!pipe || !local) throw new Error(`missing bridge sockets for ${connectionId}`);
      expect(pipe.url).toContain(`/pipe/${connectionId}`);
      expect(local.url).toBe("ws://127.0.0.1:8787");
      return { pipe, local };
    };
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
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(),
      loopbackProbe,
      onPublicationStateChanged,
      reconnectBackoffMs: () => 0,
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      const control = sockets[0];
      control.open();
      await vi.waitFor(() => expect(service.getStatus().relayBridgeValidated).toBe(true));
      expect(loopbackProbe).toHaveBeenCalledOnce();

      control.receive(epochOpen(control.url, "abcdef10"));
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      const cancelledBridge = latestBridgeSockets("abcdef10");
      cancelledBridge.pipe.remoteClose(1000, "candidate cancelled");
      await vi.waitFor(() => expect(service.getStatus().activeTunnels).toBe(0));
      expect(service.getStatus()).toMatchObject({
        lastError: null,
        bridgeOpenFailure: null,
      });
      expect(onPublicationStateChanged).not.toHaveBeenCalled();

      control.receive(epochOpen(control.url, "abcdef11"));
      await vi.waitFor(() => expect(sockets).toHaveLength(5));
      const failedBridge = latestBridgeSockets("abcdef11");
      failedBridge.pipe.emit("error", new Error("injected relay pipe open failure"));

      const failedAt = service.getStatus().lastFailureAt;
      expect(service.getStatus()).toMatchObject({
        connected: true,
        relayBridgeValidated: true,
        activeTunnels: 0,
        lastError: "injected relay pipe open failure",
        bridgeOpenFailure: "injected relay pipe open failure",
        lastControlError: null,
      });
      expect(failedAt).not.toBeNull();

      // A cached/proactive loopback probe does not prove that the Relay pipe
      // recovered, so it must not erase the diagnostic or publish success.
      await expect(service.validateCurrentBridge()).resolves.toBe(true);
      expect(loopbackProbe).toHaveBeenCalledOnce();
      expect(service.getStatus().lastError).toBe("injected relay pipe open failure");
      await vi.waitFor(() => {
        expect(onPublicationStateChanged).toHaveBeenCalledOnce();
        expect(onPublicationStateChanged).toHaveBeenLastCalledWith("route-state-changed");
      });

      control.receive(epochOpen(control.url, "abcdef12"));
      await vi.waitFor(() => expect(sockets).toHaveLength(7));
      const recoveredBridge = latestBridgeSockets("abcdef12");
      recoveredBridge.pipe.open();
      recoveredBridge.local.open();

      await vi.waitFor(() => {
        expect(control.sent.map((raw) => JSON.parse(raw) as { t?: string; id?: string }))
          .toContainEqual(expect.objectContaining({ t: "ready", id: "abcdef12" }));
        expect(service.getStatus()).toMatchObject({
          connected: true,
          relayBridgeValidated: true,
          activeTunnels: 1,
          lastError: null,
          bridgeOpenFailure: null,
          lastFailureAt: failedAt,
        });
        expect(onPublicationStateChanged).toHaveBeenCalledTimes(2);
      });

      // A secondary/losing attempt cannot poison the route while another
      // tunnel is already carrying authenticated traffic.
      control.receive(epochOpen(control.url, "abcdef13"));
      await vi.waitFor(() => expect(sockets).toHaveLength(9));
      const secondaryBridge = latestBridgeSockets("abcdef13");
      secondaryBridge.pipe.emit("error", new Error("secondary pipe failure"));
      expect(service.getStatus()).toMatchObject({
        connected: true,
        relayBridgeValidated: true,
        activeTunnels: 1,
        lastError: null,
        bridgeOpenFailure: null,
      });
      expect(onPublicationStateChanged).toHaveBeenCalledTimes(2);

      // Ready data tunnels can outlive their control socket. They prove only
      // their own generation and must not mask a new-generation setup failure.
      control.remoteClose();
      await vi.waitFor(() => expect(sockets).toHaveLength(10));
      const replacementControl = sockets.at(-1);
      if (!replacementControl) throw new Error("missing replacement control socket");
      replacementControl.open();
      await vi.waitFor(() => {
        expect(loopbackProbe).toHaveBeenCalledTimes(2);
        expect(service.getStatus().relayBridgeValidated).toBe(true);
      });
      replacementControl.receive(epochOpen(replacementControl.url, "abcdef14"));
      await vi.waitFor(() => expect(sockets).toHaveLength(12));
      const replacementBridge = latestBridgeSockets("abcdef14");
      replacementBridge.pipe.emit("error", new Error("new-generation pipe failure"));
      expect(service.getStatus()).toMatchObject({
        connected: true,
        relayBridgeValidated: true,
        activeTunnels: 1,
        lastError: "new-generation pipe failure",
        bridgeOpenFailure: "new-generation pipe failure",
      });
      await vi.waitFor(() => expect(onPublicationStateChanged).toHaveBeenCalledTimes(3));
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("closes both tunnel sides with 4509 when Node's live send queue is full", async () => {
    const sockets: StubWebSocket[] = [];
    const expectedNonce = "c".repeat(32);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => expectedNonce,
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: fakeStore(),
      loopbackProbe: async (port) => ({
        ok: true,
        port,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      }),
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      const control = sockets[0];
      control.open();
      await vi.waitFor(() => expect(service.getStatus().relayBridgeValidated).toBe(true));
      control.receive(epochOpen(control.url, "abcdef05"));
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      const pipe = sockets.find((socket) => socket.url.includes("/pipe/"));
      const local = sockets.find((socket) => socket.url === "ws://127.0.0.1:8787");
      expect(pipe).toBeTruthy();
      expect(local).toBeTruthy();

      pipe!.open();
      local!.open();
      expect(control.sent.map((raw) => JSON.parse(raw) as { t?: string }))
        .toContainEqual(expect.objectContaining({ t: "ready" }));
      local!.bufferedAmount = MAX_BUFFERED_TUNNEL_BYTES;
      pipe!.receive("must-not-grow-the-node-queue");

      await vi.waitFor(() => {
        expect(pipe!.readyState).toBe(WebSocket.CLOSED);
        expect(local!.readyState).toBe(WebSocket.CLOSED);
      });
      expect(pipe!.closes).toContainEqual({
        code: RELAY_CLOSE_FORWARD_FAILED,
        reason: "bridge send buffer overflow",
      });
      expect(local!.closes).toContainEqual({
        code: RELAY_CLOSE_FORWARD_FAILED,
        reason: "bridge send buffer overflow",
      });
      expect(local!.sent).toEqual([]);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
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

  it("retries epoch registration after a control connect timeout", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const sockets: StubWebSocket[] = [];
    const logger = { info: vi.fn() };
    const service = createSyncTunnelClientService({
      logger,
      getSyncPort: () => null,
      getRelayBridgeProof: () => null,
      configStore: fakeStore(),
      reconnectBackoffMs: () => 0,
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      expect(sockets).toHaveLength(1);
      expect(new URL(sockets[0].url).searchParams.has("epoch")).toBe(true);

      await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS);
      await vi.advanceTimersByTimeAsync(1);

      expect(sockets).toHaveLength(2);
      expect(new URL(sockets[1].url).searchParams.has("epoch")).toBe(true);
      expect(logger.info).not.toHaveBeenCalledWith(
        "sync_tunnel.transport_fallback",
        expect.anything(),
      );
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("resets reconnect backoff only after a stable validated control-ready interval", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const expectedNonce = "c".repeat(32);
    const makeService = (stableMs: number, logger?: { info: ReturnType<typeof vi.fn> }) => {
      const sockets: StubWebSocket[] = [];
      const attempts: number[] = [];
      const service = createSyncTunnelClientService({
        logger,
        getSyncPort: () => 8787,
        getExpectedLoopbackNonce: () => expectedNonce,
        getRelayBridgeProof: () => "e".repeat(43),
        configStore: fakeStore(),
        loopbackProbe: async (port) => ({
          ok: true,
          port,
          statusCode: 426,
          statusMessage: "Upgrade Required",
          markerValue: expectedNonce,
          checkedAt: new Date().toISOString(),
          reason: null,
        }),
        controlReadyStableMs: stableMs,
        reconnectBackoffMs: (attempt) => {
          attempts.push(attempt);
          return 0;
        },
        createWebSocket: (url) => {
          const socket = new StubWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });
      return { service, sockets, attempts };
    };

    const flapping = makeService(60_000);
    const stableLogger = { info: vi.fn() };
    const stable = makeService(0, stableLogger);
    try {
      await flapping.service.start();
      flapping.sockets[0].open();
      flapping.sockets[0].remoteClose();
      await vi.waitFor(() => expect(flapping.sockets).toHaveLength(2));
      flapping.sockets[1].open();
      flapping.sockets[1].remoteClose();
      await vi.waitFor(() => expect(flapping.attempts).toEqual([0, 1]));

      await stable.service.start();
      stable.sockets[0].open();
      stable.sockets[0].remoteClose();
      await vi.waitFor(() => expect(stable.sockets).toHaveLength(2));
      stable.sockets[1].open();
      await vi.waitFor(() => {
        expect(stableLogger.info).toHaveBeenCalledWith(
          "sync_tunnel.control_ready",
          expect.objectContaining({ transportMode: "epoch" }),
        );
      });
      stable.sockets[1].remoteClose();
      await vi.waitFor(() => expect(stable.attempts).toEqual([0, 0]));

      expect(flapping.sockets.slice(0, 2).every((socket) => socket.url.includes("epoch="))).toBe(true);
      expect(stable.sockets.slice(0, 2).every((socket) => socket.url.includes("epoch="))).toBe(true);
    } finally {
      await flapping.service.dispose();
      await stable.service.dispose();
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
    const onPublicationStateChanged = vi.fn();
    const store = fakeStore(`http://127.0.0.1:${relayPort}`);
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => "f".repeat(32),
      getRelayBridgeProof: () => "e".repeat(43),
      configStore: store,
      onPublicationStateChanged,
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
      expect(onPublicationStateChanged).not.toHaveBeenCalled();
      pendingUpgrade.release?.();
      delete pendingUpgrade.release;
      await vi.waitFor(() => expect(service.getStatus().connected).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(store.getMachineIdentity().machineKey).toBe("c".repeat(32));
      expect(service.getStatus().machineKey).toBe("c".repeat(32));
      await vi.waitFor(() => {
        expect(onPublicationStateChanged).toHaveBeenCalledOnce();
        expect(onPublicationStateChanged).toHaveBeenCalledWith("identity-rotated");
      });
    } finally {
      pendingUpgrade.release?.();
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("claims again when another process rotates the shared identity", async () => {
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const address = relay.address();
    const relayPort = typeof address === "object" && address ? address.port : 0;
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    let identity = { machineKey: "a".repeat(32), secret: "b".repeat(48) };
    const configStore = {
      getConfig: () => ({ ...identity, relayUrl }),
      getMachineIdentity: () => identity,
      getRelayUrl: () => relayUrl,
      setRelayUrl: () => ({ ...identity, relayUrl }),
      getRelayWssUrl: () => `ws://127.0.0.1:${relayPort}/connect/${identity.machineKey}`,
      rotateMachineIdentity: () => ({ ...identity, relayUrl }),
    } as unknown as SyncCloudRelayStore;
    const controlPaths: string[] = [];
    relay.on("connection", (socket, request) => {
      controlPaths.push(request.url ?? "");
      if (controlPaths.length === 1) {
        identity = { machineKey: "c".repeat(32), secret: "d".repeat(48) };
        socket.close(1012, "External identity rotation");
      }
    });
    const originalFetch = globalThis.fetch;
    const claimUrls: string[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      claimUrls.push(String(input));
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = fetchMock;
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const service = createSyncTunnelClientService({
      getSyncPort: () => 8787,
      getExpectedLoopbackNonce: () => "f".repeat(32),
      getRelayBridgeProof: () => "e".repeat(43),
      configStore,
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
      await vi.waitFor(() => {
        expect(controlPaths).toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      expect(claimUrls).toEqual([
        `${relayUrl}/machines/${"a".repeat(32)}/claim`,
        `${relayUrl}/machines/${"c".repeat(32)}/claim`,
      ]);
      expect(controlPaths).toEqual([
        expect.stringContaining(`/host/${"a".repeat(32)}`),
        expect.stringContaining(`/host/${"c".repeat(32)}`),
      ]);
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
        socket.send(epochOpen(request.url, "abcdef01"));
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
        expect(controlMessages).toContainEqual(expect.objectContaining({
          t: "reject",
          id: "abcdef01",
          code: RELAY_CLOSE_BRIDGE_REJECTED,
          reason: "bridge validation failed",
        }));
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
        socket.send(epochOpen(request.url, "abcdef01"));
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
        expect(controlMessages).toContainEqual(expect.objectContaining({
          t: "reject",
          id: "abcdef01",
          code: RELAY_CLOSE_HOST_UNAVAILABLE,
          reason: "host sync listener unavailable",
        }));
      });
      expect(connections.some((url) => url.includes("/pipe/abcdef01"))).toBe(true);
      expect(service.getStatus().activeTunnels).toBe(0);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("coalesces 16 shuffled concurrent opens onto one listener-generation validation", async () => {
    const local = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      local.once("listening", resolve);
      local.once("error", reject);
    });
    const localAddress = local.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;
    let localConnections = 0;
    local.on("connection", () => {
      localConnections += 1;
    });

    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      relay.once("listening", resolve);
      relay.once("error", reject);
    });
    const relayAddress = relay.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
    let controlSocket: WebSocket | null = null;
    let controlUrl: string | undefined;
    let pipeConnections = 0;
    const pipeUrls: string[] = [];
    const controlMessages: Array<{ t?: string; id?: string; epoch?: string }> = [];
    relay.on("connection", (socket, request) => {
      if (request.url?.includes("/pipe/")) {
        pipeConnections += 1;
        pipeUrls.push(request.url);
      } else {
        controlSocket = socket;
        controlUrl = request.url;
        socket.on("message", (raw) => {
          controlMessages.push(JSON.parse(raw.toString()) as { t?: string; id?: string; epoch?: string });
        });
      }
    });

    const expectedNonce = "c".repeat(32);
    let finishProbe!: (result: SyncLoopbackProbeResult) => void;
    const probe = new Promise<SyncLoopbackProbeResult>((resolve) => {
      finishProbe = resolve;
    });
    const loopbackProbe = vi.fn(async (): Promise<SyncLoopbackProbeResult> => await probe);
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
        expect(controlSocket).not.toBeNull();
        expect(loopbackProbe).toHaveBeenCalledOnce();
      });
      const shuffled = [7, 2, 15, 0, 11, 4, 9, 1, 14, 6, 12, 3, 10, 5, 13, 8]
        .map((value) => value.toString(16).padStart(8, "0"));
      for (const connectionId of shuffled) {
        (controlSocket as unknown as WebSocket).send(epochOpen(controlUrl, connectionId));
      }
      expect(pipeConnections).toBe(0);
      expect(localConnections).toBe(0);
      expect(service.getStatus().activeTunnels).toBe(0);

      finishProbe({
        ok: true,
        port: localPort,
        statusCode: 426,
        statusMessage: "Upgrade Required",
        markerValue: expectedNonce,
        checkedAt: new Date().toISOString(),
        reason: null,
      });
      await vi.waitFor(() => {
        expect(pipeConnections).toBe(16);
        expect(localConnections).toBe(16);
        expect(controlMessages.filter((message) => message.t === "ready")).toHaveLength(16);
      });
      expect(loopbackProbe).toHaveBeenCalledOnce();
      expect(new Set(controlMessages.map((message) => message.id))).toEqual(new Set(shuffled));
      const controlEpoch = epochFromControlUrl(controlUrl);
      expect(controlMessages.every((message) => message.epoch === controlEpoch)).toBe(true);
      expect(pipeUrls.every(
        (url) => new URL(url, "http://relay.invalid").searchParams.get("epoch") === controlEpoch,
      )).toBe(true);
      expect(service.getStatus().activeTunnels).toBe(16);
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });

  it("invalidates the validation lease on listener, account, and control generation changes", async () => {
    expect(BRIDGE_VALIDATION_LEASE_MS).toBe(2_000);
    const sockets: StubWebSocket[] = [];
    let port = 8787;
    let nonce = "c".repeat(32);
    let signedIn = true;
    const loopbackProbe = vi.fn(async (receivedPort: number, receivedNonce: string) => ({
      ok: true as const,
      port: receivedPort,
      statusCode: 426,
      statusMessage: "Upgrade Required",
      markerValue: receivedNonce,
      checkedAt: new Date().toISOString(),
      reason: null,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const service = createSyncTunnelClientService({
      getSyncPort: () => port,
      getExpectedLoopbackNonce: () => nonce,
      getRelayBridgeProof: () => "e".repeat(43),
      isAccountSignedIn: () => signedIn,
      configStore: fakeStore(),
      loopbackProbe,
      reconnectBackoffMs: () => 0,
      createWebSocket: (url) => {
        const socket = new StubWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      await service.start();
      sockets[0].open();
      await vi.waitFor(() => expect(loopbackProbe).toHaveBeenCalledTimes(1));
      await expect(service.validateCurrentBridge()).resolves.toBe(true);
      expect(loopbackProbe).toHaveBeenCalledTimes(1);

      nonce = "d".repeat(32);
      await expect(service.validateCurrentBridge()).resolves.toBe(true);
      port = 8788;
      await expect(service.validateCurrentBridge()).resolves.toBe(true);
      expect(loopbackProbe).toHaveBeenCalledTimes(3);

      signedIn = false;
      await expect(service.validateCurrentBridge()).resolves.toBe(false);
      signedIn = true;
      await expect(service.validateCurrentBridge()).resolves.toBe(true);
      expect(loopbackProbe).toHaveBeenCalledTimes(4);

      sockets[0].remoteClose();
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1].open();
      await vi.waitFor(() => {
        expect(loopbackProbe).toHaveBeenCalledTimes(5);
        expect(service.getStatus().relayBridgeValidated).toBe(true);
      });
    } finally {
      await service.dispose();
      globalThis.fetch = originalFetch;
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
    let controlUrl: string | undefined;
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
        controlUrl = request.url;
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
      (controlSocket as unknown as WebSocket).send(epochOpen(controlUrl, "abcdef01"));
      await vi.waitFor(() => {
        expect(pipeSockets).toHaveLength(1);
        expect(localSockets).toHaveLength(1);
      });
      localSockets[0]?.close(4666, "local app close");
      await vi.waitFor(() => {
        expect(pipeCloses[0]).toEqual({ code: 4666, reason: "local app close" });
      });

      (controlSocket as unknown as WebSocket).send(epochOpen(controlUrl, "abcdef02"));
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

  it("closes both bridge sides with a recoverable reason when Node forwarding fails", async () => {
    const local = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      local.once("listening", resolve);
      local.once("error", reject);
    });
    const localAddress = local.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;
    const localCloses: Array<{ code: number; reason: string }> = [];
    local.on("connection", (socket) => {
      socket.on("close", (code, reason) => {
        localCloses.push({ code, reason: reason.toString() });
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
    let controlUrl: string | undefined;
    let pipeSocket: WebSocket | null = null;
    const pipeCloses: Array<{ code: number; reason: string }> = [];
    const controlMessages: Array<{ t?: string }> = [];
    relay.on("connection", (socket, request) => {
      if (request.url?.includes("/pipe/")) {
        pipeSocket = socket;
        socket.on("close", (code, reason) => {
          pipeCloses.push({ code, reason: reason.toString() });
        });
      } else {
        controlSocket = socket;
        controlUrl = request.url;
        socket.on("message", (raw) => {
          controlMessages.push(JSON.parse(raw.toString()) as { t?: string });
        });
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
      createWebSocket: (url, options) => {
        const socket = new WebSocket(url, options);
        if (url === `ws://127.0.0.1:${localPort}`) {
          socket.once("open", () => {
            socket.send = (() => {
              throw new Error("injected send failure");
            }) as typeof socket.send;
          });
        }
        return socket;
      },
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(controlSocket).not.toBeNull();
        expect(service.getStatus().relayBridgeValidated).toBe(true);
      });
      (controlSocket as unknown as WebSocket).send(epochOpen(controlUrl, "abcdef01"));
      await vi.waitFor(() => {
        expect(pipeSocket).not.toBeNull();
        expect(controlMessages).toContainEqual(expect.objectContaining({ t: "ready" }));
      });

      (pipeSocket as unknown as WebSocket).send(Buffer.from("must-not-drop"));
      await vi.waitFor(() => {
        expect(pipeCloses).toContainEqual({
          code: RELAY_CLOSE_FORWARD_FAILED,
          reason: "bridge forwarding failed",
        });
        expect(localCloses).toContainEqual({
          code: RELAY_CLOSE_FORWARD_FAILED,
          reason: "bridge forwarding failed",
        });
      });
      expect(service.getStatus().activeTunnels).toBe(0);
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
        socket.send(epochOpen(request.url, "abcdef01"));
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

  it("bridges a bare legacy open after one ready-v2 negotiation fallback", async () => {
    const local = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      local.once("listening", resolve);
      local.once("error", reject);
    });
    const localAddress = local.address();
    const localPort = typeof localAddress === "object" && localAddress ? localAddress.port : 0;
    const localFrames: string[] = [];
    let localConnections = 0;
    local.on("connection", (socket) => {
      localConnections += 1;
      socket.on("message", (raw) => localFrames.push(raw.toString()));
    });

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
    const relayAddress = server.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;
    const upgradeUrls: string[] = [];
    const controlMessages: Array<{ t?: string }> = [];
    const issuedControlOpens: Array<Record<string, unknown>> = [];
    let pipeSocket: WebSocket | null = null;
    server.on("upgrade", (request, socket, head) => {
      upgradeUrls.push(request.url ?? "");
      if (new URL(request.url ?? "/", "http://relay.invalid").searchParams.has("epoch")) {
        socket.end([
          "HTTP/1.1 401 Unauthorized",
          "Content-Type: text/plain",
          "Content-Length: 13",
          "Connection: close",
          "",
          "legacy worker",
        ].join("\r\n"));
        return;
      }
      relay.handleUpgrade(request, socket, head, (ws) => relay.emit("connection", ws, request));
    });
    relay.on("connection", (socket, request) => {
      if (request.url?.includes("/pipe/")) {
        pipeSocket = socket;
        return;
      }
      socket.on("message", (raw) => {
        controlMessages.push(JSON.parse(raw.toString()) as { t?: string });
      });
      const bareLegacyOpen = { t: "open", id: "abcdef01" };
      issuedControlOpens.push(bareLegacyOpen);
      socket.send(JSON.stringify(bareLegacyOpen));
    });

    const expectedNonce = "c".repeat(32);
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
      reconnectBackoffMs: () => 0,
    });

    try {
      await service.start();
      await vi.waitFor(() => {
        expect(pipeSocket).not.toBeNull();
        expect(localConnections).toBe(1);
      });
      (pipeSocket as unknown as WebSocket).send("legacy hello");
      await vi.waitFor(() => expect(localFrames).toEqual(["legacy hello"]));

      expect(upgradeUrls).toHaveLength(3);
      expect(new URL(upgradeUrls[0], "http://relay.invalid").searchParams.has("epoch")).toBe(true);
      expect(new URL(upgradeUrls[1], "http://relay.invalid").searchParams.has("epoch")).toBe(false);
      expect(new URL(upgradeUrls[2], "http://relay.invalid").searchParams.has("epoch")).toBe(false);
      expect(issuedControlOpens).toEqual([{ t: "open", id: "abcdef01" }]);
      expect(controlMessages.some((message) => message.t === "ready")).toBe(false);
    } finally {
      await service.dispose();
      await new Promise<void>((resolve) => local.close(() => resolve()));
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
        socket.send(epochOpen(request.url, "abcdef01"));
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
