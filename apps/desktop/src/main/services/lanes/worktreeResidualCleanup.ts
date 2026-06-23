import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";

type ResidualCleanupGitWorktreeInfo = {
  path: string;
  isBare: boolean;
};

type LocalWorktreeResidualCleanupRow = {
  id: string;
  project_id: string;
  lane_id: string;
  branch_ref: string | null;
  worktree_path: string;
  reason: "delete_residual";
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type WorktreeResidualCleanupDeps = {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  worktreesDir: string;
  logger: Logger;
  listGitWorktrees: () => Promise<ResidualCleanupGitWorktreeInfo[]>;
  isPendingWorktreeCreation: (worktreePath: string) => boolean;
  removeWorktreeDirectory: (worktreePath: string) => Promise<void>;
};

const RESIDUAL_WORKTREE_CLEANUP_SWEEP_TTL_MS = 60_000;
const RESIDUAL_WORKTREE_EMPTY_SCAN_ENTRY_LIMIT = 256;
const RESIDUAL_WORKTREE_ERROR_MAX_LENGTH = 2_000;
const UNKNOWN_EMPTY_WORKTREE_MIN_AGE_MS = 10 * 60_000;

function normAbs(value: string): string {
  return path.resolve(value);
}

export function createWorktreeResidualCleanup({
  db,
  projectId,
  projectRoot,
  worktreesDir,
  logger,
  listGitWorktrees,
  isPendingWorktreeCreation,
  removeWorktreeDirectory,
}: WorktreeResidualCleanupDeps) {
  const normalizedProjectRoot = normAbs(projectRoot);
  const normalizedWorktreesDir = normAbs(worktreesDir);
  let lastSweepAt = 0;
  let activeSweep: Promise<void> | null = null;

  const isDirectManagedWorktreePath = (worktreePath: string): boolean => {
    const normalized = normAbs(worktreePath);
    return (
      normalized !== normalizedProjectRoot &&
      normalized !== normalizedWorktreesDir &&
      path.dirname(normalized) === normalizedWorktreesDir &&
      path.basename(normalized).trim().length > 0
    );
  };

  const normalizeCleanupError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > RESIDUAL_WORKTREE_ERROR_MAX_LENGTH
      ? `${message.slice(0, RESIDUAL_WORKTREE_ERROR_MAX_LENGTH)}...`
      : message;
  };

  const listRows = (): LocalWorktreeResidualCleanupRow[] =>
    db.all<LocalWorktreeResidualCleanupRow>(
      `
        select *
        from local_worktree_residual_cleanups
        where project_id = ?
        order by updated_at asc
      `,
      [projectId],
    );

  const deleteRow = (worktreePath: string): void => {
    db.run(
      "delete from local_worktree_residual_cleanups where project_id = ? and worktree_path = ?",
      [projectId, normAbs(worktreePath)],
    );
  };

  const recordFailure = (args: {
    laneId: string;
    branchRef: string | null;
    worktreePath: string;
    error: unknown;
  }): void => {
    const worktreePath = normAbs(args.worktreePath);
    if (!isDirectManagedWorktreePath(worktreePath)) {
      logger.warn("lane.delete.residual_cleanup_not_recorded_unsafe_path", {
        laneId: args.laneId,
        worktreePath,
      });
      return;
    }
    if (!fs.existsSync(worktreePath)) {
      deleteRow(worktreePath);
      return;
    }

    const now = new Date().toISOString();
    db.run(
      `
        insert into local_worktree_residual_cleanups(
          id, project_id, lane_id, branch_ref, worktree_path, reason, attempts, last_error, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, 'delete_residual', 0, ?, ?, ?)
        on conflict(project_id, worktree_path) do update set
          lane_id = excluded.lane_id,
          branch_ref = excluded.branch_ref,
          reason = excluded.reason,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `,
      [
        randomUUID(),
        projectId,
        args.laneId,
        args.branchRef,
        worktreePath,
        normalizeCleanupError(args.error),
        now,
        now,
      ],
    );
    lastSweepAt = 0;
  };

  const noteRetryFailure = (row: LocalWorktreeResidualCleanupRow, error: unknown): void => {
    db.run(
      `
        update local_worktree_residual_cleanups
        set attempts = attempts + 1,
            last_error = ?,
            updated_at = ?
        where project_id = ? and worktree_path = ?
      `,
      [normalizeCleanupError(error), new Date().toISOString(), projectId, normAbs(row.worktree_path)],
    );
  };

  const directoryHasFilesOrSymlinks = async (
    targetPath: string,
    state: { visited: number } = { visited: 0 },
  ): Promise<boolean> => {
    if (state.visited > RESIDUAL_WORKTREE_EMPTY_SCAN_ENTRY_LIMIT) return true;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
    } catch {
      return true;
    }

    for (const entry of entries) {
      state.visited += 1;
      if (state.visited > RESIDUAL_WORKTREE_EMPTY_SCAN_ENTRY_LIMIT) return true;
      const childPath = path.join(targetPath, entry.name);
      if (entry.isSymbolicLink()) return true;
      if (!entry.isDirectory()) return true;
      if (await directoryHasFilesOrSymlinks(childPath, state)) return true;
    }
    return false;
  };

  const isOldEnoughUnknownEmptyResidual = async (targetPath: string, nowMs: number): Promise<boolean> => {
    try {
      const stat = await fs.promises.lstat(targetPath);
      return nowMs - stat.mtimeMs >= UNKNOWN_EMPTY_WORKTREE_MIN_AGE_MS;
    } catch {
      return false;
    }
  };

  const retry = async (options: { force?: boolean } = {}): Promise<void> => {
    const nowMs = Date.now();
    if (!options.force && nowMs - lastSweepAt < RESIDUAL_WORKTREE_CLEANUP_SWEEP_TTL_MS) {
      return activeSweep ?? Promise.resolve();
    }
    if (activeSweep) return activeSweep;

    activeSweep = (async () => {
      lastSweepAt = Date.now();
      if (!fs.existsSync(normalizedWorktreesDir)) return;

      let gitWorktrees: ResidualCleanupGitWorktreeInfo[];
      try {
        gitWorktrees = await listGitWorktrees();
      } catch (error) {
        logger.warn("lane.residual_worktree_cleanup.git_worktree_list_failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const gitWorktreePaths = new Set(gitWorktrees.filter((wt) => !wt.isBare).map((wt) => normAbs(wt.path)));
      const laneWorktreePaths = new Set(
        db.all<{ worktree_path: string }>(
          "select worktree_path from lanes where project_id = ?",
          [projectId],
        ).map((row) => normAbs(row.worktree_path)),
      );

      const rowsByPath = new Map<string, LocalWorktreeResidualCleanupRow>();
      for (const row of listRows()) {
        const pathKey = normAbs(row.worktree_path);
        if (!isDirectManagedWorktreePath(pathKey)) {
          deleteRow(pathKey);
          logger.warn("lane.residual_worktree_cleanup.dropped_unsafe_record", {
            projectRoot,
            laneId: row.lane_id,
            worktreePath: pathKey,
          });
          continue;
        }
        rowsByPath.set(pathKey, { ...row, worktree_path: pathKey });
      }

      const candidatePaths = new Set(rowsByPath.keys());
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = await fs.promises.readdir(normalizedWorktreesDir, { withFileTypes: true });
      } catch (error) {
        logger.warn("lane.residual_worktree_cleanup.readdir_failed", {
          projectRoot,
          worktreesDir: normalizedWorktreesDir,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const sweepStartedAt = Date.now();
      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        const childPath = normAbs(path.join(normalizedWorktreesDir, entry.name));
        if (rowsByPath.has(childPath)) continue;
        if (gitWorktreePaths.has(childPath) || laneWorktreePaths.has(childPath)) continue;
        if (isPendingWorktreeCreation(childPath)) continue;
        if (
          !(await directoryHasFilesOrSymlinks(childPath)) &&
          await isOldEnoughUnknownEmptyResidual(childPath, sweepStartedAt)
        ) {
          candidatePaths.add(childPath);
        }
      }

      for (const candidatePath of candidatePaths) {
        const pathKey = normAbs(candidatePath);
        const row = rowsByPath.get(pathKey);
        if (!isDirectManagedWorktreePath(pathKey)) {
          if (row) deleteRow(pathKey);
          continue;
        }
        if (isPendingWorktreeCreation(pathKey)) continue;
        if (gitWorktreePaths.has(pathKey) || laneWorktreePaths.has(pathKey)) continue;
        if (!fs.existsSync(pathKey)) {
          if (row) deleteRow(pathKey);
          continue;
        }
        if (!row && (await directoryHasFilesOrSymlinks(pathKey))) continue;

        try {
          await removeWorktreeDirectory(pathKey);
          if (row) deleteRow(pathKey);
          logger.info("lane.residual_worktree_cleanup.removed", {
            projectRoot,
            laneId: row?.lane_id ?? null,
            worktreePath: pathKey,
            source: row ? "delete_residual" : "empty_untracked_dir",
          });
        } catch (error) {
          if (row) {
            noteRetryFailure(row, error);
          }
          logger.warn("lane.residual_worktree_cleanup.remove_failed", {
            projectRoot,
            laneId: row?.lane_id ?? null,
            worktreePath: pathKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })().finally(() => {
      activeSweep = null;
    });

    return activeSweep;
  };

  return {
    deleteRow,
    recordFailure,
    retry,
  };
}
