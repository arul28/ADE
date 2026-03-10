import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createQueueRehearsalService } from "./queueRehearsalService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? "").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | null | undefined, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = fn();
    if (value && predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for queue rehearsal state");
    await sleep(50);
  }
}

async function seedProject(db: any, projectId: string, repoRoot: string, laneId = "lane-1") {
  const now = "2026-03-09T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, repoRoot, "ADE", "main", now, now],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [laneId, projectId, laneId, null, "worktree", "main", `feature/${laneId}`, repoRoot, null, 0, null, null, null, null, "active", now, null],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-main", projectId, "main", null, "primary", "main", "main", repoRoot, null, 0, null, null, null, null, "active", now, null],
  );
}

describe("queueRehearsalService", () => {
  it("runs queue rehearsal on a scratch lane and uses the shared resolver path for conflicts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-queue-rehearsal-resolve-"));
    const repoRoot = path.join(root, "repo");
    const scratchRoot = path.join(root, "scratch");
    fs.mkdirSync(repoRoot, { recursive: true });
    git(root, ["init", "--initial-branch=main", repoRoot]);
    git(repoRoot, ["config", "user.email", "ade@test.local"]);
    git(repoRoot, ["config", "user.name", "ADE Test"]);
    fs.writeFileSync(path.join(repoRoot, "src.txt"), "base\n", "utf8");
    git(repoRoot, ["add", "src.txt"]);
    git(repoRoot, ["commit", "-m", "base"]);
    git(repoRoot, ["checkout", "-b", "feature/lane-1"]);
    fs.writeFileSync(path.join(repoRoot, "src.txt"), "feature change\n", "utf8");
    git(repoRoot, ["commit", "-am", "feature change"]);
    git(repoRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(repoRoot, "src.txt"), "main change\n", "utf8");
    git(repoRoot, ["commit", "-am", "main change"]);
    git(repoRoot, ["checkout", "feature/lane-1"]);

    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-queue-rehearsal";
    await seedProject(db, projectId, repoRoot);
    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
       values (?, ?, 'queue', ?, 1, 1, ?, ?)`,
      ["group-1", projectId, "Queue Rehearsal", "main", "2026-03-09T00:00:00.000Z"],
    );

    const lanePaths = new Map<string, string>([
      ["lane-1", repoRoot],
      ["lane-main", repoRoot],
    ]);

    const runExternalResolver = vi.fn().mockImplementation(async (args: { targetLaneId: string; cwdLaneId?: string }) => {
      const scratchPath = lanePaths.get(args.cwdLaneId ?? "");
      if (!scratchPath) throw new Error("Expected scratch worktree");
      fs.writeFileSync(path.join(scratchPath, "src.txt"), "resolved rehearsal\n", "utf8");
      return {
        runId: "resolver-run-1",
        provider: "claude",
        status: "completed",
        startedAt: "2026-03-09T00:00:00.000Z",
        completedAt: "2026-03-09T00:01:00.000Z",
        targetLaneId: args.targetLaneId,
        sourceLaneIds: ["lane-1"],
        cwdLaneId: args.cwdLaneId ?? args.targetLaneId,
        integrationLaneId: null,
        scenario: "single-merge",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "medium",
        permissionMode: "guarded_edit",
        command: [],
        changedFiles: ["src.txt"],
        summary: "Resolved rehearsal conflict",
        patchPath: null,
        logPath: null,
        insufficientContext: false,
        contextGaps: [],
        warnings: [],
        originSurface: "queue",
        originMissionId: null,
        originRunId: null,
        originLabel: "Queue Rehearsal",
        ptyId: null,
        sessionId: null,
        committedAt: null,
        commitSha: null,
        commitMessage: null,
        postActions: null,
        error: null,
      };
    });

    const service = createQueueRehearsalService({
      db,
      logger: createLogger(),
      projectId,
      prService: {
        listGroupPrs: async () => [
          { id: "pr-1", laneId: "lane-1", title: "Needs rehearsal resolve", headBranch: "feature/lane-1", baseBranch: "main", githubPrNumber: 101, githubUrl: "https://example.com/pr/101", state: "open", createdAt: "2026-03-09T10:00:00.000Z" },
        ] as any,
      },
      laneService: {
        list: async () => [{ id: "lane-main", branchRef: "main", baseRef: "main" }],
        getLaneBaseAndBranch: (laneId: string) => {
          const worktreePath = lanePaths.get(laneId);
          if (!worktreePath) throw new Error(`Unknown lane: ${laneId}`);
          return { worktreePath, branchRef: laneId === "lane-1" ? "feature/lane-1" : laneId === "lane-main" ? "main" : `scratch/${laneId}`, baseRef: "main", laneType: "worktree" };
        },
        createChild: async () => {
          fs.mkdirSync(scratchRoot, { recursive: true });
          git(repoRoot, ["worktree", "add", "-b", "scratch/queue-rehearsal", scratchRoot, "main"]);
          lanePaths.set("lane-scratch", scratchRoot);
          return { id: "lane-scratch", name: "lane-scratch" };
        },
        archive: () => {},
      } as any,
      conflictService: { runExternalResolver } as any,
      emitEvent: () => {},
    });

    await service.startQueueRehearsal({
      groupId: "group-1",
      method: "squash",
      autoResolve: true,
      resolverModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      originSurface: "queue",
      originLabel: "Queue Rehearsal",
    });

    const completed = await waitFor(
      () => service.getQueueRehearsalStateByGroup("group-1"),
      (state) => state.state === "completed",
    );

    expect(completed.scratchLaneId).toBe("lane-scratch");
    expect(runExternalResolver).toHaveBeenCalledTimes(1);
    expect(runExternalResolver.mock.calls[0]?.[0]).toMatchObject({
      targetLaneId: "lane-scratch",
      cwdLaneId: "lane-scratch",
      originSurface: "queue",
    });
    expect(completed.entries[0]?.state).toBe("resolved");
    expect(completed.entries[0]?.resolvedByAi).toBe(true);
  });

  it("rehearses queue rebase mode by replaying commits onto the scratch lane", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-queue-rehearsal-rebase-"));
    const repoRoot = path.join(root, "repo");
    const scratchRoot = path.join(root, "scratch");
    fs.mkdirSync(repoRoot, { recursive: true });
    git(root, ["init", "--initial-branch=main", repoRoot]);
    git(repoRoot, ["config", "user.email", "ade@test.local"]);
    git(repoRoot, ["config", "user.name", "ADE Test"]);
    fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n", "utf8");
    git(repoRoot, ["add", "base.txt"]);
    git(repoRoot, ["commit", "-m", "base"]);
    git(repoRoot, ["checkout", "-b", "feature/lane-1"]);
    fs.writeFileSync(path.join(repoRoot, "feature.txt"), "feature work\n", "utf8");
    git(repoRoot, ["add", "feature.txt"]);
    git(repoRoot, ["commit", "-m", "feature work"]);
    git(repoRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(repoRoot, "main.txt"), "main work\n", "utf8");
    git(repoRoot, ["add", "main.txt"]);
    git(repoRoot, ["commit", "-m", "main work"]);
    git(repoRoot, ["checkout", "feature/lane-1"]);

    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-queue-rehearsal-rebase";
    await seedProject(db, projectId, repoRoot);
    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
       values (?, ?, 'queue', ?, 1, 1, ?, ?)`,
      ["group-2", projectId, "Queue Rehearsal Rebase", "main", "2026-03-09T00:00:00.000Z"],
    );

    const lanePaths = new Map<string, string>([
      ["lane-1", repoRoot],
      ["lane-main", repoRoot],
    ]);

    const service = createQueueRehearsalService({
      db,
      logger: createLogger(),
      projectId,
      prService: {
        listGroupPrs: async () => [
          { id: "pr-2", laneId: "lane-1", title: "Needs rehearsal rebase", headBranch: "feature/lane-1", baseBranch: "main", githubPrNumber: 102, githubUrl: "https://example.com/pr/102", state: "open", createdAt: "2026-03-09T10:00:00.000Z" },
        ] as any,
      },
      laneService: {
        list: async () => [{ id: "lane-main", branchRef: "main", baseRef: "main" }],
        getLaneBaseAndBranch: (laneId: string) => {
          const worktreePath = lanePaths.get(laneId);
          if (!worktreePath) throw new Error(`Unknown lane: ${laneId}`);
          return { worktreePath, branchRef: laneId === "lane-1" ? "feature/lane-1" : laneId === "lane-main" ? "main" : `scratch/${laneId}`, baseRef: "main", laneType: "worktree" };
        },
        createChild: async () => {
          fs.mkdirSync(scratchRoot, { recursive: true });
          git(repoRoot, ["worktree", "add", "-b", "scratch/queue-rehearsal-rebase", scratchRoot, "main"]);
          lanePaths.set("lane-scratch", scratchRoot);
          return { id: "lane-scratch", name: "lane-scratch" };
        },
        archive: () => {},
      } as any,
      conflictService: { runExternalResolver: vi.fn() } as any,
      emitEvent: () => {},
    });

    await service.startQueueRehearsal({
      groupId: "group-2",
      method: "rebase",
      autoResolve: false,
      originSurface: "queue",
      originLabel: "Queue Rehearsal Rebase",
    });

    const completed = await waitFor(
      () => service.getQueueRehearsalStateByGroup("group-2"),
      (state) => state.state === "completed",
    );

    expect(completed.entries[0]?.state).toBe("ready");
    expect(completed.entries[0]?.changedFiles).toContain("feature.txt");
    expect(completed.scratchLaneId).toBe("lane-scratch");
  });
});
