import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectToAde } from "../connection";
import type { ProjectLaunchContext } from "../types";

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

describe("connectToAde embedded mode", () => {
  beforeEach(() => {
    embedded.requests.length = 0;
    embedded.runtime.dispose.mockClear();
    embedded.runtime.agentChatService.subscribeToEvents.mockClear();
    embedded.handler.mockClear();
    embedded.handler.dispose.mockClear();
    embedded.createAdeRuntime.mockClear();
    embedded.createAdeRpcRequestHandler.mockClear();
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
});
