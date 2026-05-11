import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToAde } from "../connection";
import { JsonRpcClient } from "../jsonRpcClient";
import type { ProjectLaunchContext } from "../types";

const childProcess = vi.hoisted(() => {
  const child = { unref: vi.fn() };
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

vi.mock("node:child_process", () => ({
  spawn: childProcess.spawn,
}));

const embedded = vi.hoisted(() => {
  const requests: Array<{ jsonrpc: string; id: number; method: string; params?: unknown }> = [];
  const runtime = {
    dispose: vi.fn(),
    agentChatService: {
      subscribeToEvents: vi.fn(() => vi.fn()),
    },
  };
  const handler = Object.assign(
    vi.fn(async (message: { jsonrpc: string; id: number; method: string; params?: unknown }) => {
      requests.push(message);
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
};

const originalArgv1 = process.argv[1];
const originalAdeHome = process.env.ADE_HOME;
const originalAdeRpcSocketPath = process.env.ADE_RPC_SOCKET_PATH;

function restoreEnv(): void {
  process.argv[1] = originalArgv1;
  if (originalAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = originalAdeHome;
  if (originalAdeRpcSocketPath === undefined)
    delete process.env.ADE_RPC_SOCKET_PATH;
  else process.env.ADE_RPC_SOCKET_PATH = originalAdeRpcSocketPath;
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
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === "ade/initialize") return {};
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

  it("does not silently fall back to embedded mode when socket attach fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-missing-socket-"));
    const socketPath = path.join(tmpDir, "missing.sock");

    await expect(connectToAde({
      project,
      socketPath,
    })).rejects.toThrow(/ade code --embedded/);

    expect(embedded.createAdeRuntime).not.toHaveBeenCalled();
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
                runtimeInfo: { multiProject: true },
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
      env: expect.objectContaining({ ADE_RPC_SOCKET_PATH: socketPath }),
    });
    expect(childProcess.child.unref).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the script entrypoint argv shape when a CLI script is resolved", async () => {
    const socketPath = useMissingMachineSocket();
    const entrypointDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ade-code-entrypoint-"),
    );
    const entrypoint = path.join(entrypointDir, "cli.cjs");
    fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
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
  });
});
