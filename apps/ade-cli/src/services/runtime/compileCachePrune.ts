import fs from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";

// Node names each compile-cache directory after the build that wrote it, for example
// `v24.15.0-arm64-e27d4a24-501`. An app update brings a new build, so the directories of
// the builds it replaced stay on disk. Only directories that match this are ever removed.
const CACHE_TAG_PATTERN = /^v\d+\.\d+\.\d+-/;
const PRUNE_DELAY_MS = 10_000;
// A build's directory is removed only after nothing in it has been written for this long.
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
// The most recently written other builds are kept whatever their age. Two builds that take
// turns (a brain and a CLI on different Node versions) therefore keep their caches.
const KEEP_RECENT_BUILDS = 2;

/** The directory Node writes this process's compile cache to, or undefined when the cache is off. */
export function activeCompileCacheDir(): string | undefined {
  // @types/node 20 predates getCompileCacheDir (Node 22.1+ has it), so it is read untyped.
  const getDir: (() => string | undefined) | undefined = Reflect.get(nodeModule, "getCompileCacheDir");
  return typeof getDir === "function" ? getDir() : undefined;
}

/**
 * Removes the cache directories of other Node builds that sit next to `activeDir` under the
 * same root. A build is removed only when it is stale (nothing written in it for 14 days) and is
 * not one of the two most recently written other builds, so a build that another process is
 * still writing to is kept. Files, symlinks, and directories that are not named like a cache tag
 * are left alone, and so is `activeDir`. A directory that cannot be removed (on Windows a file in
 * it stays locked while another process reads it) is skipped and tried again on the next launch.
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
  const siblings: { name: string; lastWrite: number }[] = [];
  for (const entry of entries) {
    if (entry.name === current || !entry.isDirectory() || !CACHE_TAG_PATTERN.test(entry.name)) continue;
    const lastWrite = await lastWriteMs(path.join(root, entry.name));
    // A build whose time cannot be read is left alone rather than guessed at.
    if (lastWrite !== undefined) siblings.push({ name: entry.name, lastWrite });
  }
  siblings.sort((a, b) => b.lastWrite - a.lastWrite);
  const staleBefore = Date.now() - STALE_AFTER_MS;
  for (const [index, sibling] of siblings.entries()) {
    if (index < KEEP_RECENT_BUILDS || sibling.lastWrite > staleBefore) continue;
    try {
      await fs.promises.rm(path.join(root, sibling.name), { recursive: true, force: true });
      removed.push(sibling.name);
    } catch {
      // Locked or in use. The next launch tries again.
    }
  }
  return removed;
}

/**
 * The newest modification time of a build's directory and of the files directly in it, or
 * undefined when either cannot be read. Node writes each entry to a temporary file and renames it
 * into place, so an entry's own time is when it was last written. The directory's time moves too
 * on most file systems, but this does not depend on that. A build that only reads its cache keeps
 * its old time, and the keep-recent rule in `pruneStaleCompileCacheTags` covers that.
 */
async function lastWriteMs(dir: string): Promise<number | undefined> {
  try {
    const names = await fs.promises.readdir(dir);
    const stats = await Promise.all(
      [dir, ...names.map((name) => path.join(dir, name))].map((target) => fs.promises.lstat(target)),
    );
    return stats.reduce((newest, stat) => Math.max(newest, stat.mtimeMs), 0);
  } catch {
    return undefined;
  }
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
