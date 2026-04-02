import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { toRecentProjectSummary } from "./recentProjectSummary";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function insertProject(db: Awaited<ReturnType<typeof openKvDb>>, projectId: string, projectRoot: string, now: string) {
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, projectRoot, path.basename(projectRoot), "main", now, now],
  );
}

function insertLane(
  db: Awaited<ReturnType<typeof openKvDb>>,
  args: {
    laneId: string;
    projectId: string;
    laneType: "primary" | "worktree" | "attached";
    worktreePath: string;
    branchRef: string;
    status?: "active" | "archived";
    archivedAt?: string | null;
    attachedRootPath?: string | null;
  },
) {
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      args.laneId,
      args.projectId,
      args.laneId,
      null,
      args.laneType,
      "main",
      args.branchRef,
      args.worktreePath,
      args.attachedRootPath ?? null,
      args.laneType === "primary" ? 1 : 0,
      null,
      null,
      null,
      null,
      args.status ?? "active",
      "2026-04-02T12:00:00.000Z",
      args.archivedAt ?? null,
    ],
  );
}

describe("toRecentProjectSummary", () => {
  it("prefers active ADE lanes over raw git worktree metadata", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-summary-"));
    const gitWorktreesDir = path.join(projectRoot, ".git", "worktrees");
    fs.mkdirSync(gitWorktreesDir, { recursive: true });
    for (let index = 0; index < 18; index += 1) {
      fs.mkdirSync(path.join(gitWorktreesDir, `raw-${index}`), { recursive: true });
    }

    const layout = resolveAdeLayout(projectRoot);
    const managedLanePath = path.join(layout.worktreesDir, "lane-managed");
    const missingLanePath = path.join(layout.worktreesDir, "lane-missing");
    const attachedLanePath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-attached-"));
    fs.mkdirSync(managedLanePath, { recursive: true });

    const db = await openKvDb(layout.dbPath, createLogger());
    const now = "2026-04-02T12:00:00.000Z";
    insertProject(db, "proj-recent", projectRoot, now);
    insertLane(db, {
      laneId: "lane-primary",
      projectId: "proj-recent",
      laneType: "primary",
      worktreePath: projectRoot,
      branchRef: "main",
    });
    insertLane(db, {
      laneId: "lane-managed",
      projectId: "proj-recent",
      laneType: "worktree",
      worktreePath: managedLanePath,
      branchRef: "feature/managed",
    });
    insertLane(db, {
      laneId: "lane-missing",
      projectId: "proj-recent",
      laneType: "worktree",
      worktreePath: missingLanePath,
      branchRef: "feature/missing",
    });
    insertLane(db, {
      laneId: "lane-attached",
      projectId: "proj-recent",
      laneType: "attached",
      worktreePath: attachedLanePath,
      attachedRootPath: attachedLanePath,
      branchRef: "feature/attached",
    });
    insertLane(db, {
      laneId: "lane-archived",
      projectId: "proj-recent",
      laneType: "worktree",
      worktreePath: path.join(layout.worktreesDir, "lane-archived"),
      branchRef: "feature/archived",
      status: "archived",
      archivedAt: now,
    });
    db.close();

    const summary = toRecentProjectSummary({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: now,
    });

    expect(summary.exists).toBe(true);
    expect(summary.laneCount).toBe(3);
  });

  it("falls back to git worktree metadata when no ADE lane registry exists", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-git-fallback-"));
    fs.mkdirSync(path.join(projectRoot, ".git", "worktrees", "lane-a"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".git", "worktrees", "lane-b"), { recursive: true });

    const summary = toRecentProjectSummary({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: "2026-04-02T12:00:00.000Z",
    });

    expect(summary.laneCount).toBe(3);
  });

  it("falls back to git worktree metadata when ADE only has archived lanes", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-archived-fallback-"));
    fs.mkdirSync(path.join(projectRoot, ".git", "worktrees", "lane-a"), { recursive: true });

    const layout = resolveAdeLayout(projectRoot);
    const db = await openKvDb(layout.dbPath, createLogger());
    const now = "2026-04-02T12:00:00.000Z";
    insertProject(db, "proj-recent-archived", projectRoot, now);
    insertLane(db, {
      laneId: "lane-primary-archived",
      projectId: "proj-recent-archived",
      laneType: "primary",
      worktreePath: projectRoot,
      branchRef: "main",
      status: "archived",
      archivedAt: now,
    });
    db.close();

    const summary = toRecentProjectSummary({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: now,
    });

    expect(summary.laneCount).toBe(2);
  });
});
