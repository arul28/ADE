import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../services/tools";
import { ToolsUsageError, runToolsCommand } from "./tools";

const env = { ADE_TOOLS_ROOT: "/cache" } as NodeJS.ProcessEnv;
const listPinned = () => ["codex", "claude-code", "opencode"];

function resolution(tool: string) {
  return {
    name: tool,
    packageName: `pkg-${tool}`,
    version: "1.2.3",
    target: "darwin-arm64" as const,
    dir: `/cache/pkg-${tool}/1.2.3`,
    entryPath: `/cache/pkg-${tool}/1.2.3/bin/${tool}`,
  };
}

describe("runToolsCommand", () => {
  it("reports which pinned tools are missing", async () => {
    const result = await runToolsCommand([], {
      env,
      listPinned,
      resolve: ((tool: string) => (tool === "codex" ? resolution(tool) : null)) as never,
    });

    expect(result).toMatchObject({
      ok: true,
      action: "tools-status",
      toolsRoot: "/cache",
      missing: ["claude-code", "opencode"],
    });
  });

  it("ensures every pinned tool when none are named", async () => {
    const ensure = vi.fn(async () => new Map(listPinned().map((t) => [t, resolution(t)])));

    const result = await runToolsCommand(["ensure"], {
      env,
      listPinned,
      ensure: ensure as never,
      resolve: (() => null) as never,
    });

    expect((ensure.mock.calls[0] as unknown[])[0]).toEqual(["codex", "claude-code", "opencode"]);
    expect(result).toMatchObject({ ok: true, action: "tools-ensure" });
  });

  it("rejects an unknown tool name before touching the network", async () => {
    const ensure = vi.fn();

    await expect(
      runToolsCommand(["ensure", "not-a-tool"], { env, listPinned, ensure: ensure as never }),
    ).rejects.toBeInstanceOf(ToolsUsageError);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("surfaces a typed failure as a non-zero result rather than throwing", async () => {
    // The CLI contract is ok:false + errorKind, so scripts (and the installer)
    // can branch on the kind instead of scraping stderr.
    const result = await runToolsCommand(["ensure", "opencode"], {
      env,
      listPinned,
      resolve: (() => null) as never,
      ensure: (async () => {
        throw new ToolError("no space left on device", {
          kind: "disk-space",
          tool: "opencode",
          packageName: "opencode-darwin-arm64",
        });
      }) as never,
    });

    expect(result).toMatchObject({
      ok: false,
      action: "tools-ensure",
      errorKind: "disk-space",
      tool: "opencode",
    });
  });

  it("streams per-phase progress only when text output is requested", async () => {
    const lines: string[] = [];
    const ensure = vi.fn(async (_names: string[], options: { onProgress?: unknown }) => {
      expect(options.onProgress).toBeUndefined();
      return new Map();
    });

    await runToolsCommand(["ensure", "opencode"], {
      env,
      listPinned,
      write: (line) => lines.push(line),
      ensure: ensure as never,
      resolve: (() => null) as never,
    });

    expect(lines).toEqual([]);
  });

  it("renders download progress as a percentage under --text", async () => {
    const lines: string[] = [];

    await runToolsCommand(["ensure", "opencode"], {
      env,
      listPinned,
      textProgress: true,
      write: (line) => lines.push(line),
      resolve: (() => null) as never,
      ensure: (async (_names: string[], options: { onProgress: (p: unknown) => void }) => {
        options.onProgress({
          tool: "opencode",
          packageName: "opencode-darwin-arm64",
          version: "1.15.5",
          phase: "downloading",
          receivedBytes: 50 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
        });
        return new Map();
      }) as never,
    });

    expect(lines).toEqual([
      "opencode (opencode-darwin-arm64@1.15.5) downloading 50% (50.0 MiB/100.0 MiB)",
    ]);
  });

  it("passes dry-run through to the collector", async () => {
    const gc = vi.fn(async () => ({ removed: ["/cache/old"], kept: ["/cache/new"] }));

    const result = await runToolsCommand(["gc", "--dry-run"], { env, listPinned, gc: gc as never });

    expect((gc.mock.calls[0] as Array<{ dryRun: boolean }>)[0]).toMatchObject({ dryRun: true });
    expect(result).toMatchObject({ ok: true, action: "tools-gc", dryRun: true, removed: ["/cache/old"] });
  });

  it("rejects an unknown subcommand", async () => {
    await expect(runToolsCommand(["frobnicate"], { env, listPinned })).rejects.toBeInstanceOf(
      ToolsUsageError,
    );
  });
});
