import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import { runGit, runGitOrThrow } from "../git/git";
import type { AttachLaneArgs, DeleteLaneArgs, LaneStatus, LaneSummary, LaneType } from "../../../shared/types";

function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length ? s : "lane";
}

function normAbs(p: string): string {
  return path.resolve(p);
}

function toLaneSummary(row: {
  id: string;
  name: string;
  description: string | null;
  lane_type: LaneType;
  base_ref: string;
  branch_ref: string;
  worktree_path: string;
  attached_root_path: string | null;
  is_edit_protected: number;
  created_at: string;
  archived_at: string | null;
}, status: LaneStatus): LaneSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    laneType: row.lane_type,
    baseRef: row.base_ref,
    branchRef: row.branch_ref,
    worktreePath: row.worktree_path,
    attachedRootPath: row.attached_root_path,
    isEditProtected: row.is_edit_protected === 1,
    status,
    createdAt: row.created_at,
    archivedAt: row.archived_at
  };
}

async function detectBranchRef(worktreePath: string, fallback: string): Promise<string> {
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (branchRes.exitCode === 0) {
    const value = branchRes.stdout.trim();
    if (value && value !== "HEAD") return value;
  }
  return fallback;
}

async function computeLaneStatus(worktreePath: string, baseRef: string, branchRef: string): Promise<LaneStatus> {
  const dirtyRes = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8_000 });
  const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;

  const countsRes = await runGit(["rev-list", "--left-right", "--count", `${baseRef}...${branchRef}`], {
    cwd: worktreePath,
    timeoutMs: 8_000
  });
  let behind = 0;
  let ahead = 0;
  if (countsRes.exitCode === 0) {
    const parts = countsRes.stdout.trim().split(/\s+/).filter(Boolean);
    const left = Number(parts[0] ?? 0);
    const right = Number(parts[1] ?? 0);
    behind = Number.isFinite(left) ? left : 0;
    ahead = Number.isFinite(right) ? right : 0;
  }

  return { dirty, ahead, behind };
}

