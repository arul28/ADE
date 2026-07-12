import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  StorageCategoryId,
  StorageCategorySnapshot,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageItem,
  StorageSafety,
  StorageSnapshot,
} from "../../../shared/types/storage";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_SCAN_ENTRY_LIMIT = 200_000;
const DEFAULT_SCAN_BUDGET_MS = 20_000;
const WALK_CONCURRENCY = 8;
const MAX_CATEGORY_ITEMS = 50;
const STALE_AGE_MS = 7 * 24 * 60 * 60_000;
const COMPRESSIBLE_AGE_MS = 30 * 24 * 60 * 60_000;
const RECOVERY_BACKUP_PATTERN = /(?:\.pre-crsqlite-w1\.bak|\.recovery-.*\.bak)$/;

type LaneRow = {
  id: string;
  name: string;
  worktree_path: string;
  archived_at: string | null;
};

type WalkState = {
  startedAt: number;
  entries: number;
  entryLimit: number;
  budgetMs: number;
  truncated: boolean;
};

type PathSize = {
  bytes: number;
  fileCount: number;
  lastModifiedMs: number | null;
  oldFileBytes: number;
};

type ValidatedTarget = {
  target: StorageCleanupTarget;
  path: string;
  bytes: number;
  label: string;
  identity: string;
};

