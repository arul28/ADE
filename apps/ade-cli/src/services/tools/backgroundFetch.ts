import { type EnsureToolsOptions, type ToolResolution, ensureTools, listPinnedTools } from "./install";
import { isToolError } from "./errors";

type FetchLogger = {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
};

export type BackgroundToolsFetchDeps = {
  env?: NodeJS.ProcessEnv;
  ensure?: (names: string[], options?: EnsureToolsOptions) => Promise<Map<string, ToolResolution>>;
  listPinned?: () => string[];
};

/**
 * Populate the pinned agent-tools cache in the background at brain startup.
 *
 * Deliberately not awaited by the caller. These are 100-300 MB downloads and
 * the brain must be answering RPC immediately; a machine with a cold cache
 * would otherwise look wedged for minutes on first run. Everything that follows
 * from not awaiting is handled elsewhere:
 *
 *   - An agent spawn that needs a still-missing tool gets a typed
 *     `not-installed` ToolError, which the UI renders as "fetching" rather than
 *     as a raw failure.
 *   - Every resolver reads the cache per call, and `resolveOpenCodeBinary`
 *     never caches a miss, so a fetch that lands mid-session is picked up with
 *     no restart.
 *   - `ensureTools` takes a cross-process lock, so racing the desktop app or a
 *     second brain on the same machine is safe.
 *
 * Returns the in-flight promise so tests (and any future caller that does want
 * to wait) can observe completion. Never rejects.
 */
export function startBackgroundAgentToolsFetch(
  logger: FetchLogger,
  deps: BackgroundToolsFetchDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  if (env.ADE_DISABLE_TOOLS_FETCH === "1") {
    logger.info("tools.fetch_skipped", { reason: "ADE_DISABLE_TOOLS_FETCH=1" });
    return Promise.resolve();
  }

  const ensure = deps.ensure ?? ensureTools;
  const pinned = (deps.listPinned ?? listPinnedTools)();

  return (async () => {
    try {
      const resolved = await ensure(pinned, {
        onProgress: (progress) => {
          // One line per phase change, never per download chunk: this lands in
          // the brain's long-lived service log.
          if (progress.phase === "downloading") return;
          logger.info("tools.fetch_progress", {
            tool: progress.tool,
            version: progress.version,
            phase: progress.phase,
          });
        },
      });
      logger.info("tools.fetch_complete", {
        tools: [...resolved.keys()].join(","),
        count: resolved.size,
      });
    } catch (error) {
      logger.warn("tools.fetch_failed", {
        kind: isToolError(error) ? error.kind : "unknown",
        tool: isToolError(error) ? error.tool ?? null : null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
