import {
  type EnsureToolsOptions,
  type GcToolsOptions,
  type GcToolsResult,
  type ToolResolution,
  ensureTools,
  gcTools,
  listPinnedTools,
} from "./install";
import { isToolError } from "./errors";

type FetchLogger = {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
};

export type BackgroundToolsFetchDeps = {
  env?: NodeJS.ProcessEnv;
  ensure?: (names: string[], options?: EnsureToolsOptions) => Promise<Map<string, ToolResolution>>;
  listPinned?: () => string[];
  gc?: (options?: GcToolsOptions) => Promise<GcToolsResult>;
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
  const gc = deps.gc ?? gcTools;
  const pinned = (deps.listPinned ?? listPinnedTools)();

  return (async () => {
    const fetched: string[] = [];
    let failures = 0;

    // One `ensure` call per tool, each with its own catch. A single call for
    // the whole list would abandon every later tool the moment one of them
    // fails — a network blip on the first download would leave the brain with
    // no Claude and no opencode for its entire lifetime, because nothing kicks
    // this again. Same shape as the desktop's agentToolsCacheService.run().
    for (const tool of pinned) {
      try {
        await ensure([tool], {
          onProgress: (progress) => {
            // One line per phase change, never per download chunk: this lands
            // in the brain's long-lived service log.
            if (progress.phase === "downloading") return;
            logger.info("tools.fetch_progress", {
              tool: progress.tool,
              version: progress.version,
              phase: progress.phase,
            });
          },
        });
        fetched.push(tool);
      } catch (error) {
        failures += 1;
        logger.warn("tools.fetch_failed", {
          kind: isToolError(error) ? error.kind : "unknown",
          tool: isToolError(error) ? error.tool ?? tool : tool,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("tools.fetch_complete", {
      tools: fetched.join(","),
      count: fetched.length,
      failed: failures,
    });

    // Only collect once every pinned tool is actually present. A GC run after a
    // partial pass could drop the previous version of a tool whose new version
    // just failed to download, turning a recoverable "retry the fetch" into a
    // machine with no working binary at all.
    if (failures === 0) {
      try {
        const collected = await gc();
        logger.info("tools.gc_complete", {
          removed: collected.removed.length,
          kept: collected.kept.length,
        });
      } catch (error) {
        logger.warn("tools.gc_failed", {
          kind: isToolError(error) ? error.kind : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })();
}
