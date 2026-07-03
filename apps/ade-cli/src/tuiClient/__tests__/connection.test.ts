import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToAde } from "../connection";
import { JsonRpcClient } from "../jsonRpcClient";
import { startTuiHeartbeat, type TuiHeartbeat } from "../heartbeat";
import {
  appendDedupedTuiEvent,
  appendReservedTuiEvent,
  dedupeTuiEvents,
  reserveTuiEventDedupKey,
  syncTuiEventDedupKeys,
  tuiEventDedupKey,
} from "../eventDedup";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import type { ProjectLaunchContext } from "../types";

const childProcess = vi.hoisted(() => {
  const child = { unref: vi.fn() };
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

const runtimeService = vi.hoisted(() => ({
  installRuntimeService: vi.fn(() => ({
    ok: false,
    serviceName: "com.ade.runtime",
    action: "install" as const,
    path: null as string | null,
    message: "not installed",
  })),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcess.spawn,
}));

vi.mock("../../serviceManager", () => ({
  installRuntimeService: runtimeService.installRuntimeService,
}));

const embedded = vi.hoisted(() => {
  const requests: Array<{ jsonrpc: string; id: number; method: string; params?: unknown; envRole?: string }> = [];
  const runtime = {
    dispose: vi.fn(),
    agentChatService: {
      subscribeToEvents: vi.fn(() => vi.fn()),
    },
  };
  const handler = Object.assign(
    vi.fn(async (message: { jsonrpc: string; id: number; method: string; params?: unknown }) => {
      requests.push({ ...message, envRole: process.env.ADE_DEFAULT_ROLE });
      return { ok: true, method: message.method };
    }),
    { dispose: vi.fn() },
  );

  return {
    requests,
    runtime,
    handler,
    createAdeRuntime: vi.fn(async () => runtime),
    createAdeRpcRequestHandler: vi.fn(() => handler),
  };
});

vi.mock("../../bootstrap", () => ({
  createAdeRuntime: embedded.createAdeRuntime,
}));

vi.mock("../../adeRpcServer", () => ({
  createAdeRpcRequestHandler: embedded.createAdeRpcRequestHandler,
}));

const project: ProjectLaunchContext = {
  launchCwd: "/tmp/ade-code",
  projectRoot: "/tmp/ade-code",
  workspaceRoot: "/tmp/ade-code",
  laneHint: null,
  sessionHint: null,
  remote: false,
  remoteLabel: null,
};

const originalArgv1 = process.argv[1];
const originalAdeHome = process.env.ADE_HOME;
const originalAdeRpcSocketPath = process.env.ADE_RPC_SOCKET_PATH;
const originalAdeDefaultRole = process.env.ADE_DEFAULT_ROLE;

function restoreEnv(): void {
  process.argv[1] = originalArgv1;
  if (originalAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = originalAdeHome;
  if (originalAdeRpcSocketPath === undefined)
    delete process.env.ADE_RPC_SOCKET_PATH;
  else process.env.ADE_RPC_SOCKET_PATH = originalAdeRpcSocketPath;
  if (originalAdeDefaultRole === undefined) delete process.env.ADE_DEFAULT_ROLE;
  else process.env.ADE_DEFAULT_ROLE = originalAdeDefaultRole;
}

function useMissingMachineSocket(): string {
  const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-machine-"));
  process.env.ADE_HOME = adeHome;
  delete process.env.ADE_RPC_SOCKET_PATH;
  return path.join(adeHome, "sock", "ade.sock");
}

function mockAttachedClient(): {
  request: ReturnType<typeof vi.fn>;
  onNotification: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const runtimeBuildHash = (() => {
    const entrypoint = process.argv[1];
    if (!entrypoint || !fs.existsSync(entrypoint)) return null;
    return createHash("sha256").update(fs.readFileSync(entrypoint)).digest("hex");
  })();
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === "ade/initialize") return {
        runtimeInfo: { defaultRole: "cto", projectRoot: project.projectRoot, buildHash: runtimeBuildHash },
      };
      if (method === "ade/initialized") return null;
      return { ok: true };
    }),
    onNotification: vi.fn(() => vi.fn()),
    close: vi.fn(),
  };
  vi.spyOn(JsonRpcClient, "connect").mockResolvedValue(
    client as unknown as JsonRpcClient,
  );
  return client;
}

