import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import { runGit, runGitOrThrow } from "../git/git";
import type { DeleteLaneArgs, LaneStatus, LaneSummary } from "../../../shared/types";

function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length ? s : "lane";
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
      base_ref: string;
      branch_ref: string;
      worktree_path: string;
      created_at: string;
      archived_at: string | null;
      status: string;
    }>("select * from lanes where id = ? limit 1", [laneId]);

  return {
    async list({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<LaneSummary[]> {
      const rows = db.all<{
        id: string;
        name: string;
        description: string | null;
        base_ref: string;
        branch_ref: string;
        worktree_path: string;
        created_at: string;
        archived_at: string | null;
        status: string;
      }>(
        includeArchived
          ? "select * from lanes where project_id = ? order by created_at desc"
          : "select * from lanes where project_id = ? and status != 'archived' order by created_at desc",
        [projectId]
      );

      const out: LaneSummary[] = [];
      for (const r of rows) {
        const status = await computeLaneStatus(r.worktree_path, r.base_ref, r.branch_ref);
        out.push({
          id: r.id,
          name: r.name,
          description: r.description,
          baseRef: r.base_ref,
          branchRef: r.branch_ref,
          worktreePath: r.worktree_path,
          status,
          createdAt: r.created_at,
          archivedAt: r.archived_at
        });
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

      // `git worktree add -b <branch> <path> <base>`
      await runGitOrThrow(["worktree", "add", "-b", branchRef, worktreePath, baseRef], { cwd: projectRoot, timeoutMs: 60_000 });

      db.run(
        `
          insert into lanes(id, project_id, name, description, base_ref, branch_ref, worktree_path, status, created_at, archived_at)
          values(?, ?, ?, ?, ?, ?, ?, 'active', ?, null)
        `,
        [laneId, projectId, name, description ?? null, baseRef, branchRef, worktreePath, now]
      );

      const status = await computeLaneStatus(worktreePath, baseRef, branchRef);
      return {
        id: laneId,
        name,
        description: description ?? null,
        baseRef,
        branchRef,
        worktreePath,
        status,
        createdAt: now,
        archivedAt: null
      };
    },

    rename({ laneId, name }: { laneId: string; name: string }): void {
      db.run("update lanes set name = ? where id = ?", [name, laneId]);
    },

    archive({ laneId }: { laneId: string }): void {
      const now = new Date().toISOString();
      db.run("update lanes set status = 'archived', archived_at = ? where id = ?", [now, laneId]);
    },

    async delete({ laneId, deleteBranch = true, force = false }: DeleteLaneArgs): Promise<void> {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);

      if (row.worktree_path && fs.existsSync(row.worktree_path)) {
        const dirtyRes = await runGit(["status", "--porcelain=v1"], { cwd: row.worktree_path, timeoutMs: 8_000 });
        const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;
        if (dirty && !force) {
          throw new Error("Lane has uncommitted changes. Enable force delete after confirming warnings.");
        }

        const removeArgs = ["worktree", "remove"];
        if (force) {
          removeArgs.push("--force");
        }
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
    }
  };
}
