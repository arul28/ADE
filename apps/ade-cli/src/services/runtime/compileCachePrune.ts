import fs from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";

// Node names each compile-cache directory after the build that wrote it, for example
// `v24.15.0-arm64-e27d4a24-501`. An app update brings a new build, so the directories of
// the builds it replaced stay on disk. Only directories that match this are ever removed.
const CACHE_TAG_PATTERN = /^v\d+\.\d+\.\d+-/;
const PRUNE_DELAY_MS = 10_000;

/** The directory Node writes this process's compile cache to, or undefined when the cache is off. */
export function activeCompileCacheDir(): string | undefined {
  // @types/node 20 predates getCompileCacheDir (Node 22.1+ has it), so it is read untyped.
  const getDir: (() => string | undefined) | undefined = Reflect.get(nodeModule, "getCompileCacheDir");
  return typeof getDir === "function" ? getDir() : undefined;
}

/**
 * Removes the cache directories of other Node builds that sit next to `activeDir` under the
 * same root. Files, symlinks, and directories that are not named like a cache tag are left
 * alone, and so is `activeDir`. A directory that cannot be removed (on Windows a file in it
 * stays locked while another process reads it) is skipped and tried again on the next launch.
 * Never throws: the cache is only a speed-up. Returns the names it removed.
 */
export async function pruneStaleCompileCacheTags(activeDir: string): Promise<string[]> {
  const removed: string[] = [];
  const resolved = path.resolve(activeDir);
  const current = path.basename(resolved);
  // If the active directory is not a cache tag, the layout is not one this knows, and its
  // parent may hold unrelated files. Do nothing then.
  if (!CACHE_TAG_PATTERN.test(current)) return removed;
  const root = path.dirname(resolved);
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return removed;
  for (const entry of entries) {
    if (entry.name === current || !entry.isDirectory() || !CACHE_TAG_PATTERN.test(entry.name)) continue;
    try {
      await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Locked or in use. The next launch tries again.
    }
  }
  return removed;
}

/**
 * Runs the prune a few seconds after startup, so its I/O does not compete with the first
 * window or the brain's own startup. The timer is unref'd and never keeps a process alive.
 * With `expectedRoot`, nothing is pruned unless the active cache lives in that root, which
 * keeps an explicit NODE_COMPILE_CACHE or ADE_COMPILE_CACHE_DIR out of reach.
 */
export function scheduleStaleCompileCachePrune(
  activeDir: string | undefined,
  options: { expectedRoot?: string; delayMs?: number; onPruned?: (removed: string[]) => void } = {},
): void {
  if (!activeDir) return;
  if (options.expectedRoot && path.resolve(path.dirname(activeDir)) !== path.resolve(options.expectedRoot)) return;
  const timer = setTimeout(() => {
    void pruneStaleCompileCacheTags(activeDir)
      .then((removed) => {
        if (removed.length > 0) options.onPruned?.(removed);
      })
      .catch(() => undefined);
  }, options.delayMs ?? PRUNE_DELAY_MS);
  timer.unref();
}
