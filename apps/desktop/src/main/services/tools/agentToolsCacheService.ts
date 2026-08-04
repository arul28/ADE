import {
  type ToolProgress,
  ensureTools,
  isToolError,
  listPinnedTools,
  tryResolveTool,
} from "../../../../../ade-cli/src/services/tools";
import type { Logger } from "../logging/logger";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";

/** Per-tool state the renderer renders. Mirrors AgentToolsSnapshot in shared/types. */
export type AgentToolState = {
  tool: string;
  status: "installed" | "fetching" | "missing" | "failed";
  /** 0-100 while fetching and the total size is known, else null. */
  percent: number | null;
  errorKind: string | null;
};

export type AgentToolsSnapshot = {
  tools: AgentToolState[];
  /** True while any tool is still being fetched. */
  fetching: boolean;
};

export type AgentToolsCacheService = {
  getSnapshot(): AgentToolsSnapshot;
  onStateChange(listener: (snapshot: AgentToolsSnapshot) => void): () => void;
  /** Fetch anything missing. Safe to call repeatedly; concurrent calls coalesce. */
  ensureMissing(): Promise<AgentToolsSnapshot>;
  dispose(): void;
};

/** The analytics `provider` vocabulary names the CLI, not the npm package. */
function analyticsProvider(tool: string): string | null {
  if (tool === "codex") return "codex";
  if (tool === "claude-code") return "claude";
  if (tool === "opencode") return "opencode";
  return null;
}

/** The allowlisted duration buckets in productAnalyticsPolicy.ts. */
export function toolFetchDurationBucket(durationMs: number): string {
  if (durationMs < 10_000) return "under_10s";
  if (durationMs < 60_000) return "under_1m";
  if (durationMs < 5 * 60_000) return "under_5m";
  if (durationMs < 30 * 60_000) return "under_30m";
  if (durationMs < 2 * 60 * 60_000) return "under_2h";
  return "over_2h";
}

export function createAgentToolsCacheService(args: {
  logger: Pick<Logger, "info" | "warn">;
  productAnalyticsService?: Pick<ProductAnalyticsService, "captureInternal"> | null;
  /** Injectable for tests. */
  ensure?: typeof ensureTools;
  resolve?: typeof tryResolveTool;
  listPinned?: typeof listPinnedTools;
  now?: () => number;
}): AgentToolsCacheService {
  const ensure = args.ensure ?? ensureTools;
  const resolve = args.resolve ?? tryResolveTool;
  const now = args.now ?? Date.now;
  const pinned = (args.listPinned ?? listPinnedTools)();

  const states = new Map<string, AgentToolState>(
    pinned.map((tool) => [tool, { tool, status: "missing", percent: null, errorKind: null }]),
  );
  const listeners = new Set<(snapshot: AgentToolsSnapshot) => void>();
  let inFlight: Promise<AgentToolsSnapshot> | null = null;
  let disposed = false;

  function snapshot(): AgentToolsSnapshot {
    const tools = [...states.values()].map((state) => ({ ...state }));
    return { tools, fetching: tools.some((state) => state.status === "fetching") };
  }

  function emit(): void {
    if (disposed) return;
    const current = snapshot();
    for (const listener of listeners) listener(current);
  }

  function refreshInstalled(): void {
    for (const tool of pinned) {
      // Never downgrade a tool that is mid-fetch; the resolver only reports
      // installed/absent and would otherwise erase the progress state.
      if (states.get(tool)?.status === "fetching") continue;
      if (resolve(tool)) {
        states.set(tool, { tool, status: "installed", percent: null, errorKind: null });
      }
    }
  }

  function applyProgress(progress: ToolProgress): void {
    const previous = states.get(progress.tool);
    if (progress.phase === "installed" || progress.phase === "cached") {
      states.set(progress.tool, {
        tool: progress.tool,
        status: "installed",
        percent: null,
        errorKind: null,
      });
    } else {
      const percent =
        progress.phase === "downloading"
        && typeof progress.receivedBytes === "number"
        && typeof progress.totalBytes === "number"
        && progress.totalBytes > 0
          ? Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))
          : previous?.percent ?? null;
      states.set(progress.tool, {
        tool: progress.tool,
        status: "fetching",
        percent,
        errorKind: null,
      });
    }
    emit();
  }

  function captureOutcome(tool: string, outcome: "success" | "failed", durationMs: number, errorKind?: string): void {
    const provider = analyticsProvider(tool);
    if (!provider) return;
    args.productAnalyticsService?.captureInternal({
      event: "ade_tool_fetched",
      surface: "desktop",
      properties: {
        provider,
        outcome,
        duration_bucket: toolFetchDurationBucket(durationMs),
        ...(errorKind ? { tool_error_kind: errorKind } : {}),
      },
    });
  }

  async function run(): Promise<AgentToolsSnapshot> {
    refreshInstalled();
    const missing = pinned.filter((tool) => states.get(tool)?.status !== "installed");
    if (missing.length === 0) {
      emit();
      return snapshot();
    }

    for (const tool of missing) {
      const startedAtMs = now();
      try {
        await ensure([tool], { onProgress: applyProgress });
        states.set(tool, { tool, status: "installed", percent: null, errorKind: null });
        args.logger.info("agentTools.fetched", { tool });
        captureOutcome(tool, "success", now() - startedAtMs);
      } catch (error) {
        const errorKind = isToolError(error) ? error.kind : "filesystem";
        states.set(tool, { tool, status: "failed", percent: null, errorKind });
        args.logger.warn("agentTools.fetch_failed", {
          tool,
          kind: errorKind,
          message: error instanceof Error ? error.message : String(error),
        });
        captureOutcome(tool, "failed", now() - startedAtMs, errorKind);
      }
      emit();
    }
    return snapshot();
  }

  return {
    getSnapshot(): AgentToolsSnapshot {
      refreshInstalled();
      return snapshot();
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureMissing(): Promise<AgentToolsSnapshot> {
      // Coalesced: the app-start kick and a renderer-triggered retry must not
      // race two fetches of the same 300 MB tarball. The cross-process lock in
      // the tools module covers other processes; this covers this one.
      if (!inFlight) {
        inFlight = run().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    dispose(): void {
      disposed = true;
      listeners.clear();
    },
  };
}