export type StorageInsightsServiceOptions = {
  projectRoot: string;
  adeHome: string;
  db: AdeDb;
  logger: Logger;
  cacheTtlMs?: number;
  scanEntryLimit?: number;
  scanBudgetMs?: number;
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isSameOrWithin(parent: string, candidate: string): boolean {
  return path.resolve(parent) === path.resolve(candidate) || isWithin(parent, candidate);
}

function isDirectChild(parent: string, candidate: string): boolean {
  const normalizedParent = path.resolve(parent);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate !== normalizedParent
    && path.dirname(normalizedCandidate) === normalizedParent
    && path.basename(normalizedCandidate).trim().length > 0;
}

function isoOrNull(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function itemId(category: StorageCategoryId, base: string, itemPath: string): string {
  const relative = path.relative(base, itemPath) || path.basename(itemPath);
  return `${category}:${relative.split(path.sep).join("/")}`;
}

function dominantSafety(items: StorageItem[], fallback: StorageSafety): StorageSafety {
  const rank: Record<StorageSafety, number> = {
    safe_to_remove: 0,
    compressible: 1,
    review_first: 2,
    protected: 3,
  };
  return items.reduce((result, item) => rank[item.safety] > rank[result] ? item.safety : result, fallback);
}

async function lstatOrNull(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function hasSymlinkAncestor(anchorPath: string, targetPath: string): Promise<boolean> {
  const anchor = path.resolve(anchorPath);
  const target = path.resolve(targetPath);
  if (!isSameOrWithin(anchor, target)) return true;
  const relative = path.relative(anchor, target);
  const segments = relative ? relative.split(path.sep) : [];
  let current = anchor;
  const pathsToCheck = [current];
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    pathsToCheck.push(current);
  }
  for (const candidate of pathsToCheck) {
    const stat = await lstatOrNull(candidate);
    if (stat?.isSymbolicLink()) return true;
  }
  return false;
}

async function walkPath(
  rootPath: string,
  state: WalkState | null,
  excludedRoots: readonly string[] = [],
): Promise<PathSize> {
  const result: PathSize = { bytes: 0, fileCount: 0, lastModifiedMs: null, oldFileBytes: 0 };
  const pending = [path.resolve(rootPath)];
  const oldBefore = Date.now() - COMPRESSIBLE_AGE_MS;

  while (pending.length > 0) {
    if (state && (state.entries >= state.entryLimit || Date.now() - state.startedAt >= state.budgetMs)) {
      state.truncated = true;
      break;
    }
    const batch = pending.splice(0, WALK_CONCURRENCY);
    const inspected = await Promise.all(batch.map(async (currentPath) => {
      if (excludedRoots.some((excluded) => isSameOrWithin(excluded, currentPath))) return null;
      if (state) {
        if (state.entries >= state.entryLimit) {
          state.truncated = true;
          return null;
        }
        state.entries += 1;
      }
      const stat = await lstatOrNull(currentPath);
      if (!stat) return null;
      if (!stat.isDirectory()) return { currentPath, stat, children: [] as string[] };
      let names: string[];
      try {
        names = await fs.promises.readdir(currentPath);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      return { currentPath, stat, children: names.map((name) => path.join(currentPath, name)) };
    }));

    for (const entry of inspected) {
      if (!entry) continue;
      result.lastModifiedMs = Math.max(result.lastModifiedMs ?? 0, entry.stat.mtimeMs);
      if (entry.stat.isDirectory()) {
        pending.push(...entry.children);
      } else {
        result.bytes += entry.stat.size;
        result.fileCount += 1;
        if (entry.stat.mtimeMs < oldBefore) result.oldFileBytes += entry.stat.size;
      }
    }
  }
  return result;
}

function volumeFor(projectRoot: string): { freeBytes: number; totalBytes: number } {
  try {
    const stat = fs.statfsSync(projectRoot, { bigint: true });
    return {
      freeBytes: Number(stat.bavail * stat.bsize),
      totalBytes: Number(stat.blocks * stat.bsize),
    };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

export function createStorageInsightsService(options: StorageInsightsServiceOptions) {
  const projectRoot = path.resolve(options.projectRoot);
  const adeHome = path.resolve(options.adeHome);
  const layout = resolveAdeLayout(projectRoot);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const scanEntryLimit = options.scanEntryLimit ?? DEFAULT_SCAN_ENTRY_LIMIT;
  const scanBudgetMs = options.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  let cachedSnapshot: { value: StorageSnapshot; createdAt: number } | null = null;
  const previewIdentities = new Map<string, string>();

  const listLaneRows = (): LaneRow[] => options.db.all<LaneRow>(
    "select id, name, worktree_path, archived_at from lanes",
  );

  const laneForPath = (targetPath: string, laneId?: string): LaneRow | null => {
    const normalized = path.resolve(targetPath);
    const basename = path.basename(normalized);
    return listLaneRows().find((row) => {
      if (laneId && row.id !== laneId) return false;
      return path.resolve(row.worktree_path) === normalized || path.basename(row.worktree_path) === basename;
    }) ?? null;
  };

  const makeItem = async (args: {
    category: StorageCategoryId;
    base: string;
    path: string;
    label: string;
    safety: StorageSafety;
    state: WalkState;
    detail?: string;
    laneStatus?: StorageItem["laneStatus"];
    excludedRoots?: string[];
  }): Promise<{ item: StorageItem; oldFileBytes: number } | null> => {
    const anchor = isSameOrWithin(projectRoot, args.path)
      ? projectRoot
      : isSameOrWithin(adeHome, args.path)
        ? adeHome
        : args.base;
    if (await hasSymlinkAncestor(anchor, args.path)) return null;
    const stat = await lstatOrNull(args.path);
    if (!stat) return null;
    const size = await walkPath(args.path, args.state, args.excludedRoots);
    return {
      item: {
        id: itemId(args.category, args.base, args.path),
        label: args.label,
        path: args.path,
        bytes: size.bytes,
        fileCount: size.fileCount,
        lastModifiedAt: isoOrNull(size.lastModifiedMs ?? stat.mtimeMs),
        safety: args.safety,
        ...(args.detail ? { detail: args.detail } : {}),
        ...(args.laneStatus ? { laneStatus: args.laneStatus } : {}),
      },
      oldFileBytes: size.oldFileBytes,
    };
  };

  const buildCategory = (
    id: StorageCategoryId,
    allItems: StorageItem[],
    fallbackSafety: StorageSafety,
    state: WalkState,
    compressibleBytes?: number,
  ): StorageCategorySnapshot => {
    const sorted = [...allItems].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
    if (sorted.length > MAX_CATEGORY_ITEMS) state.truncated = true;
    return {
      id,
      bytes: allItems.reduce((sum, item) => sum + item.bytes, 0),
      fileCount: allItems.reduce((sum, item) => sum + item.fileCount, 0),
      safety: dominantSafety(allItems, fallbackSafety),
      items: sorted.slice(0, MAX_CATEGORY_ITEMS),
      ...(compressibleBytes == null ? {} : { compressibleBytes }),
    };
  };

  const getSnapshot = async (args: { forceRefresh?: boolean } = {}): Promise<StorageSnapshot> => {
    if (!args.forceRefresh && cachedSnapshot && Date.now() - cachedSnapshot.createdAt < cacheTtlMs) {
      return cachedSnapshot.value;
    }
    const startedAt = Date.now();
    const state: WalkState = { startedAt, entries: 0, entryLimit: scanEntryLimit, budgetMs: scanBudgetMs, truncated: false };
    const categoryItems = new Map<StorageCategoryId, StorageItem[]>();
    const add = (category: StorageCategoryId, value: StorageItem | null | undefined) => {
      if (!value) return;
      const items = categoryItems.get(category) ?? [];
      items.push(value);
      categoryItems.set(category, items);
    };

    let compressibleBytes = 0;
    for (const [chatPath, label] of [
      [layout.transcriptsDir, "Chat and terminal history"],
      [path.join(layout.cacheDir, "terminal-snapshots"), "Terminal snapshots"],
    ] as const) {
      const entry = await makeItem({ category: "chats_history", base: layout.adeDir, path: chatPath, label, safety: "compressible", state });
      if (entry) {
        add("chats_history", entry.item);
        compressibleBytes += entry.oldFileBytes;
      }
    }

    const lanes = listLaneRows();
    let worktreeNames: string[] = [];
    try {
      worktreeNames = await fs.promises.readdir(layout.worktreesDir);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const name of worktreeNames) {
      const worktreePath = path.join(layout.worktreesDir, name);
      const stat = await lstatOrNull(worktreePath);
      if (!stat) continue;
      const row = lanes.find((candidate) => path.resolve(candidate.worktree_path) === path.resolve(worktreePath)
        || path.basename(candidate.worktree_path) === name);
      const laneStatus: StorageItem["laneStatus"] = !row ? "orphaned" : row.archived_at ? "archived" : "active";
      const entry = await makeItem({
        category: "lanes_worktrees",
        base: layout.worktreesDir,
        path: worktreePath,
        label: row?.name ?? name,
        safety: laneStatus === "active" ? "protected" : "review_first",
        state,
        laneStatus,
        ...(laneStatus === "archived"
          ? { detail: "Archived lane — its files are kept until you remove them" }
          : laneStatus === "orphaned"
            ? { detail: "Left over from a deleted lane" }
            : {}),
      });
      add("lanes_worktrees", entry?.item);
    }

    let tempNames: string[] = [];
    try {
      tempNames = await fs.promises.readdir(os.tmpdir());
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const name of tempNames.filter((value) => /^ade-/.test(value))) {
      const tempPath = path.join(os.tmpdir(), name);
      if (path.resolve(tempPath) === projectRoot || path.resolve(tempPath) === adeHome) continue;
      const stat = await lstatOrNull(tempPath);
      if (!stat) continue;
      const stale = Date.now() - stat.mtimeMs > STALE_AGE_MS;
      const entry = await makeItem({
        category: "build_release",
        base: os.tmpdir(),
        path: tempPath,
        label: "Release and build staging",
        safety: stale ? "safe_to_remove" : "review_first",
        state,
        detail: stale ? "Old staging files are no longer in use" : "A current operation may still be using these files",
      });
      add("build_release", entry?.item);
    }
    const derivedData = path.join(layout.cacheDir, "ios-simulator", "DerivedData");
    add("build_release", (await makeItem({
      category: "build_release",
      base: layout.adeDir,
      path: derivedData,
      label: "iOS build data",
      safety: "safe_to_remove",
      state,
      detail: "Recreated the next time you build",
    }))?.item);

    let cacheNames: string[] = [];
    try {
      cacheNames = await fs.promises.readdir(layout.cacheDir);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const name of cacheNames) {
      if (name === "terminal-snapshots") continue;
      const cachePath = path.join(layout.cacheDir, name);
      const protectedItem = name === "chat-sessions";
      const entry = await makeItem({
        category: "caches",
        base: layout.cacheDir,
        path: cachePath,
        label: protectedItem ? "Chat session records" : name,
        safety: protectedItem ? "protected" : "safe_to_remove",
        state,
        ...(protectedItem ? { detail: "Required to keep existing chats available" } : { detail: "Recreated when needed" }),
        ...(name === "ios-simulator" ? { excludedRoots: [derivedData] } : {}),
      });
      if (entry && (entry.item.bytes > 0 || name !== "ios-simulator")) add("caches", entry.item);
    }

    const updatesDir = path.join(adeHome, "runtime", "updates");
    let updateNames: string[] = [];
    try {
      updateNames = await fs.promises.readdir(updatesDir);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const name of updateNames) {
      const updatePath = path.join(updatesDir, name);
      const stat = await lstatOrNull(updatePath);
      if (!stat) continue;
      const stale = Date.now() - stat.mtimeMs > STALE_AGE_MS;
      add("caches", (await makeItem({
        category: "caches",
        base: updatesDir,
        path: updatePath,
        label: "App update staging",
        safety: stale ? "safe_to_remove" : "review_first",
        state,
        detail: stale ? "Old update files are no longer needed" : "An update may still be using these files",
      }))?.item);
    }

    for (const [proofPath, label] of [
      [layout.artifactsDir, "Proof and recordings"],
      [path.join(layout.adeDir, "attachments"), "Attachments"],
    ] as const) {
      add("proof_attachments", (await makeItem({
        category: "proof_attachments",
        base: layout.adeDir,
        path: proofPath,
        label,
        safety: "review_first",
        state,
      }))?.item);
    }

    let adeNames: string[] = [];
    try {
      adeNames = await fs.promises.readdir(layout.adeDir);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const name of adeNames.filter((value) => RECOVERY_BACKUP_PATTERN.test(value))) {
      const backupPath = path.join(layout.adeDir, name);
      add("recovery_backups", (await makeItem({
        category: "recovery_backups",
        base: layout.adeDir,
        path: backupPath,
        label: "Recovery backup",
        safety: "review_first",
        state,
      }))?.item);
    }

    for (const databasePath of [layout.dbPath, `${layout.dbPath}-wal`, `${layout.dbPath}-shm`]) {
      add("database", (await makeItem({
        category: "database",
        base: layout.adeDir,
        path: databasePath,
        label: databasePath === layout.dbPath ? "Project database" : "Project database support file",
        safety: "protected",
        state,
      }))?.item);
    }

    const categories = [
      buildCategory("chats_history", categoryItems.get("chats_history") ?? [], "compressible", state, compressibleBytes),
      buildCategory("lanes_worktrees", categoryItems.get("lanes_worktrees") ?? [], "review_first", state),
      buildCategory("build_release", categoryItems.get("build_release") ?? [], "safe_to_remove", state),
      buildCategory("caches", categoryItems.get("caches") ?? [], "safe_to_remove", state),
      buildCategory("proof_attachments", categoryItems.get("proof_attachments") ?? [], "review_first", state),
      buildCategory("recovery_backups", categoryItems.get("recovery_backups") ?? [], "review_first", state),
      buildCategory("database", categoryItems.get("database") ?? [], "protected", state),
    ];
    const snapshot: StorageSnapshot = {
      generatedAt: new Date().toISOString(),
      projectRoot,
      volume: volumeFor(projectRoot),
      totalAdeBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
      categories,
      scanDurationMs: Date.now() - startedAt,
      truncated: state.truncated,
    };
    if (state.truncated) {
      options.logger.warn("storage.scan_truncated", { projectRoot, entries: state.entries, entryLimit: state.entryLimit, budgetMs: state.budgetMs });
    }
    cachedSnapshot = { value: snapshot, createdAt: Date.now() };
    return snapshot;
  };

  const validateTarget = async (target: StorageCleanupTarget): Promise<{ valid: ValidatedTarget | null; reason?: string }> => {
    if (!target || typeof target.path !== "string" || !path.isAbsolute(target.path)) {
      return { valid: null, reason: "The cleanup path must be an absolute path." };
    }
    const targetPath = path.resolve(target.path);
    const stat = await lstatOrNull(targetPath);
    if (!stat) return { valid: null, reason: "This item no longer exists." };
    if (stat.isSymbolicLink()) return { valid: null, reason: "Links cannot be removed by storage cleanup." };

    let label = path.basename(targetPath);
    if (target.kind === "orphaned_worktree" || target.kind === "archived_lane_worktree") {
      if (await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      if (!isDirectChild(layout.worktreesDir, targetPath)) {
        return { valid: null, reason: "This path is not a managed lane worktree." };
      }
      const lane = laneForPath(targetPath, target.kind === "archived_lane_worktree" ? target.laneId : undefined);
      if (target.kind === "orphaned_worktree" && lane) {
        return { valid: null, reason: lane.archived_at ? "This lane is archived; select it as an archived lane." : "Active lane files are protected." };
      }
      if (target.kind === "archived_lane_worktree" && (!lane || !lane.archived_at)) {
        return { valid: null, reason: lane ? "Active lane files are protected." : "This lane is not archived." };
      }
      label = lane?.name ?? path.basename(targetPath);
    } else if (target.kind === "stale_tmp_staging") {
      if (!isDirectChild(os.tmpdir(), targetPath) || !/^ade-/.test(path.basename(targetPath))) {
        return { valid: null, reason: "This path is not ADE staging data." };
      }
      if (targetPath === projectRoot || targetPath === adeHome) {
        return { valid: null, reason: "Project data is protected." };
      }
      if (Date.now() - stat.mtimeMs <= STALE_AGE_MS) {
        return { valid: null, reason: "This staging data may still be in use." };
      }
      label = "Old release staging";
    } else if (target.kind === "rebuildable_cache") {
      if (await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      if (!isWithin(layout.cacheDir, targetPath)) {
        return { valid: null, reason: "This path is not a rebuildable project cache." };
      }
      if (isSameOrWithin(layout.chatSessionsDir, targetPath)) {
        return { valid: null, reason: "Chat session records are protected." };
      }
      if (isSameOrWithin(path.join(layout.cacheDir, "terminal-snapshots"), targetPath)) {
        return { valid: null, reason: "Terminal history is protected from automatic cleanup." };
      }
      label = "Rebuildable cache";
    } else if (target.kind === "recovery_backup") {
      if (await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      if (path.dirname(targetPath) !== layout.adeDir || !RECOVERY_BACKUP_PATTERN.test(path.basename(targetPath))) {
        return { valid: null, reason: "This path is not a project recovery backup." };
      }
      if (!stat.isFile()) return { valid: null, reason: "Recovery backups must be files." };
      label = "Recovery backup";
    } else {
      return { valid: null, reason: "This cleanup target is not supported." };
    }

    const size = await walkPath(targetPath, null);
    const identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, size.bytes, size.lastModifiedMs ?? 0].join(":");
    return { valid: { target, path: targetPath, bytes: size.bytes, label, identity } };
  };

  const cleanupPreview = async (targets: StorageCleanupTarget[]): Promise<StorageCleanupPreview> => {
    const items: StorageCleanupPreview["items"] = [];
    const blocked: StorageCleanupPreview["blocked"] = [];
    const seen = new Set<string>();
    for (const target of Array.isArray(targets) ? targets : []) {
      const targetPath = typeof target?.path === "string" ? target.path : "";
      const normalized = path.isAbsolute(targetPath) ? path.resolve(targetPath) : targetPath;
      if (seen.has(normalized)) {
        blocked.push({ path: targetPath, reason: "This cleanup item was selected more than once." });
        continue;
      }
      seen.add(normalized);
      const checked = await validateTarget(target);
      if (!checked.valid) {
        blocked.push({ path: targetPath, reason: checked.reason ?? "This item cannot be removed." });
        continue;
      }
      items.push({ path: checked.valid.path, bytes: checked.valid.bytes, label: checked.valid.label });
      previewIdentities.set(checked.valid.path, checked.valid.identity);
    }
    return { items, totalBytes: items.reduce((sum, item) => sum + item.bytes, 0), blocked };
  };

  const removeWorktree = async (targetPath: string): Promise<void> => {
    const removeResult = await runGit(["worktree", "remove", "--force", targetPath], { cwd: projectRoot, timeoutMs: 30_000 });
    if (removeResult.exitCode !== 0) {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
    }
    await runGit(["worktree", "prune"], { cwd: projectRoot, timeoutMs: 30_000 }).catch(() => null);
  };

  const cleanup = async (
    targets: StorageCleanupTarget[],
    opts: { preview: StorageCleanupPreview },
  ): Promise<StorageCleanupResult> => {
    const removed: StorageCleanupResult["removed"] = [];
    const failed: StorageCleanupResult["failed"] = [];
    const previewByPath = new Map((opts?.preview?.items ?? []).map((item) => [path.resolve(item.path), item]));
    const seen = new Set<string>();

    for (const target of Array.isArray(targets) ? targets : []) {
      const rawPath = typeof target?.path === "string" ? target.path : "";
      const normalized = path.isAbsolute(rawPath) ? path.resolve(rawPath) : rawPath;
      if (seen.has(normalized)) {
        failed.push({ path: rawPath, reason: "This cleanup item was selected more than once." });
        continue;
      }
      seen.add(normalized);
      const previewItem = path.isAbsolute(rawPath) ? previewByPath.get(path.resolve(rawPath)) : undefined;
      if (!previewItem) {
        failed.push({ path: rawPath, reason: "This item was not included in the confirmed preview." });
        continue;
      }
      const checked = await validateTarget(target);
      if (!checked.valid) {
        failed.push({ path: rawPath, reason: checked.reason ?? "This item cannot be removed." });
        continue;
      }
      if (checked.valid.bytes !== previewItem.bytes) {
        failed.push({ path: rawPath, reason: "This item changed after the preview. Preview it again before removing it." });
        continue;
      }
      if (previewIdentities.get(checked.valid.path) !== checked.valid.identity) {
        failed.push({ path: rawPath, reason: "This item changed after the preview. Preview it again before removing it." });
        continue;
      }
      try {
        if (target.kind === "orphaned_worktree" || target.kind === "archived_lane_worktree") {
          await removeWorktree(checked.valid.path);
        } else {
          await fs.promises.rm(checked.valid.path, { recursive: true, force: false });
        }
        removed.push({ path: checked.valid.path, bytes: checked.valid.bytes });
      } catch (error) {
        failed.push({ path: rawPath, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const result: StorageCleanupResult = {
      removed,
      failed,
      freedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    };
    cachedSnapshot = null;
    options.logger.info("storage.cleanup_completed", {
      projectRoot,
      requestedCount: Array.isArray(targets) ? targets.length : 0,
      removedCount: removed.length,
      failedCount: failed.length,
      freedBytes: result.freedBytes,
    });
    return result;
  };

  return { getSnapshot, cleanupPreview, cleanup };
}
