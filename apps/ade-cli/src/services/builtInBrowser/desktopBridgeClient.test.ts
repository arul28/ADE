import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startJsonRpcServer,
  type JsonRpcRequest,
  type JsonRpcTransport,
} from "../../jsonrpc";
import {
  createBuiltInBrowserDesktopBridgeClient,
  verifyBuiltInBrowserDesktopBridgeAuth,
} from "./desktopBridgeClient";
import { BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM } from "./desktopBridgeMethods";

function silentLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

type ServerHandle = {
  socketPath: string;
  connectionCount: () => number;
  close: () => Promise<void>;
};

function createBridgeSocketPath(prefix = "ade-bridge-test"): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${prefix}-${process.pid}-${randomUUID()}`;
  }
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)),
    "bridge.sock",
  );
}

async function startBridgeServer(
  handler: (request: JsonRpcRequest) => Promise<unknown>,
  socketPath = createBridgeSocketPath(),
): Promise<ServerHandle> {
  const stopHandles = new Set<() => void>();
  const sockets = new Set<net.Socket>();
  let connectionCount = 0;
  const server = net.createServer((conn) => {
    connectionCount += 1;
    sockets.add(conn);
    const transport: JsonRpcTransport = {
      onData: (callback) => conn.on("data", callback),
      write: (data) => conn.write(data),
      close: () => {
        if (!conn.destroyed) conn.destroy();
      },
    };
    const stop = startJsonRpcServer(handler, transport, { nonFatal: true });
    stopHandles.add(stop);
    conn.on("close", () => {
      sockets.delete(conn);
      stopHandles.delete(stop);
      stop();
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    connectionCount: () => connectionCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        for (const stop of stopHandles) {
          try {
            stop();
          } catch {
            // ignore
          }
        }
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // ignore
          }
          resolve();
        });
      }),
  };
}

describe("createBuiltInBrowserDesktopBridgeClient", () => {
  let server: ServerHandle | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("forwards method + params and resolves the JSON-RPC response", async () => {
    const seen: JsonRpcRequest[] = [];
    server = await startBridgeServer(async (request) => {
      seen.push(request);
      if (request.method === "built_in_browser.navigate") {
        return { ok: true, url: (request.params as { url: string }).url };
      }
      throw new Error(`unexpected method: ${request.method}`);
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });
    const result = await client.navigate({ url: "https://example.com" });
    expect(result).toEqual({ ok: true, url: "https://example.com" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("built_in_browser.navigate");
    expect(seen[0]?.params).toEqual({
      url: "https://example.com",
      __adeDesktopBridgeAuth: "bridge-auth",
    });
    client.dispose();
  });

  it("verifies an in-memory desktop bridge credential without persisting it", async () => {
    const seen: JsonRpcRequest[] = [];
    server = await startBridgeServer(async (request) => {
      seen.push(request);
      return { authenticated: true };
    });

    await expect(verifyBuiltInBrowserDesktopBridgeAuth({
      socketPath: server.socketPath,
      authToken: "ephemeral-secret",
    })).resolves.toBe(true);
    expect(seen).toEqual([expect.objectContaining({
      method: "built_in_browser.authenticate",
      params: { __adeDesktopBridgeAuth: "ephemeral-secret" },
    })]);
  });

  it("rejects missing authentication without opening or dropping a bridge connection", async () => {
    server = await startBridgeServer(async () => ({ ok: true }));
    let authToken: string | null = null;
    const warn = vi.fn();
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => authToken,
      logger: { ...silentLogger(), warn },
    });

    await expect(client.getStatus()).rejects.toThrow(/authentication is unavailable/);
    expect(server.connectionCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();

    authToken = "bridge-auth";
    await expect(client.getStatus()).resolves.toEqual({ ok: true });
    expect(server.connectionCount()).toBe(1);

    authToken = null;
    await expect(client.getStatus()).rejects.toThrow(/authentication is unavailable/);
    expect(server.connectionCount()).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    authToken = "bridge-auth";
    await expect(client.getStatus()).resolves.toEqual({ ok: true });
    expect(server.connectionCount()).toBe(1);
    client.dispose();
  });

  it("authenticates no-arg methods", async () => {
    const recorded: JsonRpcRequest[] = [];
    server = await startBridgeServer(async (request) => {
      recorded.push(request);
      return { tabs: [] };
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });
    await client.getStatus();
    expect(recorded[0]?.method).toBe("built_in_browser.getStatus");
    expect(recorded[0]?.params).toEqual({ __adeDesktopBridgeAuth: "bridge-auth" });
    client.dispose();
  });

  it("scopes bridge calls to the runtime project root", async () => {
    const recorded: JsonRpcRequest[] = [];
    server = await startBridgeServer(async (request) => {
      recorded.push(request);
      return { ok: true };
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      projectRoot: "/Users/ade/project-alpha",
      logger: silentLogger(),
    });

    await client.getStatus();
    await client.navigate({ url: "https://example.com", projectRoot: "/tmp/spoof" });

    expect(recorded[0]?.params).toEqual({
      projectRoot: "/Users/ade/project-alpha",
      __adeDesktopBridgeAuth: "bridge-auth",
    });
    expect(recorded[1]?.params).toEqual({
      url: "https://example.com",
      projectRoot: "/Users/ade/project-alpha",
      __adeDesktopBridgeAuth: "bridge-auth",
    });
    client.dispose();
  });

  it("forwards the runtime-bound actor capability while erasing caller routing", async () => {
    const recorded: JsonRpcRequest[] = [];
    server = await startBridgeServer(async (request) => {
      recorded.push(request);
      return { ok: true };
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      projectRoot: "/Users/ade/project-alpha",
      logger: silentLogger(),
    });

    const runtimeScopedNavigate = {
      url: "https://personal.example.test",
      chatSessionId: "chat-personal",
      projectRoot: "/tmp/spoofed-project",
      tabCollection: "personal" as const,
      [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: "opaque-actor-token",
    };
    await client.navigate(runtimeScopedNavigate);

    expect(recorded[0]?.params).toEqual({
      url: "https://personal.example.test",
      chatSessionId: "chat-personal",
      projectRoot: "/Users/ade/project-alpha",
      tabCollection: undefined,
      [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: "opaque-actor-token",
      __adeDesktopBridgeAuth: "bridge-auth",
    });
    client.dispose();
  });

  it("surfaces a clear error when the bridge socket does not exist", async () => {
    const missingPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-bridge-test-missing-")),
      "absent.sock",
    );
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: missingPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });
    await expect(client.getStatus()).rejects.toThrow(
      /Desktop browser bridge not running/,
    );
    client.dispose();
  });

  it("propagates JSON-RPC server errors", async () => {
    server = await startBridgeServer(async () => {
      throw new Error("Browser pane is offline");
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });
    await expect(client.getStatus()).rejects.toThrow(/Browser pane is offline/);
    client.dispose();
  });

  it("reconnects after a transient failure on the next call", async () => {
    let callCount = 0;
    server = await startBridgeServer(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("temporary");
      return { ok: true };
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });
    await expect(client.getStatus()).rejects.toThrow(/temporary/);
    const result = await client.getStatus();
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
    client.dispose();
  });

  it("forgets a cached bridge connection when the socket closes", async () => {
    const socketPath = createBridgeSocketPath("ade-bridge-test-restart");
    let generation = 1;
    server = await startBridgeServer(async () => ({ generation }), socketPath);
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath,
      getAuthToken: () => "bridge-auth",
      logger: silentLogger(),
    });

    await expect(client.getStatus()).resolves.toEqual({ generation: 1 });
    await server.close();
    server = null;

    generation = 2;
    server = await startBridgeServer(async () => ({ generation }), socketPath);

    await expect(client.getStatus()).resolves.toEqual({ generation: 2 });
    client.dispose();
  });
});
