import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  computeBackoffMs,
  createSyncTunnelClientService,
  parseControlMessage,
} from "./syncTunnelClientService";
import type { SyncCloudRelayStore } from "./syncCloudRelayStore";
import { createSharedSyncListener } from "./sharedSyncListener";

// syncCloudRelayStore itself (enablement default/migration, identity mint, url
// derivation, signature builders) is covered in syncCloudRelayStore.test.ts.

function fakeStore(enabled: boolean, relayUrl = "https://relay.example.com"): SyncCloudRelayStore {
  const identity = { machineKey: "a".repeat(32), secret: "b".repeat(48) };
  return {
    getConfig: () => ({ enabled, ...identity }),
    isEnabled: () => enabled,
    setEnabled: () => ({ enabled, ...identity }),
    getMachineIdentity: () => identity,
    getRelayUrl: () => relayUrl,
    setRelayUrl: () => ({ enabled, ...identity }),
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

  it("passes ping/pong and rejects junk", () => {
    expect(parseControlMessage(JSON.stringify({ t: "ping" }))).toEqual({ t: "ping" });
    expect(parseControlMessage(JSON.stringify({ t: "pong" }))).toEqual({ t: "pong" });
    expect(parseControlMessage("not json")).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "other" }))).toBeNull();
  });
});

describe("createSyncTunnelClientService", () => {
  it("is a no-op and reports disabled when the store is disabled", async () => {
    const service = createSyncTunnelClientService({
      getSyncPort: () => 12345,
      getRelayBridgeProof: () => null,
      configStore: fakeStore(false),
    });
    await service.start();
    const status = service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.activeTunnels).toBe(0);
    expect(status.machineKey).toBe("a".repeat(32));
    expect(status.relayUrl).toBe("https://relay.example.com");
    await service.dispose();
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
      configStore: fakeStore(true, `http://127.0.0.1:${relayPort}`),
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
      configStore: fakeStore(true),
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
      configStore: fakeStore(true, `http://127.0.0.1:${relayPort}`),
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
      configStore: fakeStore(true, `http://127.0.0.1:${relayPort}`),
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
      configStore: fakeStore(true, `http://127.0.0.1:${relayPort}`),
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
