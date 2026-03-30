import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createQueueLandingService } from "./queueLandingService";

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
    if (Date.now() >= deadline) throw new Error("Timed out waiting for queue state");
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

describe("queueLandingService", () => {
  it("preserves queue member order instead of re-sorting by PR creation time", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-queue-order-"));
    const db = await openKvDb(path.join(repoRoot, ".ade.db"), createLogger());
    const projectId = "proj-queue-order";
    await seedProject(db, projectId, repoRoot);
    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
       values (?, ?, 'queue', ?, 1, 1, ?, ?)`,
      ["group-1", projectId, "Queue A", "main", "2026-03-09T00:00:00.000Z"],
    );

    const land = vi.fn()
      .mockResolvedValueOnce({ prId: "pr-2", prNumber: 2, success: true, mergeCommitSha: "sha-2", branchDeleted: true, laneArchived: false, error: null })
      .mockResolvedValueOnce({ prId: "pr-1", prNumber: 1, success: true, mergeCommitSha: "sha-1", branchDeleted: true, laneArchived: false, error: null });

    const service = createQueueLandingService({
      db,
      logger: createLogger(),
      projectId,
      prService: {
        land,
        listGroupPrs: async () => [
          { id: "pr-2", laneId: "lane-1", title: "Second", headBranch: "feature/lane-1", githubPrNumber: 2, githubUrl: "https://example.com/pr/2", createdAt: "2026-03-09T10:00:00.000Z" },
          { id: "pr-1", laneId: "lane-1", title: "First", headBranch: "feature/lane-1", githubPrNumber: 1, githubUrl: "https://example.com/pr/1", createdAt: "2026-03-08T10:00:00.000Z" },
        ] as any,
        getStatus: async (prId: string) => ({
          prId,
          state: "open",
          checksStatus: "passing",
          reviewStatus: "approved",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        }),
      },
      laneService: {
        list: async () => [{ id: "lane-main", branchRef: "main", baseRef: "main" }],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, branchRef: "feature/lane-1", baseRef: "main" }),
      } as any,
      conflictService: null,
      emitEvent: () => {},
    });

    await service.startQueue({ groupId: "group-1", method: "squash" });
    const completed = await waitFor(
      () => service.getQueueStateByGroup("group-1"),
      (state) => state.state === "completed",
    );

    expect(land.mock.calls.map((call) => call[0].prId)).toEqual(["pr-2", "pr-1"]);
    expect(completed.entries.map((entry) => entry.prId)).toEqual(["pr-2", "pr-1"]);
  });

  it("uses the shared resolver path for queue auto-resolve and continues landing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-queue-resolve-"));
    const remote = path.join(root, "remote.git");
    const repoRoot = path.join(root, "repo");
    fs.mkdirSync(remote, { recursive: true });
    git(root, ["init", "--bare", remote]);
    fs.mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "ade@test.local"]);
    git(repoRoot, ["config", "user.name", "ADE Test"]);
    fs.writeFileSync(path.join(repoRoot, "src.txt"), "base\n", "utf8");
    git(repoRoot, ["add", "src.txt"]);
    git(repoRoot, ["commit", "-m", "base"]);
    git(repoRoot, ["remote", "add", "origin", remote]);
    git(repoRoot, ["push", "-u", "origin", "main"]);
    git(repoRoot, ["checkout", "-b", "feature/lane-1"]);
    fs.writeFileSync(path.join(repoRoot, "src.txt"), "lane work\n", "utf8");
    git(repoRoot, ["add", "src.txt"]);
    git(repoRoot, ["commit", "-m", "lane work"]);
    git(repoRoot, ["push", "-u", "origin", "feature/lane-1"]);

    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-queue-resolve";
    await seedProject(db, projectId, repoRoot);
    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
       values (?, ?, 'queue', ?, 1, 1, ?, ?)`,
      ["group-2", projectId, "Queue B", "main", "2026-03-09T00:00:00.000Z"],
    );

    const land = vi.fn()
      .mockResolvedValueOnce({
        prId: "pr-1",
        prNumber: 1,
        success: false,
        mergeCommitSha: null,
        branchDeleted: false,
        laneArchived: false,
        error: "PR has merge conflicts. Rebase or resolve conflicts before merging.",
      })
      .mockResolvedValueOnce({
        prId: "pr-1",
        prNumber: 1,
        success: true,
        mergeCommitSha: "merged-sha",
        branchDeleted: true,
        laneArchived: false,
        error: null,
      });

    const runExternalResolver = vi.fn().mockImplementation(async () => {
      fs.writeFileSync(path.join(repoRoot, "src.txt"), "resolved lane work\n", "utf8");
      return {
        runId: "resolver-run-1",
        provider: "claude",
        status: "completed",
        startedAt: "2026-03-09T00:00:00.000Z",
        completedAt: "2026-03-09T00:01:00.000Z",
        targetLaneId: "lane-main",
        sourceLaneIds: ["lane-1"],
        cwdLaneId: "lane-1",
        integrationLaneId: null,
        scenario: "single-merge",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "medium",
        permissionMode: "guarded_edit",
        command: [],
        changedFiles: ["src.txt"],
        summary: "Resolved",
        patchPath: null,
        logPath: null,
        insufficientContext: false,
        contextGaps: [],
        warnings: [],
        originSurface: "queue",
        originMissionId: null,
        originRunId: null,
        originLabel: "Queue B",
        ptyId: null,
        sessionId: null,
        committedAt: null,
        commitSha: null,
        commitMessage: null,
        postActions: null,
        error: null,
      };
    });

    const service = createQueueLandingService({
      db,
      logger: createLogger(),
      projectId,
      prService: {
        land,
        listGroupPrs: async () => [
          { id: "pr-1", laneId: "lane-1", title: "Needs resolve", headBranch: "feature/lane-1", githubPrNumber: 1, githubUrl: "https://example.com/pr/1", createdAt: "2026-03-09T10:00:00.000Z" },
        ] as any,
        getStatus: async () => ({
          prId: "pr-1",
          state: "open",
          checksStatus: "passing",
          reviewStatus: "approved",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        }),
      },
      laneService: {
        list: async () => [{ id: "lane-main", branchRef: "main", baseRef: "main" }],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, branchRef: "feature/lane-1", baseRef: "main" }),
      } as any,
      conflictService: {
        runExternalResolver,
      } as any,
      emitEvent: () => {},
    });

    await service.startQueue({
      groupId: "group-2",
      method: "squash",
      autoResolve: true,
      resolverModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      originSurface: "queue",
      originLabel: "Queue B",
    });

    const completed = await waitFor(
      () => service.getQueueStateByGroup("group-2"),
      (state) => state.state === "completed",
    );

    expect(runExternalResolver).toHaveBeenCalledTimes(1);
    expect(runExternalResolver.mock.calls[0]?.[0]).toMatchObject({
      originSurface: "queue",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(completed.entries[0]?.resolvedByAi).toBe(true);
    expect(land).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid state transition and keeps the entry in its current state", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-queue-guard-"));
    const db = await openKvDb(path.join(repoRoot, ".ade.db"), createLogger());
    const projectId = "proj-queue-guard";
    await seedProject(db, projectId, repoRoot);
    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
       values (?, ?, 'queue', ?, 1, 0, ?, ?)`,
      ["group-guard", projectId, "Queue Guard", "main", "2026-03-09T00:00:00.000Z"],
    );

    // First land call fails with a non-merge-conflict error (entry goes to "failed").
    // Second land call succeeds (for the second entry if it gets reached).
    const land = vi.fn()
      .mockResolvedValueOnce({
        prId: "pr-fail",
        prNumber: 1,
        success: false,
        mergeCommitSha: null,
        branchDeleted: false,
        laneArchived: false,
        error: "Branch protection rule violations found.",
      })
      .mockResolvedValueOnce({
        prId: "pr-ok",
        prNumber: 2,
        success: true,
        mergeCommitSha: "sha-ok",
        branchDeleted: true,
        laneArchived: false,
        error: null,
      });

    const service = createQueueLandingService({
      db,
      logger: createLogger(),
      projectId,
      prService: {
        land,
        listGroupPrs: async () => [
          { id: "pr-fail", laneId: "lane-1", title: "Will Fail", headBranch: "feature/lane-1", githubPrNumber: 1, githubUrl: "https://example.com/pr/1", createdAt: "2026-03-09T10:00:00.000Z" },
          { id: "pr-ok", laneId: "lane-1", title: "Should Skip", headBranch: "feature/lane-1", githubPrNumber: 2, githubUrl: "https://example.com/pr/2", createdAt: "2026-03-09T11:00:00.000Z" },
        ] as any,
        getStatus: async (prId: string) => ({
          prId,
          state: "open",
          checksStatus: "passing",
          reviewStatus: "approved",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        }),
      },
      laneService: {
        list: async () => [{ id: "lane-main", branchRef: "main", baseRef: "main" }],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, branchRef: "feature/lane-1", baseRef: "main" }),
      } as any,
      conflictService: null,
      emitEvent: () => {},
    });

    // Start the queue; first entry will fail, queue pauses.
    await service.startQueue({ groupId: "group-guard", method: "squash" });
    const paused = await waitFor(
      () => service.getQueueStateByGroup("group-guard"),
      (state) => state.state === "paused",
    );

    expect(paused.entries[0]!.state).toBe("failed");
    expect(paused.entries[1]!.state).toBe("pending");

    // Set up entries so the loop will encounter a "failed" entry it cannot
    // transition to "landing". entry[0] is "landed" (the loop skips it),
    // entry[1] is "failed" (guardTransition rejects failed→landing).
    // Put currentPosition at 0 so resumeQueue sees entry[0] = "landed" and
    // does NOT reset it (resumeQueue only resets failed/paused/resolving/landing).
    const entriesForGuardTest = paused.entries.map((e, i) => ({
      ...e,
      state: i === 0 ? "landed" : "failed",
    }));
    db.run(
      "update queue_landing_state set state = 'paused', entries_json = ?, current_position = 0 where id = ?",
      [JSON.stringify(entriesForGuardTest), paused.queueId],
    );

    // Create a second service instance pointing at the same DB, then resume.
    const service2 = createQueueLandingService({
      db,
      logger: createLogger(),
      projectId,
      prService: {
        land,
        listGroupPrs: async () => [] as any,
        getStatus: async (prId: string) => ({
          prId,
          state: "open",
          checksStatus: "passing",
          reviewStatus: "approved",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        }),
      },
      laneService: {
        list: async () => [{ id: "lane-main", branchRef: "main", baseRef: "main" }],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, branchRef: "feature/lane-1", baseRef: "main" }),
      } as any,
      conflictService: null,
      emitEvent: () => {},
    });

    // resumeQueue sets the queue to "landing" and launches the loop.
    // The loop skips entry[0] (landed), hits entry[1] (failed), and
    // guardTransition rejects failed→landing so the loop exits immediately.
    const resumed = service2.resumeQueue({ queueId: paused.queueId });
    expect(resumed).not.toBeNull();
    expect(resumed!.state).toBe("landing");

    // The landing loop runs asynchronously. When guardTransition rejects the
    // failed→landing transition, the loop returns silently without updating DB
    // state — there is no observable state change to poll for. Yield to the
    // event loop so the async loop body executes, then verify the invariants.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const finalState = service2.getQueueState(paused.queueId);
    expect(finalState).not.toBeNull();
    // entry[1] must still be "failed" — guardTransition prevented it from becoming "landing"
    expect(finalState!.entries[1]!.state).toBe("failed");
    // land was called exactly once (the original failure) — no additional calls
    expect(land).toHaveBeenCalledTimes(1);
  });

  it("stops the landing loop when the queue is cancelled externally", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-queue-cancel-"));
    const db = await openKvDb(path.join(repoRoot, ".ade.db"), createLogger());
    const projectId = "proj-queue-cancel";
    await seedProject(db, projectId, repoRoot);
    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
       values (?, ?, 'queue', ?, 1, 0, ?, ?)`,
      ["group-cancel", projectId, "Queue Cancel", "main", "2026-03-09T00:00:00.000Z"],
    );

    // Controllable deferred promises so the test drives timing explicitly
    let resolveSlowLand!: () => void;
    const slowLandStarted = new Promise<void>((resolve) => { resolveSlowLand = resolve; });
    let releaseSlowLand!: () => void;
    const slowLandGate = new Promise<void>((resolve) => { releaseSlowLand = resolve; });

    const land = vi.fn().mockImplementation(async ({ prId }: { prId: string }) => {
      if (prId === "pr-slow") {
        // Signal that the slow land has started, then wait for the test to release
        resolveSlowLand();
        await slowLandGate;
        return {
          prId: "pr-slow",
          prNumber: 1,
          success: true,
          mergeCommitSha: "sha-slow",
          branchDeleted: true,
          laneArchived: false,
          error: null,
        };
      }
      return {
        prId,
        prNumber: 2,
        success: true,
        mergeCommitSha: "sha-fast",
        branchDeleted: true,
        laneArchived: false,
        error: null,
      };
    });

    const service = createQueueLandingService({
      db,
      logger: createLogger(),
      projectId,
      prService: {
        land,
        listGroupPrs: async () => [
          { id: "pr-slow", laneId: "lane-1", title: "Slow PR", headBranch: "feature/lane-1", githubPrNumber: 1, githubUrl: "https://example.com/pr/1", createdAt: "2026-03-09T10:00:00.000Z" },
          { id: "pr-fast", laneId: "lane-1", title: "Fast PR", headBranch: "feature/lane-1", githubPrNumber: 2, githubUrl: "https://example.com/pr/2", createdAt: "2026-03-09T11:00:00.000Z" },
        ] as any,
        getStatus: async (prId: string) => ({
          prId,
          state: "open",
          checksStatus: "passing",
          reviewStatus: "approved",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        }),
      },
      laneService: {
        list: async () => [{ id: "lane-main", branchRef: "main", baseRef: "main" }],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, branchRef: "feature/lane-1", baseRef: "main" }),
      } as any,
      conflictService: null,
      emitEvent: () => {},
    });

    const queueState = await service.startQueue({ groupId: "group-cancel", method: "squash" });
    const cancelQueueId = queueState.queueId;

    // Wait for the land mock to actually be entered before cancelling
    await slowLandStarted;
    db.run(
      "update queue_landing_state set state = 'cancelled', completed_at = ? where id = ?",
      [new Date().toISOString(), cancelQueueId],
    );

    // Release the slow land so the loop can proceed and notice the cancellation
    releaseSlowLand();

    // Poll until the service reflects the cancelled state
    const finalState = await waitFor(
      () => service.getQueueStateByGroup("group-cancel"),
      (state) => state.state === "cancelled",
    );
    expect(finalState).not.toBeNull();
    // The queue should be cancelled (as we set it externally).
    expect(finalState!.state).toBe("cancelled");
    // The second entry (pr-fast) should never have been processed.
    // land was called once for pr-slow, but the loop should have bailed
    // after noticing the cancellation via isQueueCancelledOrDone().
    expect(land).toHaveBeenCalledTimes(1);
    expect(land.mock.calls[0]![0].prId).toBe("pr-slow");
  });
});