describe("connectToAde embedded mode", () => {
  beforeEach(() => {
    embedded.requests.length = 0;
    embedded.runtime.dispose.mockClear();
    embedded.runtime.agentChatService.subscribeToEvents.mockClear();
    embedded.handler.mockClear();
    embedded.handler.dispose.mockClear();
    embedded.createAdeRuntime.mockClear();
    embedded.createAdeRpcRequestHandler.mockClear();
    childProcess.spawn.mockClear();
    childProcess.child.unref.mockClear();
    childProcess.spawn.mockImplementation(() => childProcess.child);
    runtimeService.installRuntimeService.mockClear();
    runtimeService.installRuntimeService.mockReturnValue({
      ok: false,
      serviceName: "com.ade.runtime",
      action: "install",
      path: null,
      message: "not installed",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  it("uses unique JSON-RPC ids for direct embedded requests", async () => {
    const connection = await connectToAde({
      project,
      forceEmbedded: true,
    });

    try {
      await Promise.all([
        connection.request("ade/actions/list"),
        connection.request("ping"),
      ]);
    } finally {
      await connection.close();
    }

    expect(embedded.requests.map((request) => request.method)).toEqual([
      "ade/initialize",
      "ade/initialized",
      "ade/actions/list",
      "ping",
    ]);
    expect(embedded.requests.map((request) => request.id)).toEqual([1, 2, 3, 4]);
    expect(new Set(embedded.requests.map((request) => request.id)).size).toBe(4);
  });

  it("injects a trusted CTO role while initializing the direct embedded runtime", async () => {
    delete process.env.ADE_DEFAULT_ROLE;

    const connection = await connectToAde({
      project,
      forceEmbedded: true,
    });
    await connection.close();

    const initializeRequest = embedded.requests.find((request) => request.method === "ade/initialize");
    expect(initializeRequest?.envRole).toBe("cto");
    expect(initializeRequest?.params).toMatchObject({
      identity: {
        role: "cto",
      },
    });
    expect(process.env.ADE_DEFAULT_ROLE).toBeUndefined();
  });

  it("treats an invalid embedded default role as missing during initialization", async () => {
    process.env.ADE_DEFAULT_ROLE = "not-a-role";

    const connection = await connectToAde({
      project,
      forceEmbedded: true,
    });
    await connection.close();

    const initializeRequest = embedded.requests.find((request) => request.method === "ade/initialize");
    expect(initializeRequest?.envRole).toBe("cto");
    expect(process.env.ADE_DEFAULT_ROLE).toBe("not-a-role");
  });

  it("treats a non-CTO embedded default role as stale during initialization", async () => {
    process.env.ADE_DEFAULT_ROLE = "agent";

    const connection = await connectToAde({
      project,
      forceEmbedded: true,
    });
    await connection.close();

    const initializeRequest = embedded.requests.find((request) => request.method === "ade/initialize");
    expect(initializeRequest?.envRole).toBe("cto");
    expect(process.env.ADE_DEFAULT_ROLE).toBe("agent");
  });

  it("does not silently fall back to embedded mode when socket attach fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-missing-socket-"));
    const socketPath = path.join(tmpDir, "missing.sock");

    await expect(connectToAde({
      project,
      socketPath,
    })).rejects.toThrow(/ade code --embedded/);

    expect(embedded.createAdeRuntime).not.toHaveBeenCalled();
  });

  it("rejects a direct socket whose runtime role is stale", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-stale-role-"));
    const socketPath = path.join(tmpDir, "ade.sock");
    const requests: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: number; method: string };
          requests.push(request.method);
          const result = request.method === "ade/initialize"
            ? { runtimeInfo: { defaultRole: "agent", projectRoot: project.projectRoot, pid: 123 } }
            : null;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    await expect(connectToAde({
      project,
      socketPath,
    })).rejects.toThrow(/stale .*default role agent is not cto/);

    expect(requests).toEqual(["ade/initialize", "ade/initialized"]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows remote sockets to differ by build hash and project root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-remote-socket-"));
    const socketPath = path.join(tmpDir, "ade.sock");
    const requests: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: number; method: string };
          requests.push(request.method);
          const result = request.method === "ade/initialize"
            ? {
                runtimeInfo: {
                  defaultRole: "cto",
                  projectRoot: "/remote/project",
                  buildHash: "remote-build",
                },
              }
            : null;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const connection = await connectToAde({
      project,
      socketPath,
      requireSocket: true,
      remote: true,
    });
    await connection.close();

    expect(requests).toEqual(["ade/initialize", "ade/initialized"]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers the project and injects projectId when attached to the machine daemon", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-connection-"));
    const socketPath = path.join(tmpDir, "ade.sock");
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
          requests.push({ method: request.method, params: request.params });
          const result = (() => {
            if (request.method === "ade/initialize") {
              return {
                runtimeInfo: { multiProject: true, defaultRole: "cto" },
                capabilities: { projects: true },
              };
            }
            if (request.method === "projects.add") {
              return { projectId: "project-daemon", rootPath: project.projectRoot };
            }
            if (request.method === "ade/actions/list") {
              return { projectId: request.params?.projectId ?? null };
            }
            return null;
          })();
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const connection = await connectToAde({
      project,
      socketPath,
    });
    try {
      const listed = await connection.request<{ projectId: string }>("ade/actions/list", {});
      expect(listed.projectId).toBe("project-daemon");
    } finally {
      await connection.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests.map((request) => request.method)).toEqual([
      "ade/initialize",
      "ade/initialized",
      "projects.add",
      "ade/actions/list",
    ]);
    expect(requests.at(-1)?.params).toMatchObject({ projectId: "project-daemon" });
  });

  it("adapts multi-project runtime chat events into the TUI chat stream", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-connection-"));
    const socketPath = path.join(tmpDir, "ade.sock");
    const serverSocketRef: { current: net.Socket | null } = { current: null };
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const server = net.createServer((socket) => {
      serverSocketRef.current = socket;
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
          requests.push({ method: request.method, params: request.params });
          const result = (() => {
            if (request.method === "ade/initialize") {
              return {
                runtimeInfo: { multiProject: true, defaultRole: "cto" },
                capabilities: { projects: true },
              };
            }
            if (request.method === "projects.add") {
              return { projectId: "project-daemon", rootPath: project.projectRoot };
            }
            if (request.method === "runtimeEvents.subscribe") {
              return { subscriptionId: "runtime-sub-1" };
            }
            if (request.method === "runtimeEvents.unsubscribe") {
              return { removed: true };
            }
            return null;
          })();
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const connection = await connectToAde({
      project,
      socketPath,
    });
    try {
      const delivered = new Promise<AgentChatEventEnvelope>((resolve) => {
        connection.onChatEvent(resolve);
      });
      await vi.waitUntil(
        () => requests.some((request) => request.method === "runtimeEvents.subscribe"),
        { timeout: 1000 },
      );
      expect(requests.find((request) => request.method === "runtimeEvents.subscribe")?.params)
        .toMatchObject({ projectId: "project-daemon", category: "runtime", replay: false });

      const envelope = {
        sessionId: "chat-1",
        timestamp: "2026-05-14T00:00:00.000Z",
        event: { type: "text", text: "hello from daemon" },
        sequence: 1,
      } as AgentChatEventEnvelope;
      serverSocketRef.current?.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "runtime/event",
        params: {
          subscriptionId: "runtime-sub-1",
          projectId: "project-daemon",
          event: {
            id: 1,
            timestamp: "2026-05-14T00:00:00.000Z",
            category: "runtime",
            payload: envelope,
          },
        },
      })}\n`);

      await expect(delivered).resolves.toEqual(envelope);
    } finally {
      await connection.close();
      serverSocketRef.current?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
	  });

  it("surfaces runtime event replay gaps to subscribers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-connection-gap-"));
    const socketPath = path.join(tmpDir, "ade.sock");
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
          const result = (() => {
            if (request.method === "ade/initialize") {
              return {
                runtimeInfo: { multiProject: true, defaultRole: "cto" },
                capabilities: { projects: true },
              };
            }
            if (request.method === "projects.add") {
              return { projectId: "project-daemon", rootPath: project.projectRoot };
            }
            if (request.method === "runtimeEvents.subscribe") {
              return {
                subscriptionId: "runtime-sub-gap",
                gap: true,
                oldestCursor: 12,
                nextCursor: 90,
              };
            }
            if (request.method === "runtimeEvents.unsubscribe") {
              return { removed: true };
            }
            return null;
          })();
          if (!socket.destroyed && socket.writable) {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const connection = await connectToAde({
      project,
      socketPath,
    });
    try {
      const gaps: unknown[] = [];
      const callback = vi.fn();
      const unsubscribe = await connection.subscribeRuntimeEvents(
        {
          category: "runtime",
          cursor: 50,
          limit: 10,
          onGap: (gap) => gaps.push(gap),
        },
        callback,
      );
      expect(gaps).toEqual([{
        gap: true,
        oldestCursor: 12,
        nextCursor: 90,
        subscriptionId: "runtime-sub-gap",
      }]);
      expect(callback).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      await connection.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spawns the standalone binary directly when no CLI script entrypoint exists", async () => {
    const socketPath = useMissingMachineSocket();
    const missingEntrypointDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ade-code-missing-entrypoint-"),
    );
    process.argv[1] = path.join(missingEntrypointDir, "missing-cli");
    const client = mockAttachedClient();

    const connection = await connectToAde({ project });
    try {
      expect(connection.mode).toBe("attached");
    } finally {
      await connection.close();
    }

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const spawnCall = childProcess.spawn.mock.calls[0] as unknown[] | undefined;
    expect(spawnCall?.[0]).toBe(process.execPath);
    expect(spawnCall?.[1]).toEqual(["serve", "--socket", socketPath]);
    expect(spawnCall?.[2]).toMatchObject({
      detached: true,
      stdio: "ignore",
      env: expect.objectContaining({
        ADE_DEFAULT_ROLE: "cto",
        ADE_RPC_SOCKET_PATH: socketPath,
      }),
    });
    expect((spawnCall?.[2] as { env?: Record<string, string> } | undefined)?.env?.ADE_RUNTIME_BUILD_HASH).toBeUndefined();
    expect(childProcess.child.unref).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("rechecks the machine socket after taking the spawn lock", async () => {
    const socketPath = useMissingMachineSocket();
    const lockPath = path.join(path.dirname(socketPath), `${path.basename(socketPath)}.spawn.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "stale\n0\n", "utf8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    const client = mockAttachedClient();
    childProcess.spawn.mockImplementation(() => {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      fs.writeFileSync(socketPath, "", "utf8");
      return childProcess.child;
    });

    const connection = await connectToAde({ project });
    await connection.close();
    const secondConnection = await connectToAde({ project });
    await secondConnection.close();

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("repairs the packaged service before spawning an unmanaged machine daemon", async () => {
    useMissingMachineSocket();
    const installEnvRoles: Array<string | undefined> = [];
    runtimeService.installRuntimeService.mockImplementation(() => {
      installEnvRoles.push(process.env.ADE_DEFAULT_ROLE);
      return {
        ok: true,
        serviceName: "com.ade.runtime",
        action: "install",
        path: "/tmp/com.ade.runtime.plist",
        message: "installed",
      };
    });
    const client = mockAttachedClient();

    const connection = await connectToAde({ project, preferServiceRepair: true });
    try {
      expect(connection.mode).toBe("attached");
    } finally {
      await connection.close();
    }

    expect(runtimeService.installRuntimeService).toHaveBeenCalledTimes(1);
    expect(installEnvRoles).toEqual(["cto"]);
    expect(process.env.ADE_DEFAULT_ROLE).toBe(originalAdeDefaultRole);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to spawning when packaged service repair fails", async () => {
    const socketPath = useMissingMachineSocket();
    const client = mockAttachedClient();

    const connection = await connectToAde({ project, preferServiceRepair: true });
    try {
      expect(connection.mode).toBe("attached");
    } finally {
      await connection.close();
    }

    expect(runtimeService.installRuntimeService).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const spawnCall = childProcess.spawn.mock.calls[0] as unknown[] | undefined;
    expect(spawnCall?.[1]).toEqual(expect.arrayContaining(["serve", "--socket", socketPath]));
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the script entrypoint argv shape when a CLI script is resolved", async () => {
    const socketPath = useMissingMachineSocket();
    const entrypointDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ade-code-entrypoint-"),
    );
    const entrypoint = path.join(entrypointDir, "cli.cjs");
    fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
    const expectedBuildHash = createHash("sha256").update(fs.readFileSync(entrypoint)).digest("hex");
    process.argv[1] = entrypoint;
    mockAttachedClient();

    const connection = await connectToAde({ project });
    await connection.close();

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const spawnCall = childProcess.spawn.mock.calls[0] as unknown[] | undefined;
    expect(spawnCall?.[0]).toBe(process.execPath);
    expect(spawnCall?.[1]).toEqual([
      entrypoint,
      "serve",
      "--socket",
      socketPath,
    ]);
    expect(spawnCall?.[2]).toMatchObject({
      env: expect.objectContaining({
        ADE_DEFAULT_ROLE: "cto",
        ADE_RPC_SOCKET_PATH: socketPath,
        ADE_RUNTIME_BUILD_HASH: expectedBuildHash,
      }),
    });
  });
});

