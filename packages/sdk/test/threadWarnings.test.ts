import { describe, expect, it } from "vitest";
import { threadOpenWarnings, threadResumeMismatchWarnings } from "../src/threadWarnings.js";

describe("thread open warnings", () => {
  const base = {
    key: "support",
    suppliedServers: false,
    mcpCapability: null,
    instructionsCapability: null,
    settingSourcesCapability: null,
    permissionCapability: null,
  } as const;

  it("says nothing for an ordinary thread", () => {
    expect(threadOpenWarnings({ ...base })).toEqual([]);
  });

  it("names a request the runtime never reported on", () => {
    const lines = threadOpenWarnings({
      ...base,
      suppliedServers: true,
      mcpServers: { a: { type: "stdio", command: "x" } },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("requested MCP but the runtime reported no capability");
  });

  it("stays quiet for a delivery-only thread with no report, by design", () => {
    // `loadUserMcpServers: true` asks for nothing to be withheld, so the
    // runtime emits no report on purpose. A warning here would fire on every
    // correct thread.
    expect(threadOpenWarnings({ ...base, loadUserMcpServers: true })).toEqual([]);
  });

  it("warns on a strict-only request that got no report", () => {
    const lines = threadOpenWarnings({ ...base, loadUserMcpServers: false });
    expect(lines[0]).toContain("requested MCP");
  });

  it("branches on level, not on delivered, for a dropped server set", () => {
    const lines = threadOpenWarnings({
      ...base,
      suppliedServers: true,
      mcpServers: { a: { type: "stdio", command: "x" } },
      mcpCapability: {
        level: "unsupported",
        mechanism: "pi has no MCP surface",
        residual: null,
        strictRequested: true,
        delivered: false,
      },
    });
    expect(lines.some((line) => line.includes("WITHOUT the requested MCP servers"))).toBe(true);
  });

  it("reports a best-effort residual even when the servers did land", () => {
    const lines = threadOpenWarnings({
      ...base,
      suppliedServers: true,
      mcpServers: { a: { type: "stdio", command: "x" } },
      mcpCapability: {
        level: "best-effort",
        mechanism: "codex",
        residual: "plugin-contributed servers still load",
        strictRequested: true,
        delivered: true,
      },
    });
    expect(lines.some((line) => line.includes("plugin-contributed servers still load"))).toBe(true);
  });

  it("warns for instructions, settingSources and a policy that got no report", () => {
    const lines = threadOpenWarnings({
      ...base,
      instructions: { mode: "append", text: "hi" },
      settingSources: "project",
      permissionPolicy: { fallback: "ask" },
    });
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("possibly not delivered");
    expect(lines.join("\n")).toContain("configuration layers are unknown");
    expect(lines.join("\n")).toContain("treat the policy as unenforced");
  });

  it("warns when fallback: deny would silently block an injected server", () => {
    const lines = threadOpenWarnings({
      ...base,
      suppliedServers: true,
      mcpServers: { docs: { type: "stdio", command: "x" } },
      permissionPolicy: { fallback: "deny", allowedTools: ["Read"] },
      mcpCapability: {
        level: "enforced",
        mechanism: "claude",
        residual: null,
        strictRequested: true,
        delivered: true,
      },
      permissionCapability: { level: "enforced", mechanism: "claude", residual: null },
    });
    expect(lines.some((line) => line.includes("blocks every tool of MCP servers"))).toBe(true);
  });
});

describe("resume mismatch warnings", () => {
  it("says nothing when the caller supplied nothing", () => {
    expect(
      threadResumeMismatchWarnings({ key: "k", supplied: {}, stored: { cwd: "/a" } }),
    ).toEqual([]);
  });

  it("says nothing when the supplied value matches the stored one", () => {
    expect(
      threadResumeMismatchWarnings({
        key: "k",
        supplied: { cwd: "/a", settingSources: "project" },
        stored: { cwd: "/a", settingSources: "project" },
      }),
    ).toEqual([]);
  });

  it("names every option a resume ignored", () => {
    // The silent version of this let a caller believe an agent was confined to
    // /new under a policy it had just supplied, while it ran in /old under the
    // old one.
    const lines = threadResumeMismatchWarnings({
      key: "support",
      supplied: {
        cwd: "/new",
        instructions: { mode: "append", text: "new" },
        settingSources: "all",
        permissions: { fallback: "deny" },
      },
      stored: {
        cwd: "/old",
        instructions: { mode: "append", text: "old" },
        settingSources: "none",
        permissionPolicy: { fallback: "ask" },
      },
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("stored cwd (/old)");
    expect(lines.join("\n")).toContain("was ignored");
  });

  it("warns about a cwd supplied on resume even when the record stored none", () => {
    // A thread created without a cwd is the common case — `client.ts` stores
    // the field only when one was given — and this is exactly when the caller
    // needs telling: they believe the agent works in their project while it
    // runs in the runtime's scratch workspace.
    const lines = threadResumeMismatchWarnings({
      key: "support",
      supplied: { cwd: "/Users/x/project" },
      stored: {},
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the runtime's default workspace");
    expect(lines[0]).toContain("was ignored");
  });

  it("warns when a resume supplies a different MCP server map", () => {
    // The tool surface is re-applied from the record like the other four, and
    // an embedder told nothing may present "only your tools are loaded" on the
    // strength of a map that never reached the runtime.
    const lines = threadResumeMismatchWarnings({
      key: "support",
      supplied: { mcpServers: { b: { type: "stdio", command: "y" } } },
      stored: { mcpServers: { a: { type: "stdio", command: "x" } } },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("stored mcpServers (the stored servers)");
  });

  it("warns when a resume supplies mcpServers and the record stored none", () => {
    const lines = threadResumeMismatchWarnings({
      key: "support",
      supplied: { mcpServers: { b: { type: "stdio", command: "y" } } },
      stored: {},
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("stored mcpServers (none)");
  });

  it("warns when a resume flips loadUserMcpServers", () => {
    const lines = threadResumeMismatchWarnings({
      key: "support",
      supplied: { loadUserMcpServers: false },
      stored: { loadUserMcpServers: true },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("stored loadUserMcpServers (true)");
  });

  it("names the session profile's default when loadUserMcpServers was never stored", () => {
    const lines = threadResumeMismatchWarnings({
      key: "support",
      supplied: { loadUserMcpServers: false },
      stored: {},
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the session profile's own default");
  });

  it("says nothing when the supplied MCP request matches the stored one", () => {
    expect(
      threadResumeMismatchWarnings({
        key: "k",
        supplied: {
          mcpServers: { a: { type: "stdio", command: "x" } },
          loadUserMcpServers: true,
        },
        stored: {
          mcpServers: { a: { type: "stdio", command: "x" } },
          loadUserMcpServers: true,
        },
      }),
    ).toEqual([]);
  });
});
