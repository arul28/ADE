import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  ProjectPathInspection,
  WorktreeParentInfo,
} from "../../../shared/types";
import {
  findAdeManagedWorktreeRoot,
  realpathIfExists,
} from "../../../../../ade-cli/src/services/projects/projectRoots";
import { runGit } from "../git/git";
import { hasColumn, hasTable, openReadOnlyDatabase } from "./readOnlySqlite";

type ExistingLaneRow = {
  id: string;
  name: string;
  branch_ref: string;
  color: string | null;
  lane_type: string;
  worktree_path: string | null;
  attached_root_path: string | null;
};

export function normalizeInspectionPath(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? path.resolve(trimmed) : null;
}

export function readExistingParentLane(
  parentRoot: string,
  worktreeRoot: string,
): WorktreeParentInfo["existingLane"] {
  const dbPath = resolveAdeLayout(parentRoot).dbPath;
  if (!fs.existsSync(dbPath)) return null;

  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 2000");
    if (!hasTable(db, "projects") || !hasTable(db, "lanes")) return null;

    const normalizedParentRoot = normalizeInspectionPath(parentRoot);
    const project = db.prepare("select id, root_path from projects").all<{
      id: string;
      root_path: string;
    }>().find((row) => normalizeInspectionPath(row.root_path) === normalizedParentRoot);
    if (!project) return null;

    const normalizedWorktreeRoot = normalizeInspectionPath(worktreeRoot);
    const row = db.prepare(
      `
        select id, name, branch_ref, color, lane_type, worktree_path, attached_root_path
        from lanes
        where project_id = ?
          and coalesce(status, 'active') != 'archived'
          and archived_at is null
      `,
    ).all<ExistingLaneRow>(project.id).find((candidate) =>
      normalizeInspectionPath(candidate.worktree_path) === normalizedWorktreeRoot
      || normalizeInspectionPath(candidate.attached_root_path) === normalizedWorktreeRoot,
    );
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      branchRef: row.branch_ref,
      color: row.color,
      laneType: row.lane_type,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function readStandaloneProjectState(
  worktreeRoot: string,
): ProjectPathInspection["standaloneState"] {
  const dbPath = resolveAdeLayout(worktreeRoot).dbPath;
  if (!fs.existsSync(dbPath)) return null;

  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 2000");

    const laneCount = hasTable(db, "lanes")
      ? db.prepare(
        `
          select count(1) as count
          from lanes
          where coalesce(status, 'active') != 'archived'
            and archived_at is null
            and lane_type != 'primary'
        `,
      ).get<{ count?: number }>()?.count ?? 0
      : 0;
    // Legacy chat rows predate per-provider tool types and were persisted as
    // tool_type 'other' with a 'chat:' resume command (see sessionService's
    // chat enumeration) — count them too or old worktree DBs undercount.
    const includeLegacyChatRows = hasColumn(db, "terminal_sessions", "resume_command");
    const chatCount = hasTable(db, "terminal_sessions")
      && hasColumn(db, "terminal_sessions", "tool_type")
      ? db.prepare(
        `
          select count(1) as count
          from terminal_sessions
          where (
            tool_type is not null
            and (lower(tool_type) like '%-chat' or lower(tool_type) = 'cursor')
          )
          ${includeLegacyChatRows
            ? "or (tool_type = 'other' and lower(coalesce(resume_command, '')) like 'chat:%')"
            : ""}
        `,
      )
        .get<{ count?: number }>()?.count ?? 0
      : 0;

    return { chatCount, laneCount };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function toParentInfo(parentRoot: string, worktreeRoot: string): WorktreeParentInfo {
  const rootPath = realpathIfExists(parentRoot);
  const dbPath = resolveAdeLayout(rootPath).dbPath;
  return {
    rootPath,
    displayName: path.basename(rootPath),
    isKnownAdeProject: fs.existsSync(dbPath),
    existingLane: readExistingParentLane(rootPath, worktreeRoot),
  };
}

async function readBranchRef(worktreeRoot: string): Promise<string | null> {
  try {
    const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreeRoot,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) return null;
    const branchRef = result.stdout.trim();
    return branchRef && branchRef !== "HEAD" ? branchRef : null;
  } catch {
    return null;
  }
}

async function resolveLinkedParent(commonDir: string): Promise<string | null> {
  if (path.basename(commonDir) !== ".git") return null;
  const candidateParent = path.dirname(commonDir);
  try {
    if (!fs.statSync(candidateParent).isDirectory()) return null;
    const result = await runGit(["rev-parse", "--show-toplevel"], {
      cwd: candidateParent,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) return null;
    return path.resolve(result.stdout.trim()) === path.resolve(candidateParent)
      ? candidateParent
      : null;
  } catch {
    return null;
  }
}

function notGitInspection(inputPath: string): ProjectPathInspection {
  return {
    inputPath,
    worktreeRoot: null,
    kind: "not-git",
    branchRef: null,
    parent: null,
    standaloneState: null,
  };
}

export async function inspectProjectPath(selectedPath: string): Promise<ProjectPathInspection> {
  const inputPath = selectedPath.trim();
  if (!inputPath) return notGitInspection(inputPath);

  let topLevelResult;
  try {
    topLevelResult = await runGit(
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      { cwd: inputPath, timeoutMs: 10_000 },
    );
  } catch {
    return notGitInspection(inputPath);
  }
  if (topLevelResult.exitCode !== 0 || !topLevelResult.stdout.trim()) {
    return notGitInspection(inputPath);
  }

  const worktreeRoot = path.resolve(topLevelResult.stdout.trim());
  const [branchRef, standaloneState] = await Promise.all([
    readBranchRef(worktreeRoot),
    Promise.resolve(readStandaloneProjectState(worktreeRoot)),
  ]);
  const managedWorktree = findAdeManagedWorktreeRoot(worktreeRoot);
  if (managedWorktree) {
    return {
      inputPath,
      worktreeRoot,
      kind: "ade-managed-worktree",
      branchRef,
      parent: toParentInfo(managedWorktree.projectRoot, worktreeRoot),
      standaloneState,
    };
  }

  let gitDirsResult;
  try {
    gitDirsResult = await runGit(
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { cwd: worktreeRoot, timeoutMs: 10_000 },
    );
  } catch {
    gitDirsResult = null;
  }
  const gitDirLines = gitDirsResult?.exitCode === 0
    ? gitDirsResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const gitDir = normalizeInspectionPath(gitDirLines[0]);
  const commonDir = normalizeInspectionPath(gitDirLines[1]);
  if (!gitDir || !commonDir || gitDir === commonDir) {
    return {
      inputPath,
      worktreeRoot,
      kind: "repo-root",
      branchRef,
      parent: null,
      standaloneState,
    };
  }

  const parentRoot = await resolveLinkedParent(commonDir);
  return {
    inputPath,
    worktreeRoot,
    kind: "linked-worktree",
    branchRef,
    parent: parentRoot ? toParentInfo(parentRoot, worktreeRoot) : null,
    standaloneState,
  };
}

const PROJECT_PATH_INSPECTION_CACHE_TTL_MS = 10_000;
const PROJECT_PATH_INSPECTION_CACHE_MAX_ENTRIES = 64;
const projectPathInspectionCache = new Map<string, {
  expiresAtMs: number;
  promise: Promise<ProjectPathInspection>;
}>();

export function inspectProjectPathCached(
  selectedPath: string,
  opts: { fresh?: boolean } = {},
): Promise<ProjectPathInspection> {
  const now = Date.now();
  const cached = projectPathInspectionCache.get(selectedPath);
  if (!opts.fresh && cached && cached.expiresAtMs > now) {
    return cached.promise;
  }

  const promise = inspectProjectPath(selectedPath);
  projectPathInspectionCache.delete(selectedPath);
  projectPathInspectionCache.set(selectedPath, {
    expiresAtMs: Number.POSITIVE_INFINITY,
    promise,
  });
  if (projectPathInspectionCache.size > PROJECT_PATH_INSPECTION_CACHE_MAX_ENTRIES) {
    const oldestKey = projectPathInspectionCache.keys().next().value;
    if (typeof oldestKey === "string") projectPathInspectionCache.delete(oldestKey);
  }

  void promise.then(
    () => {
      const current = projectPathInspectionCache.get(selectedPath);
      if (current?.promise === promise) {
        current.expiresAtMs = Date.now() + PROJECT_PATH_INSPECTION_CACHE_TTL_MS;
      }
    },
    () => {
      if (projectPathInspectionCache.get(selectedPath)?.promise === promise) {
        projectPathInspectionCache.delete(selectedPath);
      }
    },
  );
  return promise;
}

export function invalidateProjectPathInspectionCache(): void {
  projectPathInspectionCache.clear();
}