const heartbeats: TuiHeartbeat[] = [];

function tempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-heartbeat-"));
}

function heartbeatFile(projectRoot: string): string {
  return path.join(projectRoot, ".ade", "cache", "ade-code", "clients", `${process.pid}.json`);
}

describe("startTuiHeartbeat", () => {
  afterEach(() => {
    for (const heartbeat of heartbeats.splice(0)) {
      heartbeat.stop();
    }
  });

  it("shares process cleanup handlers across active heartbeats", () => {
    const exitListeners = process.listenerCount("exit");
    const sigintListeners = process.listenerCount("SIGINT");
    const firstRoot = tempProjectRoot();
    const secondRoot = tempProjectRoot();

    const first = startTuiHeartbeat(firstRoot);
    heartbeats.push(first);
    const second = startTuiHeartbeat(secondRoot);
    heartbeats.push(second);

    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
    expect(fs.existsSync(heartbeatFile(firstRoot))).toBe(true);
    expect(fs.existsSync(heartbeatFile(secondRoot))).toBe(true);

    first.stop();
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
    expect(fs.existsSync(heartbeatFile(firstRoot))).toBe(false);
    expect(fs.existsSync(heartbeatFile(secondRoot))).toBe(true);

    second.stop();
    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(fs.existsSync(heartbeatFile(secondRoot))).toBe(false);
  });

  it("makes stop idempotent", () => {
    const exitListeners = process.listenerCount("exit");
    const projectRoot = tempProjectRoot();
    const heartbeat = startTuiHeartbeat(projectRoot);
    heartbeats.push(heartbeat);

    heartbeat.stop();
    heartbeat.stop();

    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(fs.existsSync(heartbeatFile(projectRoot))).toBe(false);
  });
});

