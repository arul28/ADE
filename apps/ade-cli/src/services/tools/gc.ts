import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { type ToolsContext, resolveContext, supersededVersionDirs } from "./install";
import { readToolsLedger, RETIRED_PACKAGE_GRACE_MS, writeToolsLedger } from "./ledger";
import { collectToolVersionOverrides } from "./overrides";
import { isToolInstalled, toolPackageDir, toolsLockRoot, toolsStagingRoot, toolVersionDir, writableRoots } from "./paths";
import { toolInstallInUse } from "./inUse";

export type GcToolsOptions = ToolsContext & {
  /** Keep the newest non-pinned version as a rollback target. Defaults to true. */
  keepPrevious?: boolean;
  dryRun?: boolean;
};

export type GcToolsResult = {
  removed: string[];
  kept: string[];
};

const STALE_STAGING_MS = 24 * 60 * 60_000;

/**
 * Drop cached versions this build no longer pins.
 *
 * With `keepPrevious` (the default) the newest superseded version of each
 * pinned package survives, so a rollback to the previous ADE build does not
 * re-download hundreds of megabytes, and a machine mid-update has a copy to run.
 *
 * A package this manifest does not pin at all is removed only when the ledger
 * (`ledger.ts`) shows ADE wrote it and no ADE build on this machine has pinned
 * it for two weeks: on a machine running two ADE channels, the other channel
 * refreshes what it pins every time it collects. A directory that is not in
 * the ledger is never touched.
 */
export async function gcTools(options: GcToolsOptions = {}): Promise<GcToolsResult> {
  const resolved = resolveContext(options);
  const keepPrevious = options.keepPrevious !== false;
  const removed: string[] = [];
  const kept: string[] = [];

  const pinnedVersionsByPackage = new Map<string, Set<string>>();
  for (const tool of resolved.manifest.tools) {
    for (const targetPin of Object.values(tool.targets)) {
      if (!targetPin) continue;
      const versions = pinnedVersionsByPackage.get(targetPin.package) ?? new Set<string>();
      versions.add(targetPin.version);
      pinnedVersionsByPackage.set(targetPin.package, versions);
    }
  }

  // A vendor-forced newer build (`overrides.ts`) is kept like a pin, and kept
  // out of the superseded ranking so the real previous pin survives beside it.
  const overrideVersions = await collectToolVersionOverrides(resolved.layout.primary, pinnedVersionsByPackage, {
    dryRun: options.dryRun === true,
  });
  const { layout } = resolved;
  // Where a copy in the fallback root (home) is a duplicate: the same version
  // finished in a baked root or the primary, which resolution takes first.
  const aheadOfFallback = [...layout.baked, layout.primary];
  // Every root ADE writes (a system cache and the home fallback); never an
  // image's baked root. Each keeps its own previous version and ledger. An
  // install a process of this one runs from is never removed.
  for (const root of writableRoots(layout)) {
    const presentPinnedPackages: string[] = [];
    for (const [packageName, pinnedVersions] of pinnedVersionsByPackage) {
      const packageDir = toolPackageDir(root, packageName);
      if (fs.existsSync(packageDir)) presentPinnedPackages.push(packageName);
      const keptVersions = new Set([...pinnedVersions, ...(overrideVersions.get(packageName) ?? [])]);
      const doomed: string[] = [];
      for (const version of keptVersions) {
        const versionDir = toolVersionDir(root, packageName, version);
        if (!fs.existsSync(versionDir)) continue;
        const duplicate = root === layout.fallback
          && aheadOfFallback.some((ahead) => isToolInstalled(toolVersionDir(ahead, packageName, version)));
        if (duplicate && !toolInstallInUse(versionDir)) doomed.push(versionDir);
        else kept.push(versionDir);
      }
      const superseded = supersededVersionDirs(packageDir, keptVersions);
      if (keepPrevious && superseded[0]) kept.push(superseded[0].dir);
      for (const candidate of keepPrevious ? superseded.slice(1) : superseded) {
        if (toolInstallInUse(candidate.dir)) kept.push(candidate.dir);
        else doomed.push(candidate.dir);
      }
      for (const dir of doomed) {
        if (!options.dryRun) await fsp.rm(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }

    await collectRetiredPackages(root, pinnedVersionsByPackage, presentPinnedPackages, options.dryRun === true, removed);
    await collectStaleScratch(root, options.dryRun === true, removed);
  }
  return { removed, kept };
}

/**
 * Refresh the ledger for every package this build pins and has on disk, then
 * remove ledger packages no build has pinned within the grace period.
 */
async function collectRetiredPackages(
  toolsRoot: string,
  pinnedVersionsByPackage: ReadonlyMap<string, ReadonlySet<string>>,
  presentPinnedPackages: readonly string[],
  dryRun: boolean,
  removed: string[],
): Promise<void> {
  const now = Date.now();
  const ledger = await readToolsLedger(toolsRoot);
  for (const packageName of presentPinnedPackages) ledger.packages[packageName] = now;
  const root = path.resolve(toolsRoot);
  for (const [packageName, lastPinnedAt] of Object.entries(ledger.packages)) {
    if (pinnedVersionsByPackage.has(packageName) || now - lastPinnedAt < RETIRED_PACKAGE_GRACE_MS) continue;
    const packageDir = toolPackageDir(root, packageName);
    // The ledger is a file on disk; the name was validated when read, and the
    // directory must still resolve under the tools root.
    const relative = path.relative(root, packageDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (toolInstallInUse(packageDir)) continue;
    if (fs.existsSync(packageDir)) {
      if (!dryRun) {
        try {
          await fsp.rm(packageDir, { recursive: true, force: true });
        } catch {
          // In use (a running binary on Windows) or unreadable: keep the ledger
          // entry so the next collection tries again.
          continue;
        }
        await removeEmptyScopeDir(root, packageDir);
      }
      removed.push(packageDir);
    }
    if (!dryRun) delete ledger.packages[packageName];
  }
  if (!dryRun) await writeToolsLedger(toolsRoot, ledger).catch(() => undefined);
}

/** `@scope/name` leaves `@scope/` behind; drop it once it holds nothing. */
async function removeEmptyScopeDir(root: string, packageDir: string): Promise<void> {
  const parent = path.dirname(packageDir);
  if (parent === root || !path.basename(parent).startsWith("@")) return;
  try {
    if ((await fsp.readdir(parent)).length === 0) await fsp.rmdir(parent);
  } catch {
    // Someone else is installing into the scope; leave it.
  }
}

/** Abandoned staging dirs and orphaned locks from processes that died mid-install. */
async function collectStaleScratch(toolsRoot: string, dryRun: boolean, removed: string[]): Promise<void> {
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const scratchRoot of [toolsStagingRoot(toolsRoot), toolsLockRoot(toolsRoot)]) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(scratchRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const scratchPath = path.join(scratchRoot, entry.name);
      try {
        if ((await fsp.stat(scratchPath)).mtimeMs > cutoff) continue;
      } catch {
        continue;
      }
      if (!dryRun) await fsp.rm(scratchPath, { recursive: true, force: true }).catch(() => undefined);
      removed.push(scratchPath);
    }
  }
}
