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
  DesktopBridgeUnavailableError,
  verifyBuiltInBrowserDesktopBridgeAuth,
} from "./desktopBridgeClient";
import { BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM } from "./desktopBridgeMethods";
import type { BuiltInBrowserDesktopBridgeClient } from "./desktopBridgeMethods";
import {
  createRemoteBrowserForwarder,
  withRemoteBrowserForwarding,
} from "./remoteBrowserForwarder";

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

  it("rejects missing authentication without dropping a bridge connection", async () => {
    server = await startBridgeServer(async () => ({ ok: true }));
    let authToken: string | null = null;
    const warn = vi.fn();
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      getAuthToken: () => authToken,
      logger: { ...silentLogger(), warn },
    });

    // A desktop IS listening here, so a missing token is a real
    // desktop-side fault and keeps its own message — it must NOT be reported
    // as "no desktop attached", which would send `ade browser open` off to a
    // remote desktop while a local one is right there.
    const authFailure = await client.getStatus().then(
      () => null,
      (error: unknown) => error,
    );
    expect(authFailure).toBeInstanceOf(Error);
    expect((authFailure as Error).message).toMatch(/authentication is unavailable/);
    expect(authFailure).not.toBeInstanceOf(DesktopBridgeUnavailableError);
    expect(warn).not.toHaveBeenCalled();

    authToken = "bridge-auth";
    await expect(client.getStatus()).resolves.toEqual({ ok: true });
    expect(server.connectionCount()).toBe(1);

    authToken = null;
    await expect(client.getStatus()).rejects.toThrow(/authentication is unavailable/);
    // The unauthenticated call reuses the cached connection rather than
    // reconnecting, and must not tear it down for the next authenticated one.
    expect(server.connectionCount()).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    authToken = "bridge-auth";
    await expect(client.getStatus()).resolves.toEqual({ ok: true });
    expect(server.connectionCount()).toBe(1);
    client.dispose();
  });

  it("reports a headless machine as bridge-unavailable even when the token is also missing", async () => {
    const missingPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-bridge-test-headless-")),
      "absent.sock",
    );
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: missingPath,
      // A machine with no desktop has no token either: the desktop is what
      // sets it. The absent socket, not the absent token, is what decides.
      getAuthToken: () => null,
      logger: silentLogger(),
    });
    await expect(client.navigate({ url: "http://localhost:4567" })).rejects.toBeInstanceOf(
      DesktopBridgeUnavailableError,
    );
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
      /No ADE Desktop browser is attached to this machine/,
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

const forwarderLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof createRemoteBrowserForwarder>[0]["logger"];

async function unavailable(): Promise<never> {
  throw new DesktopBridgeUnavailableError("/sock/desktop-bridge.sock", "no desktop here");
}

