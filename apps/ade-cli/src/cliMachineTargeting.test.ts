import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli";
import { createMachineRemoteConnection } from "./cliMachineTargeting";

/**
 * A request sent to another machine through this machine's brain. The brain is
 * the process boundary: a socket server that answers `machines.call` as the
 * other machine would.
 */

let dir: string;
let server: net.Server | null = null;
const savedHome = process.env.ADE_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-targeting-"));
  process.env.ADE_HOME = path.join(dir, "home");
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  if (savedHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A brain whose other machine has these lanes; records every chat it creates there. */
async function startBrain(lanesThere: Array<{ id: string; laneType: string }>) {
  const created: Array<Record<string, unknown>> = [];
  // Windows serves a named pipe, never a socket file.
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\${path.basename(dir)}`
    : path.join(dir, "b.sock");
  const answer = (method: string, params: Record<string, any>): unknown => {
    if (method === "ade/initialize") return { serverInfo: { name: "test" }, capabilities: {}, runtimeInfo: { defaultRole: "cto" } };
    if (method !== "machines.call") return {};
    const request = params.request?.params ?? {};
    if (request.name === "list_lanes") return { machine: { name: "Box" }, result: { structuredContent: { lanes: lanesThere } } };
    if (request.name === "run_ade_action" && request.arguments?.action === "createSession") {
      created.push(request.arguments.args);
      return { machine: { name: "Box" }, result: { structuredContent: { id: "chat-there" } } };
    }
    return { machine: { name: "Box" }, result: {} };
  };
  server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
        if (message.id === undefined) continue;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method, message.params ?? {}) })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  const options = parseCliArgs(["--socket", socketPath, "chat", "create"]).options;
  return { created, options };
}

const createChat = (args: Record<string, unknown>) => ({
  name: "run_ade_action",
  arguments: { domain: "chat", action: "createSession", args: { provider: "codex", ...args } },
});

describe("a chat created on another machine", () => {
  it.each([
    ["names no lane: the project's primary lane there", {}, "lane-primary-there"],
    ["names a lane: that lane", { laneId: "lane-named" }, "lane-named"],
  ])("%s", async (_label, laneArgs, expectedLane) => {
    const brain = await startBrain([
      { id: "lane-feature-there", laneType: "worktree" },
      { id: "lane-primary-there", laneType: "primary" },
    ]);
    const connection = await createMachineRemoteConnection(brain.options, "Box");
    try {
      await connection.request("ade/actions/call", createChat(laneArgs));
    } finally {
      connection.close();
    }
    expect(brain.created).toEqual([expect.objectContaining({ laneId: expectedLane })]);
  });

  it("is refused, naming the way forward, when the project there has no primary lane", async () => {
    const brain = await startBrain([{ id: "lane-feature-there", laneType: "worktree" }]);
    const connection = await createMachineRemoteConnection(brain.options, "Box");
    try {
      await expect(connection.request("ade/actions/call", createChat({}))).rejects.toThrow(/--lane <lane there>/);
    } finally {
      connection.close();
    }
    expect(brain.created).toEqual([]);
  });
});
