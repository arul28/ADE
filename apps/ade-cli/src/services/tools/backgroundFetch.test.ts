import { describe, expect, it, vi } from "vitest";
import { ToolError } from "./errors";
import { startBackgroundAgentToolsFetch } from "./backgroundFetch";

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

const listPinned = () => ["codex", "claude-code", "opencode"];

describe("startBackgroundAgentToolsFetch", () => {
  it("fetches every pinned tool, one ensure call each", async () => {
    const log = logger();
    const ensure = vi.fn(async () => new Map([["codex", {} as never]]));

    await startBackgroundAgentToolsFetch(log, { env: {}, listPinned, ensure, gc: async () => ({ removed: [], kept: [] }) });

    // One call per tool, not one call for the whole list: that is what keeps a
    // single failure from abandoning the tools behind it.
    expect(ensure.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      ["codex"],
      ["claude-code"],
      ["opencode"],
    ]);
    expect(log.info).toHaveBeenCalledWith("tools.fetch_complete", {
      tools: "codex,claude-code,opencode",
      count: 3,
      failed: 0,
    });
  });

  it("keeps fetching the remaining tools after one of them fails", async () => {
    // The regression this guards: a single try/catch around one ensure call for
    // the whole list meant a network blip on the first tool left the brain with
    // no claude-code and no opencode for its entire lifetime, because nothing
    // kicks this again.
    const log = logger();
    const attempted: string[] = [];
    const gc = vi.fn(async () => ({ removed: [], kept: [] }));

    await expect(
      startBackgroundAgentToolsFetch(log, {
        env: {},
        listPinned,
        gc,
        ensure: async (names) => {
          attempted.push(...names);
          if (names[0] === "codex") {
            throw new ToolError("getaddrinfo ENOTFOUND registry.npmjs.org", {
              kind: "network",
              tool: "codex",
            });
          }
          return new Map();
        },
      }),
    ).resolves.toBeUndefined();

    expect(attempted).toEqual(["codex", "claude-code", "opencode"]);
    expect(log.warn).toHaveBeenCalledWith(
      "tools.fetch_failed",
      expect.objectContaining({ kind: "network", tool: "codex" }),
    );
    expect(log.info).toHaveBeenCalledWith("tools.fetch_complete", {
      tools: "claude-code,opencode",
      count: 2,
      failed: 1,
    });
    // A partial pass must not collect: the superseded version of the tool that
    // just failed to download is the only working copy left on the machine.
    expect(gc).not.toHaveBeenCalled();
  });

  it("never rejects when the fetch fails, and records the typed kind", async () => {
    // A failed fetch must not take down brain startup: RPC has to stay
    // available and an agent spawn will surface the missing tool itself.
    const log = logger();

    await expect(
      startBackgroundAgentToolsFetch(log, {
        env: {},
        listPinned,
        ensure: async () => {
          throw new ToolError("getaddrinfo ENOTFOUND registry.npmjs.org", {
            kind: "network",
            tool: "codex",
          });
        },
      }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "tools.fetch_failed",
      expect.objectContaining({ kind: "network", tool: "codex" }),
    );
  });

  it("attributes an untyped throw to the tool that was being fetched", async () => {
    // Only a ToolError carries `tool`; without the loop's own name the warn
    // line could not say which of the three downloads died.
    const log = logger();

    await startBackgroundAgentToolsFetch(log, {
      env: {},
      listPinned: () => ["opencode"],
      gc: async () => ({ removed: [], kept: [] }),
      ensure: async () => {
        throw new Error("boom");
      },
    });

    expect(log.warn).toHaveBeenCalledWith("tools.fetch_failed", {
      kind: "unknown",
      tool: "opencode",
      message: "boom",
    });
  });

  it("collects superseded versions once every pinned tool is present", async () => {
    const log = logger();
    const gc = vi.fn(async () => ({ removed: ["codex@0.9.0"], kept: ["codex@1.0.0"] }));

    await startBackgroundAgentToolsFetch(log, {
      env: {},
      listPinned,
      ensure: async () => new Map(),
      gc,
    });

    expect(gc).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("tools.gc_complete", { removed: 1, kept: 1 });
  });

  it("survives a failing gc", async () => {
    const log = logger();

    await expect(
      startBackgroundAgentToolsFetch(log, {
        env: {},
        listPinned,
        ensure: async () => new Map(),
        gc: async () => {
          throw new ToolError("EACCES", { kind: "filesystem" });
        },
      }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "tools.gc_failed",
      expect.objectContaining({ kind: "filesystem" }),
    );
  });

  it("skips the fetch entirely when ADE_DISABLE_TOOLS_FETCH is set", async () => {
    const log = logger();
    const ensure = vi.fn();

    await startBackgroundAgentToolsFetch(log, {
      env: { ADE_DISABLE_TOOLS_FETCH: "1" },
      listPinned,
      ensure: ensure as never,
    });

    expect(ensure).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("tools.fetch_skipped", {
      reason: "ADE_DISABLE_TOOLS_FETCH=1",
    });
  });

  it("logs phase changes but not individual download chunks", async () => {
    // The brain's service log is long-lived; per-chunk progress would flood it.
    const log = logger();

    await startBackgroundAgentToolsFetch(log, {
      env: {},
      listPinned: () => ["opencode"],
      gc: async () => ({ removed: [], kept: [] }),
      ensure: async (_names, options) => {
        options?.onProgress?.({
          tool: "opencode", packageName: "opencode-darwin-arm64", version: "1.15.5",
          phase: "downloading", receivedBytes: 1, totalBytes: 2,
        });
        options?.onProgress?.({
          tool: "opencode", packageName: "opencode-darwin-arm64", version: "1.15.5",
          phase: "installed",
        });
        return new Map();
      },
    });

    const progressEvents = log.info.mock.calls.filter((call) => call[0] === "tools.fetch_progress");
    expect(progressEvents).toEqual([
      ["tools.fetch_progress", { tool: "opencode", version: "1.15.5", phase: "installed" }],
    ]);
  });
});
