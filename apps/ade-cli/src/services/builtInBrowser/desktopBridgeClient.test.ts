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
  probeDesktopBridge,
} from "./desktopBridgeClient";
import { createDesktopBridgeConnection } from "./desktopBridgeConnection";
import { createScenePreviewBridgeClient } from "./scenePreviewBridgeClient";
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
      logger: silentLogger(),
    });
    const result = await client.navigate({ url: "https://example.com" });
    expect(result).toEqual({ ok: true, url: "https://example.com" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("built_in_browser.navigate");
    expect(seen[0]?.params).toEqual({ url: "https://example.com" });
    client.dispose();
  });

  it("reports a headless machine as bridge-unavailable when no desktop is attached", async () => {
    const missingPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-bridge-test-headless-")),
      "absent.sock",
    );
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: missingPath,
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
      logger: silentLogger(),
    });
    await client.getStatus();
    expect(recorded[0]?.method).toBe("built_in_browser.getStatus");
    expect(recorded[0]?.params).toEqual({});
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
      projectRoot: "/Users/ade/project-alpha",
      logger: silentLogger(),
    });

    await client.getStatus();
    await client.navigate({ url: "https://example.com", projectRoot: "/tmp/spoof" });

    expect(recorded[0]?.params).toEqual({
      projectRoot: "/Users/ade/project-alpha",
    });
    expect(recorded[1]?.params).toEqual({
      url: "https://example.com",
      projectRoot: "/Users/ade/project-alpha",
    });
    client.dispose();
  });

  it("forwards the runtime project scope while erasing caller routing", async () => {
    const recorded: JsonRpcRequest[] = [];
    server = await startBridgeServer(async (request) => {
      recorded.push(request);
      return { ok: true };
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath: server.socketPath,
      projectRoot: "/Users/ade/project-alpha",
      logger: silentLogger(),
    });

    const runtimeScopedNavigate = {
      url: "https://personal.example.test",
      chatSessionId: "chat-personal",
      projectRoot: "/tmp/spoofed-project",
      tabCollection: "personal" as const,
    };
    await client.navigate(runtimeScopedNavigate);

    expect(recorded[0]?.params).toEqual({
      url: "https://personal.example.test",
      chatSessionId: "chat-personal",
      tabCollection: "personal",
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

  it("probes an attached desktop without sending a bridge secret", async () => {
    const recorded: JsonRpcRequest[] = [];
    server = await startBridgeServer(async (request) => {
      recorded.push(request);
      return { authenticated: true };
    });

    await expect(probeDesktopBridge({ socketPath: server.socketPath })).resolves.toEqual({ attached: true });
    expect(recorded).toEqual([expect.objectContaining({
      method: "built_in_browser.authenticate",
      params: {},
    })]);
  });

  it("turns an old desktop's authentication refusal into an update message", async () => {
    server = await startBridgeServer(async () => {
      throw new Error("Desktop bridge authentication failed.");
    });

    await expect(probeDesktopBridge({ socketPath: server.socketPath })).resolves.toEqual({
      attached: false,
      kind: "unreachable",
      reason: "ADE Desktop is older than ADE's background service. Restart ADE Desktop to finish updating.",
    });
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
            desktopLabel: "Studio",
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
      desktopLabel: "Studio",
    });
    expect(typeof result.requestId).toBe("string");
  });

  /**
   * An isolated sign-in exists only in this machine's desktop. Any other
   * desktop would open the page in the user's own sign-in, so an isolated open
   * is refused rather than forwarded, and never mirrored to the user's screen.
   */
  it("never sends an isolated open to another desktop", async () => {
    const events: Record<string, unknown>[] = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => { events.push(payload); },
      logger: forwarderLogger,
      ackTimeoutMs: 10,
    });

    const headless = withRemoteBrowserForwarding(makeBridge(), forwarder);
    await expect(headless.navigate({
      url: "http://localhost:3000/login",
      profile: "viewer",
      chatSessionId: "chat-1",
    } as never)).rejects.toThrow(/isolated tab.*not forwarded/);

    const localNavigate = vi.fn(async () => ({ targetTabId: "tab-1" }));
    const withDesktop = withRemoteBrowserForwarding(makeBridge({ navigate: localNavigate }), forwarder);
    await withDesktop.navigate({
      url: "http://localhost:3000/login",
      isolated: true,
      openPanel: true,
      chatSessionId: "chat-1",
    } as never);

    // The mirror to the user's screen is sent before `navigate` resolves.
    expect(localNavigate).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
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

  it.each([
    {
      label: "`open --panel` while the user talks from another machine",
      origin: { clientId: "macbook", local: false },
      method: "navigate" as const,
      args: { url: "http://localhost:4180/", chatSessionId: "chat-1", openPanel: true },
      localArgs: null,
      forwards: [{ kind: "request", target: "macbook" }],
    },
    {
      label: "`open --panel` while the user is at this machine",
      origin: { clientId: "studio", local: true },
      method: "navigate" as const,
      args: { url: "http://localhost:4180/", chatSessionId: "chat-1", openPanel: true },
      localArgs: { openPanel: true },
      forwards: [],
    },
    {
      label: "`open --panel` when nobody can tell where the user is",
      origin: null,
      method: "navigate" as const,
      args: { url: "http://localhost:4180/", chatSessionId: "chat-1", openPanel: true },
      localArgs: { openPanel: true },
      forwards: [{ kind: "request", target: null }],
    },
    {
      label: "an agent opening a tab for itself",
      origin: { clientId: "macbook", local: false },
      method: "navigate" as const,
      args: { url: "http://localhost:4180/", chatSessionId: "chat-1", openPanel: false },
      localArgs: null,
      // An agent's own open now loads quietly in a background tab on the
      // user's desktop (the call path), so this machine's bridge is not used.
      forwards: [{ kind: "call", target: "macbook" }],
    },
    {
      label: "`browser panel` while the user talks from another machine",
      origin: { clientId: "macbook", local: false },
      method: "showPanel" as const,
      args: { chatSessionId: "chat-1" },
      localArgs: null,
      forwards: [{ kind: "request", target: "macbook" }],
    },
  ])("with a desktop here, routes $label", async ({ origin, method, args, localArgs, forwards }) => {
    const emitted: Array<{ kind: string; target: string | null }> = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        const request = payload.event as { requestId: string; targetClientId?: string | null };
        const kind = payload.type === "built_in_browser_remote_call" ? "call" : "request";
        emitted.push({ kind, target: request.targetClientId ?? null });
        queueMicrotask(() => {
          if (kind === "call") {
            forwarder.replyRemoteCall({ requestId: request.requestId, clientId: "macbook", phase: "taken", desktopLabel: "MacBook" });
            forwarder.replyRemoteCall({ requestId: request.requestId, clientId: "macbook", phase: "done", desktopLabel: "MacBook", ok: true, result: { attached: true } });
          } else {
            forwarder.acknowledgeRemoteRequest({ requestId: request.requestId, desktopLabel: "MacBook", accepted: true });
          }
        });
      },
      logger: forwarderLogger,
      resolveOrigin: () => origin,
      ackTimeoutMs: 500,
      callTakenTimeoutMs: 500,
    });
    const local = vi.fn(async () => ({ attached: true }));
    const bridge = withRemoteBrowserForwarding(makeBridge({ [method]: local }), forwarder);

    await bridge[method](args as never);

    // A command that acts on the chat's tabs runs where the user is, or falls
    // back to this machine only when nobody there takes it; a plain open that
    // shows the panel is a request to the user's desktop instead.
    if (localArgs) {
      expect(local).toHaveBeenCalledTimes(1);
      expect(local).toHaveBeenCalledWith(expect.objectContaining({ url: args.url, ...localArgs }));
    } else {
      expect(local).not.toHaveBeenCalled();
    }
    expect(emitted).toEqual(forwards);
  });

  it("forwards from a real headless runtime when no desktop is attached", async () => {
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

  it("sends a tab command to the user's desktop and reports where it ran", async () => {
    const emitted: Record<string, unknown>[] = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        emitted.push(payload);
        const call = payload.event as { requestId: string };
        queueMicrotask(() => {
          forwarder.replyRemoteCall({ requestId: call.requestId, clientId: "studio", phase: "taken", desktopLabel: "Studio" });
          forwarder.replyRemoteCall({ requestId: call.requestId, clientId: "studio", phase: "done", desktopLabel: "Studio", ok: true, result: { elements: ["a"] } });
        });
      },
      logger: forwarderLogger,
      resolveOrigin: () => ({ clientId: "studio", local: false }),
      callTakenTimeoutMs: 500,
    });
    const local = vi.fn(async () => ({ elements: ["local"] }));
    const bridge = withRemoteBrowserForwarding(makeBridge({ observe: local }), forwarder);

    const result = await bridge.observe({ chatSessionId: "chat-1", tabId: "tab-1" } as never) as Record<string, unknown>;

    expect(result).toMatchObject({
      elements: ["a"],
      browserHost: { machine: "Studio", userComputer: true },
    });
    expect(local).not.toHaveBeenCalled();
    expect(emitted.map((entry) => entry.type)).toEqual(["built_in_browser_remote_call"]);
  });

  it("falls back to this machine when nobody takes the call, then skips the silent desktop", async () => {
    const emitted: Record<string, unknown>[] = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => { emitted.push(payload); },
      logger: forwarderLogger,
      resolveOrigin: () => ({ clientId: "studio", local: false }),
      callTakenTimeoutMs: 5,
    });
    const local = vi.fn(async () => ({ attached: true }));
    const bridge = withRemoteBrowserForwarding(makeBridge({ observe: local }), forwarder);
    const remoteCalls = () => emitted.filter((entry) => entry.type === "built_in_browser_remote_call");

    const first = await bridge.observe({ chatSessionId: "chat-1" } as never) as Record<string, unknown>;
    expect(first).toMatchObject({
      attached: true,
      browserHost: { machine: "this machine", userComputer: false, userElsewhere: true },
    });
    expect(local).toHaveBeenCalledTimes(1);
    expect(remoteCalls()).toHaveLength(1);

    // Inside the "desktop stayed silent" window this chat's commands run
    // here without waiting out the call clock again.
    const second = await bridge.observe({ chatSessionId: "chat-1" } as never) as Record<string, unknown>;
    expect(second).toMatchObject({ attached: true, browserHost: { userElsewhere: true } });
    expect(local).toHaveBeenCalledTimes(2);
    expect(remoteCalls()).toHaveLength(1);
  });

  it("takes a remote-call reply only from the desktop it was sent to", async () => {
    const emitted: Record<string, unknown>[] = [];
    let requestId = "";
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => {
        emitted.push(payload);
        requestId = (payload.event as { requestId: string }).requestId;
      },
      logger: forwarderLogger,
      resolveOrigin: () => ({ clientId: "studio", local: false }),
      callTakenTimeoutMs: 500,
    });
    const local = vi.fn(async () => ({ from: "local" }));
    const bridge = withRemoteBrowserForwarding(makeBridge({ observe: local }), forwarder);

    const pending = bridge.observe({ chatSessionId: "chat-1" } as never);
    await vi.waitFor(() => expect(requestId).not.toBe(""));

    // A reply from a desktop that was not asked is ignored, so it cannot
    // settle the call with a wrong answer.
    expect(forwarder.replyRemoteCall({ requestId, clientId: "someone-else", phase: "done", ok: true, result: { from: "wrong" } })).toEqual({ ok: false });
    expect(forwarder.replyRemoteCall({ requestId, clientId: "studio", phase: "taken", desktopLabel: "Studio" })).toEqual({ ok: true });
    expect(forwarder.replyRemoteCall({ requestId, clientId: "studio", phase: "done", desktopLabel: "Studio", ok: true, result: { from: "right" } })).toEqual({ ok: true });

    const result = await pending as Record<string, unknown>;
    expect(result).toMatchObject({ from: "right", browserHost: { machine: "Studio", userComputer: true } });
    expect(local).not.toHaveBeenCalled();
  });

  it("refuses `--here` with no desktop on this machine instead of forwarding", async () => {
    const emitted: Record<string, unknown>[] = [];
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: (payload) => { emitted.push(payload); },
      logger: forwarderLogger,
      resolveOrigin: () => ({ clientId: "studio", local: false }),
      ackTimeoutMs: 20,
    });
    const bridge = withRemoteBrowserForwarding(makeBridge(), forwarder);

    await expect(bridge.navigate({
      url: "http://localhost:3000/",
      chatSessionId: "chat-1",
      here: true,
    } as never)).rejects.toThrow(/--here/);
    expect(emitted).toHaveLength(0);
  });

  it("keeps a file command off the user's desktop until a command ran here", async () => {
    const forwarder = createRemoteBrowserForwarder({
      emitEvent: () => {},
      logger: forwarderLogger,
      resolveOrigin: () => ({ clientId: "studio", local: false }),
      callTakenTimeoutMs: 5,
    });
    const uploadFile = vi.fn(async () => ({ uploaded: true }));
    const observe = vi.fn(async () => ({ attached: true }));
    const bridge = withRemoteBrowserForwarding(makeBridge({ uploadFile, observe }), forwarder);

    // The chat's browser is the user's, so a file on this machine is refused.
    await expect(bridge.uploadFile({ chatSessionId: "chat-1", path: "/tmp/a.png" } as never)).rejects.toThrow(/--here/);
    expect(uploadFile).not.toHaveBeenCalled();

    // A tab command the user's desktop never takes runs here, which records
    // that this chat's browser is on this machine after all.
    await bridge.observe({ chatSessionId: "chat-1" } as never);
    expect(observe).toHaveBeenCalledTimes(1);

    const result = await bridge.uploadFile({ chatSessionId: "chat-1", path: "/tmp/a.png" } as never);
    expect(result).toEqual({ uploaded: true });
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it("writes a done reply's file where the agent can read it and clears foreign paths", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-forwarder-files-"));
    try {
      const bytes = Buffer.from("screenshot-bytes", "utf8");
      const forwarder = createRemoteBrowserForwarder({
        emitEvent: (payload) => {
          const call = payload.event as { requestId: string };
          queueMicrotask(() => {
            forwarder.replyRemoteCall({
              requestId: call.requestId,
              clientId: "studio",
              phase: "done",
              desktopLabel: "Studio",
              ok: true,
              result: {
                observation: { filePath: "/Users/user/on/studio/shot.png", relativePath: "shot.png" },
                thumbnail: { filePath: "/Users/user/on/studio/thumb.png" },
              },
              files: [
                { pointer: ["observation", "filePath"], fileName: "shot.png", base64: bytes.toString("base64") },
              ],
            });
          });
        },
        logger: forwarderLogger,
        resolveOrigin: () => ({ clientId: "studio", local: false }),
        receivedFilesDir: dir,
        callTakenTimeoutMs: 500,
      });
      const bridge = withRemoteBrowserForwarding(makeBridge({ observe: vi.fn(async () => ({})) }), forwarder);

      const result = await bridge.observe({ chatSessionId: "chat-1" } as never) as unknown as {
        observation: { filePath: string; relativePath: string | null };
        thumbnail: { filePath: string | null };
      };

      // The bytes that crossed the wire are the bytes on disk here.
      expect(fs.readFileSync(result.observation.filePath)).toEqual(bytes);
      expect(result.observation.relativePath).toBeNull();
      // The thumbnail was never sent, so its path on the desktop is dropped.
      expect(result.thumbnail.filePath).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not keep more than four files from one reply", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-forwarder-files-cap-"));
    try {
      const pointers = [0, 1, 2, 3, 4];
      const forwarder = createRemoteBrowserForwarder({
        emitEvent: (payload) => {
          const call = payload.event as { requestId: string };
          queueMicrotask(() => {
            forwarder.replyRemoteCall({
              requestId: call.requestId,
              clientId: "studio",
              phase: "done",
              desktopLabel: "Studio",
              ok: true,
              result: Object.fromEntries(pointers.map((n) => [`f${n}`, { filePath: `/Users/user/on/studio/f${n}.png` }])),
              files: pointers.map((n) => ({
                pointer: [`f${n}`, "filePath"],
                fileName: `f${n}.png`,
                base64: Buffer.from(`bytes-${n}`, "utf8").toString("base64"),
              })),
            });
          });
        },
        logger: forwarderLogger,
        resolveOrigin: () => ({ clientId: "studio", local: false }),
        receivedFilesDir: dir,
        callTakenTimeoutMs: 500,
      });
      const bridge = withRemoteBrowserForwarding(makeBridge({ observe: vi.fn(async () => ({})) }), forwarder);

      const result = await bridge.observe({ chatSessionId: "chat-1" } as never) as unknown as Record<string, { filePath: string | null }>;

      for (const n of [0, 1, 2, 3]) {
        expect(fs.readFileSync(result[`f${n}`].filePath as string)).toEqual(Buffer.from(`bytes-${n}`, "utf8"));
      }
      // The fifth file is past the cap, so its desktop-only path is dropped.
      expect(result.f4.filePath).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The shared connection the desktop-only engines reach through. The desktop
 * ties work (a recording, a demo job) to the connection that started it, so the
 * socket survives a call that fails as an ANSWER and is dropped only when the
 * transport itself is gone.
 */
describe("createDesktopBridgeConnection", () => {
  let server: ServerHandle | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  function open(overrides: Partial<Parameters<typeof createDesktopBridgeConnection>[0]> = {}) {
    return createDesktopBridgeConnection({
      socketPath: "/nonexistent/bridge.sock",
      unavailableMessage: "no desktop attached",
      closedMessage: "connection closed",
      ...overrides,
    });
  }

  it("keeps the socket open when a call answers with an error", async () => {
    let calls = 0;
    server = await startBridgeServer(async () => {
      calls += 1;
      if (calls === 1) throw new Error("render failed");
      return { ok: true };
    });
    const connection = open({ socketPath: server.socketPath });

    await expect(connection.request("scene_preview.render", {}, 5_000)).rejects.toThrow("render failed");
    await expect(connection.request("scene_preview.render", {}, 5_000)).resolves.toEqual({ ok: true });
    // The error answer did not cost a reconnect.
    expect(server.connectionCount()).toBe(1);
  });

  it("refuses a call made after close", async () => {
    const connection = open();
    connection.close();
    await expect(connection.request("scene_preview.render", {}, 5_000))
      .rejects.toThrow("connection closed");
  });
});

/**
 * The scene preview client queues its own renders. The desktop runs them one at
 * a time anyway, but the queue is what starts each request's timeout when it is
 * sent, so a preview waiting behind two slow ones does not time out in transit
 * and drop the shared socket.
 */
describe("createScenePreviewBridgeClient", () => {
  let server: ServerHandle | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("sends one render at a time", async () => {
    let active = 0;
    let maxActive = 0;
    let received = 0;
    const gates: Array<() => void> = [];
    server = await startBridgeServer(async () => {
      received += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      return { title: null, width: 720, height: 0, readyMs: null, settledMs: null, screenshotBase64: null, problems: [] };
    });
    const previewer = createScenePreviewBridgeClient({
      socketPath: server.socketPath,
    });

    const first = previewer.render({ source: "<p>a</p>" });
    const second = previewer.render({ source: "<p>b</p>" });
    await vi.waitFor(() => expect(received).toBe(1));
    // The second has not reached the server while the first is outstanding.
    expect(received).toBe(1);
    gates[0]!();
    await vi.waitFor(() => expect(received).toBe(2));
    gates[1]!();
    const results = await Promise.all([first, second]);
    previewer.dispose();

    expect(results).toHaveLength(2);
    expect(maxActive).toBe(1);
  });
});
