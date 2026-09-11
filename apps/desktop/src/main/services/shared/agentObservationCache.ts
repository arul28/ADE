import fs from "node:fs/promises";
import path from "node:path";

/**
 * Disk housekeeping for agent observation caches.
 *
 * The built-in browser (per tab) and App Control (per session) write the same
 * `<id>.json` / `<id>.png` / `<id>.map.png` triples into a per-owner directory
 * under `.ade/cache/…`, and both need the same two sweeps: keep the newest N
 * observations for a live owner, and drop whole directories whose files have
 * aged out. One copy, because a fork of this deletes files.
 */

export type AgentObservationCleanup = {
  keepCount: number;
  keptCount: number;
  deletedCount: number;
};

/** Keep the newest `keepCount` observations in `dir`; delete the rest. */
export async function pruneAgentObservationDirectory(
  dir: string,
  keepCount: number,
): Promise<AgentObservationCleanup> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { keepCount, keptCount: 0, deletedCount: 0 };
  }
  const observations = entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .reverse();
  const stale = observations.slice(keepCount);
  let deletedCount = 0;
  for (const jsonName of stale) {
    const base = jsonName.slice(0, -".json".length);
    let deletedObservation = false;
    for (const filename of [`${base}.json`, `${base}.png`, `${base}.map.png`]) {
      try {
        await fs.rm(path.join(dir, filename), { force: true });
        deletedObservation = true;
      } catch {
        // best-effort cleanup
      }
    }
    if (deletedObservation) deletedCount += 1;
  }
  return {
    keepCount,
    keptCount: Math.min(observations.length, keepCount),
    deletedCount,
  };
}

/**
 * Drop observation files older than `maxAgeMs` from every owner directory
 * under `rootDir`, removing directories that end up empty.
 *
 * Reads the root with `withFileTypes` so a symlink planted in the cache root
 * is skipped rather than followed — `fs.stat` resolves the link and would make
 * this read-shaped sweep delete `.json`/`.png` files in the link's target.
 */
export async function pruneAgentObservationCacheRoot(
  rootDir: string,
  maxAgeMs: number,
): Promise<void> {
  let ownerDirs: Array<{ name: string; isDirectory: boolean }>;
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    ownerDirs = entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const ownerDir of ownerDirs) {
    if (!ownerDir.isDirectory) continue;
    const dir = path.join(rootDir, ownerDir.name);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".png")) continue;
      const filePath = path.join(dir, entry.name);
      const fileStat = await fs.lstat(filePath).catch(() => null);
      if (!fileStat || fileStat.mtimeMs >= cutoff) continue;
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
    const remaining = await fs.readdir(dir).catch(() => []);
    if (remaining.length === 0) await fs.rmdir(dir).catch(() => {});
  }
}
