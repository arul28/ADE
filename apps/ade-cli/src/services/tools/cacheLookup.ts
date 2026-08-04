import { isToolError } from "./errors";
import { type ToolResolution, type ToolsContext, tryResolveTool } from "./install";

/**
 * The one place the pinned tools cache is consulted by an executable resolver.
 *
 * Every agent-tool resolver (`codexExecutable.ts`, `claudeCodeExecutable.ts`,
 * `openCodeBinaryManager.ts`) calls this before its bundled-`node_modules`
 * probe, so the cache-first order is defined once and cannot drift between the
 * desktop main process and the brain. Those resolvers are the only resolution
 * path either process has — `apps/ade-cli` imports them across packages rather
 * than keeping copies — so wiring them here covers every spawn site.
 *
 * Never throws. A miss must degrade to the bundled copy rather than break agent
 * spawning, and there are two routine misses:
 *
 *   - `not-installed`  — the normal dev-machine and pre-fetch state.
 *   - `unsupported-target` — the manifest pins five targets, but the bundled
 *     platform-package maps also cover win32-arm64. On that host there is no
 *     pin to resolve and the bundled copy is the only answer.
 */
export function lookupCachedTool(name: string, context: ToolsContext = {}): ToolResolution | null {
  try {
    return tryResolveTool(name, context);
  } catch (error) {
    if (isToolError(error)) return null;
    throw error;
  }
}

/** `entryPath` of a cached tool, or null. The shape most resolvers want. */
export function cachedToolEntryPath(name: string, context: ToolsContext = {}): string | null {
  return lookupCachedTool(name, context)?.entryPath ?? null;
}
