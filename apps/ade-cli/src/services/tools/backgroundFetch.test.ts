import { describe, expect, it, vi } from "vitest";
import { ToolError } from "./errors";
import { startBackgroundAgentToolsFetch } from "./backgroundFetch";

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

const listPinned = () => ["codex", "claude-code", "opencode"];

describe("startBackgroundAgentToolsFetch", () => {
  it("fetches every pinned tool", async () => {
    const log = logger();
    const ensure = vi.fn(async () => new Map([["codex", {} as never]]));

    await startBackgroundAgentToolsFetch(log, { env: {}, listPinned, ensure });

    expect((ensure.mock.calls[0] as unknown[])[0]).toEqual(["codex", "claude-code", "opencode"]);
    expect(log.info).toHaveBeenCalledWith("tools.fetch_complete", { tools: "codex", count: 1 });
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
      listPinned,
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
