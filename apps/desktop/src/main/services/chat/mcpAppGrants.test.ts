import { describe, expect, it } from "vitest";
import { createMcpAppGrantStore, mcpServerFingerprint } from "./mcpAppGrants";
import { claudeMcpAppLink, takeClaudeMcpAppClearance } from "./mcpAppProviderLinks";

/** A grant store over one in-memory value, the way the project settings hold it. */
function memoryGrants() {
  let stored: unknown = { grants: [] };
  return createMcpAppGrantStore({
    load: () => stored,
    save: (value) => {
      stored = value;
    },
    now: () => 0,
  });
}

describe("mcp app grants", () => {
  it.each([
    { label: "the same server, tool and definition", server: "fs", tool: "read", fingerprint: "fp-1", granted: true },
    { label: "a changed definition", server: "fs", tool: "read", fingerprint: "fp-2", granted: false },
    { label: "another server", server: "git", tool: "read", fingerprint: "fp-1", granted: false },
    { label: "another tool", server: "fs", tool: "write", fingerprint: "fp-1", granted: false },
  ])("matches a grant only on server, tool and fingerprint: $label", ({ server, tool, fingerprint, granted }) => {
    const grants = memoryGrants();
    grants.add("fs", "read", "fp-1");
    expect(grants.has(server, tool, fingerprint)).toBe(granted);
  });

  it("removes every grant for the tool and keeps the other tools", () => {
    const grants = memoryGrants();
    grants.add("fs", "read", "fp-1");
    grants.add("fs", "read", "fp-2");
    grants.add("fs", "write", "fp-1");
    expect(grants.remove("fs", "read")).toBe(true);
    expect(grants.has("fs", "read", "fp-1")).toBe(false);
    expect(grants.has("fs", "read", "fp-2")).toBe(false);
    expect(grants.has("fs", "write", "fp-1")).toBe(true);
    expect(grants.remove("fs", "read")).toBe(false);
  });

  it("fingerprints how a server starts, and leaves out its secrets", () => {
    const base = { command: "uvx", args: ["mcp-git"] };
    const fingerprint = mcpServerFingerprint({ ...base, env: { TOKEN: "first" } });
    // Rotating a token does not make a different server.
    expect(mcpServerFingerprint({ ...base, env: { TOKEN: "second" } })).toBe(fingerprint);
    // A change to what runs does.
    expect(mcpServerFingerprint({ command: "uvx", args: ["mcp-git", "--read-only"] })).not.toBe(fingerprint);
  });
});

describe("an MCP App call's permission clearance", () => {
  function pendingCall() {
    let settle!: { resolve: (value: unknown) => void; reject: (error: Error) => void };
    const reply = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const runtime = { query: { request: () => reply } as never, queryStartPromise: null };
    const link = claudeMcpAppLink({
      protocolCapabilities: ["mcp_read_resource_v1"],
      runtime,
      isPlanMode: () => false,
    });
    const result = link!.callTool("srv", "save", { id: 1 });
    return { runtime, settle, result, tool: "mcp__srv__save" };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("answers only that call's own ask, and only once", async () => {
    const { runtime, settle, result, tool } = pendingCall();
    await tick();

    expect(takeClaudeMcpAppClearance(runtime, tool, { id: 1 }, "toolu_model_call")).toBeNull();
    expect(takeClaudeMcpAppClearance(runtime, tool, { id: 2 }, "toolu_mcp_call_1")).toBeNull();
    expect(takeClaudeMcpAppClearance(runtime, "mcp__srv__other", { id: 1 }, "toolu_mcp_call_1")).toBeNull();
    expect(takeClaudeMcpAppClearance(runtime, tool, { id: 1 }, "toolu_mcp_call_1")).not.toBeNull();
    expect(takeClaudeMcpAppClearance(runtime, tool, { id: 1 }, "toolu_mcp_call_1")).toBeNull();

    settle.resolve({ response: { content: [] } });
    await result;
  });

  it("is gone once the call ends", async () => {
    const { runtime, settle, result, tool } = pendingCall();
    await tick();
    settle.resolve({ response: { content: [] } });
    await result;

    expect(takeClaudeMcpAppClearance(runtime, tool, { id: 1 }, "toolu_mcp_call_1")).toBeNull();
  });

  it("withdraws an open card when the app stops waiting", async () => {
    const { runtime, settle, result, tool } = pendingCall();
    await tick();
    const clearance = takeClaudeMcpAppClearance(runtime, tool, { id: 1 }, "toolu_mcp_call_1");
    expect(clearance?.signal.aborted).toBe(false);

    settle.reject(new Error("Claude did not finish the tool call in time."));
    await expect(result).rejects.toThrow("in time");

    expect(clearance?.signal.aborted).toBe(true);
  });
});