export function createLaneService({
  db,
  projectRoot,
  projectId,
  defaultBaseRef,
  worktreesDir
}: {
  db: AdeDb;
  projectRoot: string;
  projectId: string;
  defaultBaseRef: string;
  worktreesDir: string;
}) {
  const getLaneRow = (laneId: string) =>
    db.get<{
      id: string;
      name: string;
      description: string | null;
      lane_type: LaneType;
      base_ref: string;
      branch_ref: string;
      worktree_path: string;
      attached_root_path: string | null;
      is_edit_protected: number;
      created_at: string;
      archived_at: string | null;
      status: string;
    }>("select * from lanes where id = ? limit 1", [laneId]);

  const getAllLaneRows = (includeArchived = false) =>
    db.all<{
      id: string;
      name: string;
      description: string | null;
      lane_type: LaneType;
      base_ref: string;
      branch_ref: string;
      worktree_path: string;
      attached_root_path: string | null;
      is_edit_protected: number;
      created_at: string;
      archived_at: string | null;
      status: string;
    }>(
      includeArchived
        ? "select * from lanes where project_id = ? order by created_at desc"
        : "select * from lanes where project_id = ? and status != 'archived' order by created_at desc",
      [projectId]
    );

  const ensureSameRepo = async (candidatePath: string) => {
    const resolvedProject = normAbs(projectRoot);
    const repoTop = (await runGitOrThrow(["rev-parse", "--show-toplevel"], { cwd: candidatePath, timeoutMs: 10_000 })).trim();
    if (normAbs(repoTop) !== resolvedProject) {
      throw new Error("Attached lane path must belong to the current project repository");
    }
  };

  const ensurePrimaryLane = async (): Promise<void> => {
    const existing = db.get<{ id: string }>(
      "select id from lanes where project_id = ? and lane_type = 'primary' limit 1",
      [projectId]
    );
    if (existing?.id) return;

    const laneId = randomUUID();
    const now = new Date().toISOString();
    const branchRef = await detectBranchRef(projectRoot, defaultBaseRef);
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'primary', ?, ?, ?, null, 1, 'active', ?, null)
      `,
      [laneId, projectId, "Primary", "Main repository workspace", defaultBaseRef, branchRef, projectRoot, now]
    );
  };

  return {
    async ensurePrimaryLane(): Promise<void> {
      await ensurePrimaryLane();
    },

    async list({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<LaneSummary[]> {
      await ensurePrimaryLane();
      const rows = getAllLaneRows(includeArchived);
      const out: LaneSummary[] = [];
      for (const r of rows) {
        const status = await computeLaneStatus(r.worktree_path, r.base_ref, r.branch_ref);
        out.push(toLaneSummary(r, status));
      }
      return out;
    },

    async create({ name, description }: { name: string; description?: string }): Promise<LaneSummary> {
      const laneId = randomUUID();
      const now = new Date().toISOString();
      const slug = slugify(name);
      const suffix = laneId.slice(0, 8);
      const branchRef = `ade/${slug}-${suffix}`;
      const worktreePath = path.join(worktreesDir, `${slug}-${suffix}`);
      const baseRef = defaultBaseRef;

      await runGitOrThrow(["worktree", "add", "-b", branchRef, worktreePath, baseRef], { cwd: projectRoot, timeoutMs: 60_000 });

      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, status, created_at, archived_at
          )
          values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, 'active', ?, null)
        `,
        [laneId, projectId, name, description ?? null, baseRef, branchRef, worktreePath, now]
      );

      const status = await computeLaneStatus(worktreePath, baseRef, branchRef);
      return {
        id: laneId,
        name,
        description: description ?? null,
        laneType: "worktree",
        baseRef,
        branchRef,
        worktreePath,
        attachedRootPath: null,
        isEditProtected: false,
        status,
        createdAt: now,
        archivedAt: null
      };
    },

    async attach(args: AttachLaneArgs): Promise<LaneSummary> {
      const attachedPath = normAbs(args.attachedPath);
      if (!fs.existsSync(attachedPath) || !fs.statSync(attachedPath).isDirectory()) {
        throw new Error("Attached lane path must be an existing directory");
      }
      await ensureSameRepo(attachedPath);

      const laneId = randomUUID();
      const now = new Date().toISOString();
      const branchRef = await detectBranchRef(attachedPath, defaultBaseRef);
      const baseRef = defaultBaseRef;

      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, status, created_at, archived_at
          )
          values(?, ?, ?, ?, 'attached', ?, ?, ?, ?, 0, 'active', ?, null)
        `,
        [laneId, projectId, args.name, args.description ?? null, baseRef, branchRef, attachedPath, attachedPath, now]
      );

      const status = await computeLaneStatus(attachedPath, baseRef, branchRef);
      return {
        id: laneId,
        name: args.name,
        description: args.description ?? null,
        laneType: "attached",
        baseRef,
        branchRef,
        worktreePath: attachedPath,
        attachedRootPath: attachedPath,
        isEditProtected: false,
        status,
        createdAt: now,
        archivedAt: null
      };
    },

    rename({ laneId, name }: { laneId: string; name: string }): void {
      db.run("update lanes set name = ? where id = ?", [name, laneId]);
    },

    archive({ laneId }: { laneId: string }): void {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be archived");
      }
      const now = new Date().toISOString();
      db.run("update lanes set status = 'archived', archived_at = ? where id = ?", [now, laneId]);
    },

    async delete({
      laneId,
      deleteBranch = true,
      deleteRemoteBranch = false,
      remoteName = "origin",
      force = false
    }: DeleteLaneArgs): Promise<void> {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be deleted");
      }

      if (row.lane_type === "worktree" && row.worktree_path && fs.existsSync(row.worktree_path)) {
        const dirtyRes = await runGit(["status", "--porcelain=v1"], { cwd: row.worktree_path, timeoutMs: 8_000 });
        const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;
        if (dirty && !force) {
          throw new Error("Lane has uncommitted changes. Enable force delete after confirming warnings.");
        }

        const removeArgs = ["worktree", "remove"];
        if (force) removeArgs.push("--force");
        removeArgs.push(row.worktree_path);
        await runGitOrThrow(removeArgs, { cwd: projectRoot, timeoutMs: 60_000 });
      }

      if (deleteBranch && row.branch_ref) {
        const refCheck = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${row.branch_ref}`], {
          cwd: projectRoot,
          timeoutMs: 8_000
        });
        if (refCheck.exitCode === 0) {
          await runGitOrThrow(["branch", "-D", row.branch_ref], { cwd: projectRoot, timeoutMs: 30_000 });
        }
      }

      if (deleteRemoteBranch && row.branch_ref) {
        const remote = remoteName.trim() || "origin";
        const remoteCheck = await runGit(["remote", "get-url", remote], { cwd: projectRoot, timeoutMs: 8_000 });
        if (remoteCheck.exitCode !== 0) {
          throw new Error(`Remote '${remote}' is not configured for this repository`);
        }
        // Branch may already be deleted on remote; treat that as a no-op.
        const remoteRefCheck = await runGit(["ls-remote", "--heads", remote, row.branch_ref], {
          cwd: projectRoot,
          timeoutMs: 12_000
        });
        if (remoteRefCheck.exitCode === 0 && remoteRefCheck.stdout.trim().length > 0) {
          await runGitOrThrow(["push", remote, "--delete", row.branch_ref], { cwd: projectRoot, timeoutMs: 45_000 });
        }
      }

      const lanePackDir = path.join(projectRoot, ".ade", "packs", "lanes", laneId);
      try {
        fs.rmSync(lanePackDir, { recursive: true, force: true });
      } catch {
        // ignore pack folder cleanup failures
      }

      db.run("delete from session_deltas where lane_id = ?", [laneId]);
      db.run("delete from terminal_sessions where lane_id = ?", [laneId]);
      db.run("delete from operations where lane_id = ?", [laneId]);
      db.run("delete from packs_index where lane_id = ?", [laneId]);
      db.run("delete from process_runtime where lane_id = ?", [laneId]);
      db.run("delete from process_runs where lane_id = ?", [laneId]);
      db.run("delete from test_runs where lane_id = ?", [laneId]);
      db.run("delete from lanes where id = ?", [laneId]);
    },

    getLaneWorktreePath(laneId: string): string {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return row.worktree_path;
    },

    getLaneBaseAndBranch(laneId: string): { baseRef: string; branchRef: string; worktreePath: string } {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return { baseRef: row.base_ref, branchRef: row.branch_ref, worktreePath: row.worktree_path };
    },

    getFilesWorkspaces(): Array<{
      id: string;
      kind: LaneType;
      laneId: string | null;
      name: string;
      rootPath: string;
      isReadOnlyByDefault: boolean;
    }> {
      const rows = getAllLaneRows(false);
      return rows.map((row) => ({
        id: row.id,
        kind: row.lane_type,
        laneId: row.id,
        name: row.name,
        rootPath: row.worktree_path,
        isReadOnlyByDefault: row.is_edit_protected === 1
      }));
    },

    resolveWorkspaceById(workspaceId: string): {
      id: string;
      kind: LaneType;
      laneId: string | null;
      name: string;
      rootPath: string;
      isReadOnlyByDefault: boolean;
    } {
      const row = getLaneRow(workspaceId);
      if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
      return {
        id: row.id,
        kind: row.lane_type,
        laneId: row.id,
        name: row.name,
        rootPath: row.worktree_path,
        isReadOnlyByDefault: row.is_edit_protected === 1
      };
    }
  };
}