function listenRpc(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("JsonRpcClient", () => {
  it("handles framed notifications before JSONL responses", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => {
      resolveServerSocket(socket);
      socket.on("data", (chunk) => {
        const text = String(chunk);
        const match = /"id":(\d+)/.exec(text);
        const id = match ? Number.parseInt(match[1]!, 10) : 1;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n`);
      });
    });

    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const notification = new Promise((resolve) => {
        client.onNotification("chat/event", resolve);
      });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        method: "chat/event",
        params: { sessionId: "s1" },
      });
      socket.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);

      await expect(notification).resolves.toEqual({ sessionId: "s1" });
      await expect(client.request("ping")).resolves.toEqual({ ok: true });
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors byte-based Content-Length framing for unicode payloads", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => {
      resolveServerSocket(socket);
    });

    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const notification = new Promise((resolve) => {
        client.onNotification("chat/event", resolve);
      });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        method: "chat/event",
        params: { message: "héllo ✅" },
      });
      const framed = Buffer.concat([
        Buffer.from(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`, "ascii"),
        Buffer.from(payload, "utf8"),
      ]);
      socket.write(framed.subarray(0, 20));
      socket.write(framed.subarray(20));

      await expect(notification).resolves.toEqual({ message: "héllo ✅" });
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("matches responses whose ids are echoed as strings", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: number; method: string };
          const response = `${JSON.stringify({
            jsonrpc: "2.0",
            id: String(request.id),
            result: { method: request.method },
          })}\n`;
          socket.write(response.slice(0, 13));
          socket.write(response.slice(13));
        }
      });
    });

    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    try {
      await expect(client.request("ping")).resolves.toEqual({ method: "ping" });
    } finally {
      client.close();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles large Content-Length frames split across many chunks", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => {
      resolveServerSocket(socket);
    });

    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const notification = new Promise((resolve) => {
        client.onNotification("chat/event", resolve);
      });
      const message = "x".repeat(128 * 1024);
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        method: "chat/event",
        params: { message },
      });
      const framed = Buffer.concat([
        Buffer.from(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`, "ascii"),
        Buffer.from(payload, "utf8"),
      ]);
      for (let offset = 0; offset < framed.length; offset += 1024) {
        socket.write(framed.subarray(offset, offset + 1024));
      }

      await expect(notification).resolves.toEqual({ message });
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fires onClose when the socket drops unexpectedly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => resolveServerSocket(socket));
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      socket.destroy();
      await expect(closed).resolves.toBeUndefined();
    } finally {
      client.close();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not fire onClose on an intentional close()", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    const server = net.createServer(() => {});
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    try {
      const onClose = vi.fn();
      client.onClose(onClose);
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("times out pending requests by tearing down the socket", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => resolveServerSocket(socket));
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      const first = client.request("slow", undefined, { timeoutMs: 25 });
      const second = client.request("also-slow", undefined, { timeoutMs: 1_000 });

      await expect(first).rejects.toThrow(/timed out/i);
      await expect(second).rejects.toThrow(/timed out|closed/i);
      await expect(closed).resolves.toBeUndefined();
      await expect(client.request("after-timeout")).rejects.toThrow(/closed/i);
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails the connection on parse garbage instead of continuing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => resolveServerSocket(socket));
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      const pending = client.request("ping", undefined, { timeoutMs: 1_000 });
      socket.write("this is not json\n");

      await expect(pending).rejects.toThrow(/Invalid JSON-RPC response|non-JSON output|closed/i);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

async function loadStateModule(home: string): Promise<typeof import("../state")> {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return await import("../state");
}

describe("ade-code TUI state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads legacy state without a last lane id", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tui-state-"));
    fs.mkdirSync(path.join(home, ".ade"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".ade", "ade-code-state.json"),
      JSON.stringify({ lastChatByLane: { "lane-1": "chat-1" } }),
      "utf8",
    );

    const { loadAdeCodeState } = await loadStateModule(home);
    expect(loadAdeCodeState()).toEqual({
      lastChatByLane: { "lane-1": "chat-1" },
      lastChatByProjectLane: {},
      lastLaneId: null,
      lastLaneByProject: {},
      draftKind: "chat",
      draftKindByProject: {},
    });
  });

  it("persists the last lane id with last chat pointers", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tui-state-"));
    const { loadAdeCodeState, saveAdeCodeStateAsync } = await loadStateModule(home);

    await saveAdeCodeStateAsync({
      lastChatByLane: { "lane-2": "chat-9" },
      lastChatByProjectLane: {},
      lastLaneId: "lane-2",
      lastLaneByProject: {},
      draftKind: "cli",
      draftKindByProject: {},
    });

    expect(loadAdeCodeState()).toEqual({
      lastChatByLane: { "lane-2": "chat-9" },
      lastChatByProjectLane: {},
      lastLaneId: "lane-2",
      lastLaneByProject: {},
      draftKind: "cli",
      draftKindByProject: {},
    });
  });
});

describe("tuiEventDedupKey", () => {
  it("uses sequence when present", () => {
    const event = {
      sessionId: "session-1",
      sequence: 42,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(event)).toContain("seq:42");
  });

  it("keeps same-millisecond payload variants distinct when sequence is absent", () => {
    const base = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const first = {
      ...base,
      event: { type: "text", text: "hel" },
    } as AgentChatEventEnvelope;
    const second = {
      ...base,
      event: { type: "text", text: "lo" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(first)).not.toBe(tuiEventDedupKey(second));
  });

  it("keeps rebuilt events distinct when sequence restarts", () => {
    const first = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "old" },
    } as AgentChatEventEnvelope;
    const rebuilt = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "new" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(first)).not.toBe(tuiEventDedupKey(rebuilt));
  });

  it("dedupes exact fallback event replays", () => {
    const first = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;
    const replay = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(first)).toBe(tuiEventDedupKey(replay));
  });

  it("appends using cached keys without re-stringifying previous events", () => {
    const previous = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: {
        type: "text",
        text: "old",
        toJSON() {
          throw new Error("previous event should not be stringified again");
        },
      },
    } as unknown as AgentChatEventEnvelope;
    const incoming = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "new" },
    } as AgentChatEventEnvelope;
    const previousKey = "precomputed-previous-key";
    const keys = new Set<string>([previousKey]);

    const key = reserveTuiEventDedupKey(incoming, keys);
    expect(key).not.toBeNull();
    const next = appendReservedTuiEvent([previous], incoming, keys, [previousKey], key!);

    expect(next.events).toEqual([previous, incoming]);
    expect(next.eventKeys).toEqual([previousKey, key]);
    expect(keys.has(key!)).toBe(true);
  });

  it("uses cached keys to reject replays", () => {
    const first = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>();
    syncTuiEventDedupKeys(keys, [first]);

    expect(reserveTuiEventDedupKey(first, keys)).toBeNull();
  });

  it("rejects semantic replays even when sequence and timestamp differ", () => {
    const first = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "user_message", text: "hello", turnId: "turn-1" },
    } as AgentChatEventEnvelope;
    const replay = {
      sessionId: "session-1",
      sequence: 99,
      timestamp: "2026-01-01T00:01:00.000Z",
      event: { type: "user_message", text: "hello", turnId: "turn-1" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>();

    syncTuiEventDedupKeys(keys, [first]);

    expect(tuiEventDedupKey(first)).toBe(tuiEventDedupKey(replay));
    expect(reserveTuiEventDedupKey(replay, keys)).toBeNull();
  });

  it("dedupes history and live append using the same semantic key", () => {
    const first = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "same chunk", turnId: "turn-1", itemId: "msg-1" },
    } as AgentChatEventEnvelope;
    const replay = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "same chunk", turnId: "turn-1", itemId: "msg-1" },
    } as AgentChatEventEnvelope;
    const next = {
      sessionId: "session-1",
      sequence: 3,
      timestamp: "2026-01-01T00:00:02.000Z",
      event: { type: "text", text: "next chunk", turnId: "turn-1", itemId: "msg-1" },
    } as AgentChatEventEnvelope;

    expect(dedupeTuiEvents([first, replay, next])).toEqual([first, next]);
    expect(appendDedupedTuiEvent([first], replay)).toEqual([first]);
    expect(appendDedupedTuiEvent([first], next)).toEqual([first, next]);
  });

  it("keeps pending reserved keys when trimming old events", () => {
    const oldFirst = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "old first" },
    } as AgentChatEventEnvelope;
    const oldSecond = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "old second" },
    } as AgentChatEventEnvelope;
    const incomingFirst = {
      sessionId: "session-1",
      sequence: 3,
      timestamp: "2026-01-01T00:00:02.000Z",
      event: { type: "text", text: "new first" },
    } as AgentChatEventEnvelope;
    const incomingSecond = {
      sessionId: "session-1",
      sequence: 4,
      timestamp: "2026-01-01T00:00:03.000Z",
      event: { type: "text", text: "new second" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>();
    const oldKeys = syncTuiEventDedupKeys(keys, [oldFirst, oldSecond]);

    const firstKey = reserveTuiEventDedupKey(incomingFirst, keys);
    const secondKey = reserveTuiEventDedupKey(incomingSecond, keys);
    expect(firstKey).not.toBeNull();
    expect(secondKey).not.toBeNull();

    const afterFirstAppend = appendReservedTuiEvent([oldFirst, oldSecond], incomingFirst, keys, oldKeys, firstKey!, 2);

    expect(afterFirstAppend.events).toEqual([oldSecond, incomingFirst]);
    expect(keys.has(oldKeys[0]!)).toBe(false);
    expect(keys.has(secondKey!)).toBe(true);
    expect(reserveTuiEventDedupKey(incomingSecond, keys)).toBeNull();

    const afterSecondAppend = appendReservedTuiEvent(
      afterFirstAppend.events,
      incomingSecond,
      keys,
      afterFirstAppend.eventKeys,
      secondKey!,
      2,
    );

    expect(afterSecondAppend.events).toEqual([incomingFirst, incomingSecond]);
    expect(keys.has(oldKeys[1]!)).toBe(false);
    expect(keys.has(firstKey!)).toBe(true);
    expect(keys.has(secondKey!)).toBe(true);
  });

  it("evicts cached keys without re-stringifying trimmed events", () => {
    const oldFirst = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: {
        type: "text",
        text: "old first",
        toJSON() {
          return { type: "text", text: "old first" };
        },
      },
    } as unknown as AgentChatEventEnvelope;
    const oldSecond = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "old second" },
    } as AgentChatEventEnvelope;
    const incoming = {
      sessionId: "session-1",
      sequence: 3,
      timestamp: "2026-01-01T00:00:02.000Z",
      event: { type: "text", text: "new" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>();
    const oldKeys = syncTuiEventDedupKeys(keys, [oldFirst, oldSecond]);
    (oldFirst.event as { toJSON?: () => unknown }).toJSON = () => {
      throw new Error("trimmed event should not be stringified again");
    };

    const incomingKey = reserveTuiEventDedupKey(incoming, keys);
    expect(incomingKey).not.toBeNull();
    const next = appendReservedTuiEvent([oldFirst, oldSecond], incoming, keys, oldKeys, incomingKey!, 2);

    expect(next.events).toEqual([oldSecond, incoming]);
    expect(keys.has(oldKeys[0]!)).toBe(false);
  });
});
