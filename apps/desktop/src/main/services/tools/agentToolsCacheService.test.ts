import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../../../../../ade-cli/src/services/tools";
import { createAgentToolsCacheService, toolFetchDurationBucket } from "./agentToolsCacheService";

const logger = { info: vi.fn(), warn: vi.fn() };

/**
 * Every test injects this. The real `gcTools` walks the machine-level tools
 * cache, so leaving it un-stubbed would make the suite delete real directories
 * under `~/.ade/tools`.
 */
const noopGc = (async () => ({ removed: [], kept: [] })) as never;

function resolution(tool: string) {
  return {
    name: tool,
    packageName: `pkg-${tool}`,
    version: "1.0.0",
    target: "darwin-arm64" as const,
    dir: `/cache/${tool}`,
    entryPath: `/cache/${tool}/bin/${tool}`,
  };
}

describe("createAgentToolsCacheService", () => {
  it("fetches only the tools that are missing", async () => {
    const ensure = vi.fn(async () => new Map());
    const service = createAgentToolsCacheService({
      logger,
      gc: noopGc,
      listPinned: () => ["codex", "claude-code", "opencode"],
      // codex is already on disk; the other two are not.
      resolve: ((tool: string) => (tool === "codex" ? resolution(tool) : null)) as never,
      ensure: ensure as never,
    });

    await service.ensureMissing();

    expect(ensure.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      ["claude-code"],
      ["opencode"],
    ]);
  });

  it("reports a failed tool with its typed kind and keeps going", async () => {
    const service = createAgentToolsCacheService({
      logger,
      gc: noopGc,
      listPinned: () => ["codex", "opencode"],
      resolve: (() => null) as never,
      ensure: (async (names: string[]) => {
        if (names[0] === "codex") {
          throw new ToolError("no route to host", { kind: "network", tool: "codex" });
        }
        return new Map();
      }) as never,
    });

    const snapshot = await service.ensureMissing();

    // The opencode fetch must still have been attempted after codex failed --
    // one dead mirror should not leave the other two tools unfetched.
    expect(snapshot.tools).toEqual([
      { tool: "codex", status: "failed", percent: null, errorKind: "network" },
      { tool: "opencode", status: "installed", percent: null, errorKind: null },
    ]);
  });

  it("captures one privacy-bounded analytics event per fetch outcome", async () => {
    const captureInternal = vi.fn();
    let clock = 0;
    const service = createAgentToolsCacheService({
      logger,
      gc: noopGc,
      productAnalyticsService: { captureInternal } as never,
      listPinned: () => ["claude-code", "opencode"],
      resolve: (() => null) as never,
      now: () => (clock += 5_000),
      ensure: (async (names: string[]) => {
        if (names[0] === "opencode") {
          throw new ToolError("checksum mismatch", { kind: "integrity", tool: "opencode" });
        }
        return new Map();
      }) as never,
    });

    await service.ensureMissing();

    expect(captureInternal.mock.calls.map((call) => call[0])).toEqual([
      {
        event: "ade_tool_fetched",
        surface: "desktop",
        properties: { provider: "claude", outcome: "success", duration_bucket: "under_10s" },
      },
      {
        event: "ade_tool_fetched",
        surface: "desktop",
        properties: {
          provider: "opencode",
          outcome: "failed",
          duration_bucket: "under_10s",
          tool_error_kind: "integrity",
        },
      },
    ]);
  });

  it("coalesces concurrent ensure calls so one tarball is not fetched twice", async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const ensure = vi.fn(
      () => new Promise((resolve) => {
        gate.release = () => resolve(new Map());
      }),
    );
    const service = createAgentToolsCacheService({
      logger,
      gc: noopGc,
      listPinned: () => ["opencode"],
      resolve: (() => null) as never,
      ensure: ensure as never,
    });

    const first = service.ensureMissing();
    const second = service.ensureMissing();
    gate.release();
    await Promise.all([first, second]);

    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("streams download percentage to subscribers", async () => {
    const seen: Array<number | null> = [];
    const service = createAgentToolsCacheService({
      logger,
      gc: noopGc,
      listPinned: () => ["opencode"],
      resolve: (() => null) as never,
      ensure: (async (_names: string[], options: { onProgress?: (p: unknown) => void }) => {
        options.onProgress?.({
          tool: "opencode",
          packageName: "opencode-darwin-arm64",
          version: "1.15.5",
          phase: "downloading",
          receivedBytes: 25,
          totalBytes: 100,
        });
        return new Map();
      }) as never,
    });
    service.onStateChange((snapshot) => {
      seen.push(snapshot.tools[0]?.percent ?? null);
    });

    await service.ensureMissing();

    expect(seen).toContain(25);
  });

  // A 300 MB tarball fires onProgress on every network chunk (~1700 per tool),
  // but the snapshot only carries a status word and a whole percent. Every one
  // of those that does not move either is an IPC frame with nothing behind it.
  it("emits only when the visible status or whole percent actually changes", async () => {
    const seen: Array<{ status: string; percent: number | null }> = [];
    const chunk = (receivedBytes: number) => ({
      tool: "opencode",
      packageName: "opencode-darwin-arm64",
      version: "1.15.5",
      phase: "downloading" as const,
      receivedBytes,
      totalBytes: 1_000,
    });
    const service = createAgentToolsCacheService({
      logger,
      gc: noopGc,
      listPinned: () => ["opencode"],
      resolve: (() => null) as never,
      ensure: (async (_names: string[], options: { onProgress?: (p: unknown) => void }) => {
        // 0% and 1% straddle a percent boundary; the six between them do not.
        for (const bytes of [0, 1, 2, 3, 9, 10, 11, 12]) options.onProgress?.(chunk(bytes));
        // Phases that carry no byte counts must not re-emit the same state.
        options.onProgress?.({ ...chunk(12), phase: "verifying" });
        options.onProgress?.({ ...chunk(12), phase: "extracting" });
        options.onProgress?.({ ...chunk(12), phase: "installed" });
        return new Map();
      }) as never,
    });
    service.onStateChange((snapshot) => {
      const tool = snapshot.tools[0];
      if (tool) seen.push({ status: tool.status, percent: tool.percent });
    });

    await service.ensureMissing();

    // Three of the eleven callbacks move something visible; the other eight are
    // dropped. The trailing duplicate is the run loop's own post-tool emit.
    expect(seen).toEqual([
      { status: "fetching", percent: 0 },
      { status: "fetching", percent: 1 },
      { status: "installed", percent: null },
      { status: "installed", percent: null },
    ]);
  });

  // The moment a new version lands is the moment the superseded copy is
  // guaranteed to be dead weight, so collect it instead of waiting for the user
  // to find `ade tools gc`.
  it("collects superseded versions after a fully successful ensure", async () => {
    const gc = vi.fn(async () => ({ removed: ["/cache/old"], kept: ["/cache/new"] }));
    const service = createAgentToolsCacheService({
      logger,
      gc: gc as never,
      listPinned: () => ["opencode"],
      resolve: (() => null) as never,
      ensure: (async () => new Map()) as never,
    });

    await service.ensureMissing();

    expect(gc).toHaveBeenCalledTimes(1);
  });

  // A partial failure may well be disk-space, and the version gc would collect
  // is the one a retry could still fall back to.
  it("skips the sweep when any tool failed, and never fails the run over it", async () => {
    const gc = vi.fn(async () => ({ removed: [], kept: [] }));
    const service = createAgentToolsCacheService({
      logger,
      gc: gc as never,
      listPinned: () => ["codex", "opencode"],
      resolve: (() => null) as never,
      ensure: (async (names: string[]) => {
        if (names[0] === "codex") throw new ToolError("no space", { kind: "disk-space" });
        return new Map();
      }) as never,
    });

    await service.ensureMissing();
    expect(gc).not.toHaveBeenCalled();

    // And a sweep that throws must not turn a successful ensure into a failure.
    const exploding = createAgentToolsCacheService({
      logger,
      gc: (async () => {
        throw new Error("cache volume disappeared");
      }) as never,
      listPinned: () => ["opencode"],
      resolve: (() => null) as never,
      ensure: (async () => new Map()) as never,
    });

    const snapshot = await exploding.ensureMissing();
    expect(snapshot.tools).toEqual([
      { tool: "opencode", status: "installed", percent: null, errorKind: null },
    ]);
  });
});

describe("toolFetchDurationBucket", () => {
  it("maps onto the allowlisted analytics buckets", () => {
    // These strings are validated against SAFE_STRING_VALUES.duration_bucket in
    // productAnalyticsPolicy.ts; an unlisted value is silently dropped.
    expect(toolFetchDurationBucket(1_000)).toBe("under_10s");
    expect(toolFetchDurationBucket(30_000)).toBe("under_1m");
    expect(toolFetchDurationBucket(4 * 60_000)).toBe("under_5m");
    expect(toolFetchDurationBucket(10 * 60_000)).toBe("under_30m");
    expect(toolFetchDurationBucket(60 * 60_000)).toBe("under_2h");
    expect(toolFetchDurationBucket(5 * 60 * 60_000)).toBe("over_2h");
  });
});