function makeBridge(overrides: Record<string, unknown> = {}): BuiltInBrowserDesktopBridgeClient {
  return {
    navigate: vi.fn(unavailable),
    createTab: vi.fn(unavailable),
    showPanel: vi.fn(unavailable),
    observe: vi.fn(unavailable),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as BuiltInBrowserDesktopBridgeClient;
}

describe("remote browser forwarder", () => {
  it("carries `awaitingApproval` back so the CLI does not report a live request as failed", async () => {
    // A first-use tunnel port needs a human "Allow" on the desktop, which
    // cannot land inside the 5s ack window. The desktop acks immediately as
    // awaiting-approval and navigates later; without this the CLI printed
    // "no desktop is attached" for a request that was about to succeed.
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        const request = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.acknowledgeRemoteRequest({
            requestId: request.requestId,
            desktopLabel: "Studio",
            accepted: true,
            awaitingApproval: true,
          });
        });
      },
      logger: forwarderLogger,
      ackTimeoutMs: 500,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    const result = await bridge.navigate({ url: "http://localhost:3000/" } as never) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "forwarded_to_desktop",
      acknowledged: true,
      awaitingApproval: true,
      desktopLabel: "Studio",
    });
  });

  it("omits `awaitingApproval` when the desktop navigated straight away", async () => {
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        const request = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.acknowledgeRemoteRequest({ requestId: request.requestId, accepted: true });
        });
      },
      logger: forwarderLogger,
      ackTimeoutMs: 500,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);
    const result = await bridge.navigate({ url: "http://localhost:3000/" } as never) as Record<string, unknown>;
    expect(result.acknowledged).toBe(true);
    expect(result).not.toHaveProperty("awaitingApproval");
  });

  it("forwards a headless `browser open` as a runtime event and reports the ack", async () => {
    const events: Record<string, unknown>[] = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        events.push(payload);
        // A desktop holding a remote pin on this machine takes the request.
        const request = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.acknowledgeRemoteRequest({
            requestId: request.requestId,
            desktopLabel: "This computer",
            accepted: true,
          });
        });
      },
      logger: forwarderLogger,
      ackTimeoutMs: 500,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    const result = await bridge.navigate({
      url: "http://localhost:3000/",
      laneId: "lane-1",
      chatSessionId: "chat-1",
    } as never) as Record<string, unknown>;

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("built_in_browser_remote_request");
    expect(events[0].event).toMatchObject({
      url: "http://localhost:3000/",
      laneId: "lane-1",
      chatSessionId: "chat-1",
      openPanel: true,
    });
    expect(result).toMatchObject({
      status: "forwarded_to_desktop",
      url: "http://localhost:3000/",
      acknowledged: true,
      desktopLabel: "This computer",
    });
    expect(typeof result.requestId).toBe("string");
  });

  it("stops waiting when no desktop answers, instead of failing the command", async () => {
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: () => {},
      logger: forwarderLogger,
      ackTimeoutMs: 10,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    const result = await bridge.createTab({ url: "http://127.0.0.1:5173/" } as never);

    expect(result).toMatchObject({
      status: "forwarded_to_desktop",
      acknowledged: false,
      desktopLabel: null,
    });
  });

  it("carries a desktop's refusal back so the CLI can say why", async () => {
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        const request = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.acknowledgeRemoteRequest({
            requestId: request.requestId,
            desktopLabel: "This computer",
            accepted: false,
            reason: "Reaching port 8080 on Mac Studio was not allowed.",
          });
        });
      },
      logger: forwarderLogger,
      ackTimeoutMs: 500,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    const result = await bridge.showPanel({ url: "http://localhost:8080/" } as never);

    expect(result).toMatchObject({
      acknowledged: false,
      reason: "Reaching port 8080 on Mac Studio was not allowed.",
    });
  });

  it("leaves tab-scoped actions failing, and passes a working bridge straight through", async () => {
    const forwarder = createRemoteBrowserForwarder({ emitEvent: () => {}, logger: forwarderLogger });
    const navigate = vi.fn(async () => ({ attached: true }));
    const bridge = withRemoteBrowserForwarding(makeBridge({ navigate }), forwarder);

    // `observe` acts on a specific live tab; no other desktop can stand in.
    await expect(bridge.observe({} as never)).rejects.toThrow(DesktopBridgeUnavailableError);
    // With a desktop attached here, nothing is forwarded.
    await expect(bridge.navigate({ url: "http://localhost:3000/" } as never))
      .resolves.toEqual({ attached: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("forwards from a real headless runtime, where the bridge token is missing too", async () => {
    // Regression: the client read the auth token before it ever touched the
    // socket. On a machine with no desktop the token is null too, so the call
    // died with a plain Error, `forwardIfNoDesktop` did not recognise it, and
    // `ade browser open` failed on exactly the runtime the forwarder exists
    // for. Uses the REAL bridge client — the fake in `makeBridge` cannot show
    // which error class the token check produces.
    const missingPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-bridge-test-forward-")),
      "absent.sock",
    );
    const emitted: Record<string, unknown>[] = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        emitted.push(payload);
        const request = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.acknowledgeRemoteRequest({
            requestId: request.requestId,
            desktopLabel: "Studio",
            accepted: true,
            awaitingApproval: true,
          });
        });
      },
      logger: forwarderLogger,
      ackTimeoutMs: 500,
    });
    const headless = createBuiltInBrowserDesktopBridgeClient({
      socketPath: missingPath,
      getAuthToken: () => null,
      logger: silentLogger(),
    });
    const bridge = withRemoteBrowserForwarding(headless, forwarder);

    const result = await bridge.navigate({
      url: "http://localhost:4567/",
    } as never) as Record<string, unknown>;

    expect(emitted).toHaveLength(1);
    expect(result).toMatchObject({
      status: "forwarded_to_desktop",
      url: "http://localhost:4567/",
      acknowledged: true,
      awaitingApproval: true,
      desktopLabel: "Studio",
    });
    headless.dispose();
  });

  it("ignores an acknowledgement for a request nobody is waiting on", () => {
    const forwarder = createRemoteBrowserForwarder({ emitEvent: () => {}, logger: forwarderLogger });
    expect(forwarder.acknowledgeRemoteRequest({ requestId: "bbr-gone" })).toEqual({ ok: false });
    expect(forwarder.acknowledgeRemoteRequest({})).toEqual({ ok: false });
  });
});
