import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createLaneService } from "./laneService";

vi.mock("../git/git", () => ({
  getHeadSha: vi.fn(),
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

import { getHeadSha, runGit } from "../git/git";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function seedProjectAndStack(db: any, args: { projectId: string; repoRoot: string }) {
  const now = "2026-03-11T12:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [args.projectId, args.repoRoot, "demo", "main", now, now],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-main", args.projectId, "Main", null, "primary", "main", "main", path.join(args.repoRoot, "main"), null, 0, null, null, null, null, "active", now, null],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-parent", args.projectId, "Parent", null, "worktree", "main", "feature/parent", path.join(args.repoRoot, "parent"), null, 0, "lane-main", null, null, null, "active", now, null],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-child", args.projectId, "Child", null, "worktree", "feature/parent", "feature/child", path.join(args.repoRoot, "child"), null, 0, "lane-parent", null, null, null, "active", now, null],
  );
}

describe("laneService rebaseStart", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
  });

  it("skips rebasing when the parent head is already an ancestor of the lane head", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-skip-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-skip", repoRoot });
    const logs: string[] = [];

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      if (cwd.endsWith("/child")) return "sha-child";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-skip",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onRebaseEvent: (event) => {
        if (event.type === "rebase-run-log") logs.push(event.message);
      },
    });

    const result = await service.rebaseStart({ laneId: "lane-child", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    expect(result.run.error).toBeNull();
    expect(result.run.lanes).toHaveLength(1);
    expect(result.run.lanes[0]?.status).toBe("skipped");
    expect(result.run.lanes[0]?.preHeadSha).toBe("sha-child");
    expect(result.run.lanes[0]?.postHeadSha).toBe("sha-child");
    expect(logs.some((line) => line.includes("already up to date"))).toBe(true);
  });

  it("rejects overlapping rebase runs for the same stack while one is active", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-overlap-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-overlap", repoRoot });

    let resolveRebase: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | null = null;
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      if (cwd.endsWith("/child")) return "sha-child";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation((args: string[]) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
      }
      if (args[0] === "rebase") {
        return new Promise((resolve) => {
          resolveRebase = resolve;
        });
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-overlap",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const firstRun = service.rebaseStart({ laneId: "lane-child", scope: "lane_only", actor: "user" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" })).rejects.toThrow(
      /already active for this lane stack/i,
    );

    if (!resolveRebase) {
      throw new Error("Expected rebase resolver to be registered");
    }
    (resolveRebase as (value: { exitCode: number; stdout: string; stderr: string }) => void)({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const completed = await firstRun;
    expect(completed.run.state).toBe("completed");
  });
});
