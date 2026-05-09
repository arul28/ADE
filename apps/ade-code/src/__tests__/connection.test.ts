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

vi.mock("../../../ade-cli/src/bootstrap", () => ({
  createAdeRuntime: embedded.createAdeRuntime,
}));

vi.mock("../../../ade-cli/src/adeRpcServer", () => ({
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
});
