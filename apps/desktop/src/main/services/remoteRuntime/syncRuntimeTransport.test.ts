import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { DesktopPairedMachineCredentials } from "../../../shared/types/pairedRuntime";
import {
  encodeSyncEnvelope,
  parseSyncEnvelope,
  SYNC_RUNTIME_ONLY_CAPABILITY,
  wsDataToText,
} from "../sync/syncProtocol";
import { RuntimeRpcClient } from "./runtimeRpcClient";
import {
  buildDesktopPairedHello,
  openSyncEnvelopeConnection,
  openSyncRuntimeTransport,
  withSyncRelayCorrelationId,
} from "./syncRuntimeTransport";

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;

  constructor(
    private readonly onSend: (text: string, ws: FakeWebSocket) => void,
    autoOpen = true,
  ) {
    super();
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
  }

  send(data: string | Buffer): void {
    this.onSend(data.toString(), this);
  }

  receive(text: string): void {
    queueMicrotask(() => this.emit("message", Buffer.from(text, "utf8")));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
}

function credentials(): DesktopPairedMachineCredentials {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]).toString("base64");
  return {
    version: 1,
    hostIdentity: {
      deviceId: "host-1",
      siteId: "host-site-1",
      name: "Mac Studio",
      platform: "macOS",
      deviceType: "desktop",
    },
    machineKey: null,
    deviceId: "desktop-1",
    siteId: "desktop-site-1",
    deviceName: "My Mac",
    secret: "paired-secret",
    dpopPrivateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    dpopPublicKey: publicKey,
    endpoints: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("openSyncRuntimeTransport", () => {
  it("adds a validated correlation id without changing the stored endpoint", async () => {
    const correlationId = "123e4567-e89b-42d3-a456-426614174000";
    let openedEndpoint = "";
    const connection = await openSyncEnvelopeConnection({
      endpoint: "wss://relay.example/connect/machine?ready=2",
      correlationId,
      createWebSocket: (endpoint) => {
        openedEndpoint = endpoint;
        return new FakeWebSocket(() => {}) as unknown as WebSocket;
      },
    });

    expect(openedEndpoint).toBe(
      "wss://relay.example/connect/machine?ready=2&cid=123e4567-e89b-42d3-a456-426614174000",
    );
    expect(connection.endpoint).toBe("wss://relay.example/connect/machine?ready=2");
    connection.close();
    expect(() => withSyncRelayCorrelationId(
      "wss://relay.example/connect/machine",
      "not-a-correlation-id",
    )).toThrow("canonical UUID v4");
  });

  it("adds an ephemeral account proof only to the relay hello", () => {
    const paired = credentials();
    const hello = buildDesktopPairedHello(
      paired,
      "1.2.3",
      "short-lived-clerk-token",
    );

    expect(hello.auth).toMatchObject({
      kind: "paired",
      relayAccountToken: "short-lived-clerk-token",
    });
    expect(paired).not.toHaveProperty("relayAccountToken");
  });

  it("does not construct a WebSocket for an already-cancelled attempt", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before connect"));
    let constructed = false;

    await expect(openSyncEnvelopeConnection({
      endpoint: "ws://offline.test",
      signal: controller.signal,
      createWebSocket: () => {
        constructed = true;
        return new FakeWebSocket(() => {}) as unknown as WebSocket;
      },
    })).rejects.toThrow("cancel before connect");
    expect(constructed).toBe(false);
  });

  it("cancels a paired WebSocket attempt that never opens", async () => {
    const controller = new AbortController();
    const socket = new FakeWebSocket(() => {}, false);
    const opening = openSyncEnvelopeConnection({
      endpoint: "ws://offline.test",
      connectTimeoutMs: 30_000,
      signal: controller.signal,
      createWebSocket: () => socket as unknown as WebSocket,
    });

    controller.abort(new Error("cancel offline target"));

    await expect(opening).rejects.toThrow("cancel offline target");
    expect(socket.readyState).toBe(3);
  });

  it("cancels a paired authentication wait after the WebSocket opens", async () => {
    const controller = new AbortController();
    const socket = new FakeWebSocket(() => {});
    const paired = credentials();
    const startedAt = Date.now();
    const opening = openSyncRuntimeTransport({
      credentials: paired,
      endpoint: "ws://auth-stall.test",
      connectTimeoutMs: 30_000,
      authTimeoutMs: 30_000,
      signal: controller.signal,
      createWebSocket: () => socket as unknown as WebSocket,
    });

    const timer = setTimeout(() => controller.abort(new Error("cancel stalled authentication")), 25);
    await expect(opening).rejects.toThrow("cancel stalled authentication");
    clearTimeout(timer);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(socket.readyState).toBe(3);
  });

  it("authenticates from saved paired credentials without an account token and opens RPC", async () => {
    let observedHello: Record<string, unknown> | null = null;
    let observedChannelId: string | null = null;
    const createWebSocket = () => new FakeWebSocket((text, ws) => {
        const envelope = parseSyncEnvelope(wsDataToText(text));
        if (envelope.type === "hello") {
          observedHello = envelope.payload as Record<string, unknown>;
          ws.receive(encodeSyncEnvelope({
            type: "hello_ok",
            requestId: envelope.requestId,
            payload: {
              peer: (envelope.payload as { peer: unknown }).peer,
              brain: {
                deviceId: "host-1",
                deviceName: "Mac Studio",
                platform: "macOS",
                deviceType: "desktop",
                siteId: "host-site-1",
                dbVersion: 0,
              },
              serverDbVersion: 0,
              heartbeatIntervalMs: 5_000,
              pollIntervalMs: 1_500,
              features: { rpcChannel: true, portForward: true },
            },
          }));
          return;
        }
        if (envelope.type === "rpc_open") {
          observedChannelId = (envelope.payload as { channelId: string }).channelId;
          return;
        }
        if (envelope.type !== "rpc_data") return;
        const payload = envelope.payload as { channelId: string; data: string };
        const request = JSON.parse(Buffer.from(payload.data, "base64").toString("utf8").trim()) as {
          id: number;
          method: string;
        };
        expect(request.method).toBe("ade/initialize");
        const response = Buffer.from(`${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runtimeInfo: { name: "ade-rpc", multiProject: true } },
        })}\n`, "utf8");
        const split = 23;
        for (const part of [response.subarray(0, split), response.subarray(split)]) {
          ws.receive(encodeSyncEnvelope({
            type: "rpc_data",
            payload: {
              channelId: payload.channelId,
              data: part.toString("base64"),
            },
          }));
        }
    }) as unknown as WebSocket;

    const paired = credentials();
    paired.endpoints = ["ws://sync.test"];
    const transport = await openSyncRuntimeTransport({
      credentials: paired,
      channelId: "runtime-test",
      connectTimeoutMs: 2_000,
      authTimeoutMs: 2_000,
      createWebSocket,
    });
    const client = new RuntimeRpcClient(transport, 2_000);

    await expect(client.initialize("desktop-test", "1.2.3")).resolves.toEqual({
      runtimeInfo: { name: "ade-rpc", multiProject: true },
    });
    expect(observedChannelId).toBe("runtime-test");
    expect(observedHello).toMatchObject({
      peer: {
        deviceType: "desktop",
        deviceId: "desktop-1",
        capabilities: expect.arrayContaining([SYNC_RUNTIME_ONLY_CAPABILITY]),
      },
      auth: {
        kind: "paired",
        deviceId: "desktop-1",
        secret: "paired-secret",
        dpop: {
          publicKey: paired.dpopPublicKey,
          timestamp: expect.any(Number),
          nonce: expect.any(String),
          signature: expect.any(String),
        },
      },
    });
    expect((observedHello as unknown as { auth?: Record<string, unknown> }).auth).not.toHaveProperty(
      "accountToken",
    );
    client.close();
    expect(transport.connection.endpoint).toBe("ws://sync.test/");
    expect(transport.connection).toBeDefined();
  });

  it("rejects a saved endpoint when the host identity changed", async () => {
    const socket = new FakeWebSocket((text, ws) => {
      const envelope = parseSyncEnvelope(wsDataToText(text));
      if (envelope.type !== "hello") return;
      ws.receive(encodeSyncEnvelope({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: {
          peer: (envelope.payload as { peer: unknown }).peer,
          brain: {
            deviceId: "replacement-host",
            deviceName: "Different Mac",
            platform: "macOS",
            deviceType: "desktop",
            siteId: "replacement-site",
            dbVersion: 0,
          },
          serverDbVersion: 0,
          heartbeatIntervalMs: 5_000,
          pollIntervalMs: 1_500,
          features: { rpcChannel: true, portForward: true },
        },
      }));
    });

    await expect(openSyncRuntimeTransport({
      credentials: credentials(),
      endpoint: "ws://replacement.test",
      createWebSocket: () => socket as unknown as WebSocket,
    })).rejects.toThrow("Sync endpoint identity mismatch");
    expect(socket.readyState).toBe(3);
  });
});
