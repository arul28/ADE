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
import { openSyncRuntimeTransport } from "./syncRuntimeTransport";

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;

  constructor(private readonly onSend: (text: string, ws: FakeWebSocket) => void) {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
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
  it("authenticates, opens RPC, and lets RuntimeRpcClient parse a response split across rpc_data frames", async () => {
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
    client.close();
    expect(transport.connection.endpoint).toBe("ws://sync.test/");
    expect(transport.connection).toBeDefined();
  });
});
