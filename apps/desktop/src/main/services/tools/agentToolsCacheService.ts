import {
  type ToolProgress,
  ensureTools,
  gcTools,
  isToolError,
  listPinnedTools,
  tryResolveTool,
} from "../../../../../ade-cli/src/services/tools";
import type {
  AgentToolCacheState,
  AgentToolsCacheSnapshot,
  ToolErrorKind,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";

export type AgentToolsCacheService = {
  getSnapshot(): AgentToolsCacheSnapshot;
  onStateChange(listener: (snapshot: AgentToolsCacheSnapshot) => void): () => void;
  /** Fetch anything missing. Safe to call repeatedly; concurrent calls coalesce. */
  ensureMissing(): Promise<AgentToolsCacheSnapshot>;
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
  gc?: typeof gcTools;
  now?: () => number;
}): AgentToolsCacheService {
  const ensure = args.ensure ?? ensureTools;
  const resolve = args.resolve ?? tryResolveTool;
  const gc = args.gc ?? gcTools;
  const now = args.now ?? Date.now;
  const pinned = (args.listPinned ?? listPinnedTools)();

  const states = new Map<string, AgentToolCacheState>(
    pinned.map((tool) => [tool, { tool, status: "missing", percent: null, errorKind: null }]),
  );
  const listeners = new Set<(snapshot: AgentToolsCacheSnapshot) => void>();
  let inFlight: Promise<AgentToolsCacheSnapshot> | null = null;
  let disposed = false;

  function snapshot(): AgentToolsCacheSnapshot {
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
    let next: AgentToolCacheState;
    if (progress.phase === "installed" || progress.phase === "cached") {
      next = { tool: progress.tool, status: "installed", percent: null, errorKind: null };
    } else {
      const percent =
        progress.phase === "downloading"
        && typeof progress.receivedBytes === "number"
        && typeof progress.totalBytes === "number"
        && progress.totalBytes > 0
          ? Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))
          : previous?.percent ?? null;
      next = { tool: progress.tool, status: "fetching", percent, errorKind: null };
    }
    states.set(progress.tool, next);
    // A 300 MB tarball reports progress on every network chunk -- roughly 1700
    // callbacks per tool -- but the snapshot only carries a status word and a
    // whole percent. Sending an IPC frame for a state the renderer cannot tell
    // apart from the one it already has is pure cost, so coalesce to the
    // transitions that actually move a pixel. Every distinct state, including
    // the terminal one for each phase, still gets exactly one emit.
    if (
      previous
      && previous.status === next.status
      && previous.percent === next.percent
      && previous.errorKind === next.errorKind
    ) {
      return;
    }
    emit();
  }

  /**
   * A fetch that landed a new version is the one moment superseded copies are
   * guaranteed to be dead weight, so collect them then rather than making the
   * user find `ade tools gc`. Best effort by construction: the tools the caller
   * asked for are already on disk, and a failed sweep must not turn a
   * successful ensure into a failed one.
   */
  async function gcAfterSuccessfulEnsure(): Promise<void> {
    try {
      const result = await gc();
      args.logger.info("agentTools.gc", {
        removed: result.removed.length,
        kept: result.kept.length,
      });
    } catch (error) {
      args.logger.warn("agentTools.gc_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function captureOutcome(tool: string, outcome: "success" | "failed", durationMs: number, errorKind?: ToolErrorKind): void {
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

  async function run(): Promise<AgentToolsCacheSnapshot> {
    refreshInstalled();
    const missing = pinned.filter((tool) => states.get(tool)?.status !== "installed");
    if (missing.length === 0) {
      emit();
      return snapshot();
    }

    let failures = 0;
    for (const tool of missing) {
      const startedAtMs = now();
      try {
        await ensure([tool], { onProgress: applyProgress });
        states.set(tool, { tool, status: "installed", percent: null, errorKind: null });
        args.logger.info("agentTools.fetched", { tool });
        captureOutcome(tool, "success", now() - startedAtMs);
      } catch (error) {
        failures += 1;
        const errorKind: ToolErrorKind = isToolError(error) ? error.kind : "filesystem";
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
    // Only after a clean pass: a partial failure may well be disk-space, and
    // the version we would collect is the one a retry could still fall back to.
    if (failures === 0) await gcAfterSuccessfulEnsure();
    return snapshot();
  }

  return {
    getSnapshot(): AgentToolsCacheSnapshot {
      refreshInstalled();
      return snapshot();
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureMissing(): Promise<AgentToolsCacheSnapshot> {
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
