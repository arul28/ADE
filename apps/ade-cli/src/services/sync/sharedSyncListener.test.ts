import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createSharedSyncListener,
  SYNC_RELAY_BRIDGE_PROOF_HEADER,
} from "./sharedSyncListener";

async function connect(
  port: number,
  path = "/",
  options: { origin?: string; headers?: Record<string, string> } = {},
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin: options.origin,
    headers: options.headers,
  });
  await once(ws, "open");
  return ws;
}

async function reject(
  port: number,
  path: string,
  options: { origin?: string; headers?: Record<string, string> } = {},
): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin: options.origin,
    headers: options.headers,
  });
  ws.on("error", () => {});
  const [, response] = await once(ws, "unexpected-response");
  response.resume();
  return response.statusCode ?? 0;
}

describe("shared sync listener upgrade policy", () => {
  it("accepts only the sync root path", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const port = await listener.ensureListening([0]);
    const accepted = await connect(port, "/");
    try {
      expect(accepted.readyState).toBe(WebSocket.OPEN);
      expect(await reject(port, "/anything")).toBe(400);
      expect(await reject(port, "/connect/machine-key")).toBe(400);
    } finally {
      accepted.terminate();
      await listener.close();
    }
  });

  it("accepts the hosted web and local Vite origins", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const port = await listener.ensureListening([0]);
    const sockets: WebSocket[] = [];
    try {
      for (const origin of [
        "https://app.ade-app.dev",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ]) {
        const ws = await connect(port, "/", { origin });
        sockets.push(ws);
        expect(ws.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      for (const ws of sockets) ws.terminate();
      await listener.close();
    }
  });

  it("accepts no-Origin non-browser and relay-bridge clients", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const port = await listener.ensureListening([0]);
    const origins: string[] = [];
    listener.setConnectionHandler((connection) => {
      origins.push(connection.transportOrigin);
    });
    const direct = await connect(port);
    const relay = await connect(port, "/", {
      headers: {
        [SYNC_RELAY_BRIDGE_PROOF_HEADER]: listener.getRelayBridgeProof(),
      },
    });
    expect(direct.readyState).toBe(WebSocket.OPEN);
    expect(relay.readyState).toBe(WebSocket.OPEN);
    expect(origins).toEqual(["direct", "relay-bridge"]);
    direct.terminate();
    relay.terminate();
    await listener.close();
  });

  it("rejects and logs a foreign browser Origin", async () => {
    const logger = { debug: vi.fn() };
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", logger });
    const port = await listener.ensureListening([0]);
    try {
      expect(await reject(port, "/", { origin: "https://evil.example" })).toBe(401);
      expect(logger.debug).toHaveBeenCalledWith("sync_listener.origin_rejected", {
        origin: "https://evil.example",
      });
      expect(listener.isListening()).toBe(true);
    } finally {
      await listener.close();
    }
  });
});
