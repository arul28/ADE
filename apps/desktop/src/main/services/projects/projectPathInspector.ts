import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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

type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: { allowExtension?: boolean; readOnly?: boolean },
) => DatabaseSyncType;

const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

type ExistingLaneRow = {
  id: string;
  name: string;
  branch_ref: string;
  color: string | null;
  lane_type: string;
  worktree_path: string | null;
  attached_root_path: string | null;
};

function hasTable(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(
    db.prepare("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1")
      .get<{ present?: number }>(tableName)?.present,
  );
}

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
    db = new DatabaseSync(dbPath, { readOnly: true });
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
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");

    const laneCount = hasTable(db, "lanes")
      ? db.prepare(
        `
          select count(1) as count
          from lanes
          where coalesce(status, 'active') != 'archived'
            and archived_at is null
        `,
      ).get<{ count?: number }>()?.count ?? 0
      : 0;
    const chatCount = hasTable(db, "claude_sessions")
      ? db.prepare("select count(1) as count from claude_sessions")
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
