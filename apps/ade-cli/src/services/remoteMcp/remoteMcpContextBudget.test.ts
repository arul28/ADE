import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RemoteMcpConnectionSummary, RemoteMcpScope } from "../../../../desktop/src/shared/types/remoteMcp";
import type { RemoteMcpMachineRouter } from "./remoteMcpForward";
import { createRemoteMcpProtocol } from "./remoteMcpProtocol";

/**
 * What a connected app pays before it does anything: the server's
 * `initialize` instructions and its `tools/list`, in bytes, per scope.
 * A ratchet: it fails when either grows past remoteMcpContextBudget.json, and
 * when either shrinks, so the baseline follows every cut. Growth on purpose
 * means raising the number in the JSON in the same change, where review sees it.
 */

type Budget = Record<RemoteMcpScope, { instructions: number; tools: number }>;

const BUDGET_PATH = path.join(__dirname, "remoteMcpContextBudget.json");

/** A signed-in brain serves every tool with `machine`, plus machines_list; only the list's shape is read here. */
const machines: RemoteMcpMachineRouter = {
  thisMachine: () => ({ key: "k-this", name: "Mac mini" }),
  roster: async () => [],
  resolve: async () => ({ kind: "error", message: "" }),
  unavailableReason: () => null,
  forward: async () => ({ content: [] }),
};

async function measure(scope: RemoteMcpScope): Promise<{ instructions: number; tools: number }> {
  const protocol = createRemoteMcpProtocol({
    machineName: () => "Mac mini",
    listProjects: () => [],
    record: () => {},
    machines,
  });
  const connection = { id: "budget", label: "budget", scope } as RemoteMcpConnectionSummary;
  const init = await protocol.handleRpc(connection, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const list = await protocol.handleRpc(connection, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const instructions = (init?.result as { instructions?: unknown } | undefined)?.instructions;
  const tools = (list?.result as { tools?: unknown } | undefined)?.tools;
  expect(typeof instructions).toBe("string");
  expect(Array.isArray(tools)).toBe(true);
  return {
    instructions: Buffer.byteLength(String(instructions), "utf8"),
    tools: Buffer.byteLength(JSON.stringify(tools), "utf8"),
  };
}

describe("ADE MCP context budget", () => {
  const budget = JSON.parse(fs.readFileSync(BUDGET_PATH, "utf8")) as Budget;

  it.each(["read", "write"] as const)("%s scope stays at its baseline", async (scope) => {
    const measured = await measure(scope);
    const problems: string[] = [];
    for (const part of ["instructions", "tools"] as const) {
      const baseline = budget[scope][part];
      const now = measured[part];
      const where = `${scope} ${part}: ${now} bytes, baseline ${baseline}`;
      if (now > baseline) {
        problems.push(`grew (${where}). Cut text, or raise the number in remoteMcpContextBudget.json if the growth is on purpose.`);
      } else if (now < baseline) {
        problems.push(`shrank (${where}). Lower the number in remoteMcpContextBudget.json to ${now}.`);
      }
    }
    if (problems.length) throw new Error(`ADE MCP context ${problems.join(" Also ")}`);
  });
});
