import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createRebaseSuggestionService } from "./rebaseSuggestionService";

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? "").trim();
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function seedRepo(root: string): void {
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "ade@test.local"]);
  git(root, ["config", "user.name", "ADE Test"]);
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
}

function createBranchWorktree(root: string, branchName: string, prefix: string): string {
  git(root, ["branch", "--force", branchName, "HEAD"]);
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["worktree", "add", worktreePath, branchName]);
  return worktreePath;
}

function commitMainUpdate(root: string, fileName: string, content: string, message: string): void {
  fs.writeFileSync(path.join(root, fileName), content, "utf8");
  git(root, ["add", fileName]);
  git(root, ["commit", "-m", message]);
}

describe("rebaseSuggestionService", () => {
  it("suggests rebasing the next queued lane even when it has no parent lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-suggestions-"));
    seedRepo(repoRoot);
    const lane2Worktree = createBranchWorktree(repoRoot, "feature/lane-2", "ade-rebase-suggestions-lane2-");
    commitMainUpdate(repoRoot, "main-update.txt", "main drift\n", "main drift");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-rebase-suggestions";
    const now = "2026-03-23T12:00:00.000Z";

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, repoRoot, "demo", "main", now, now]
    );
    db.run(
      `
        insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
        values (?, ?, 'queue', ?, 0, 1, ?, ?)
      `,
      ["group-queue", projectId, "Queue A", "main", now]
    );
    db.run(
      `
        insert into pull_requests(
          id, lane_id, project_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
          title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
          last_synced_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "pr-1",
        "lane-1",
        projectId,
        "owner",
        "repo",
        1,
        "https://example.com/pr/1",
        null,
        "lane 1",
        "merged",
        "main",
        "feature/lane-1",
        "passing",
        "approved",
        0,
        0,
        now,
        now,
        now
      ]
    );
    db.run(
      `
        insert into pull_requests(
          id, lane_id, project_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
          title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
          last_synced_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "pr-2",
        "lane-2",
        projectId,
        "owner",
        "repo",
        2,
        "https://example.com/pr/2",
        null,
        "lane 2",
        "open",
        "main",
        "feature/lane-2",
        "passing",
        "approved",
        0,
        0,
        now,
        now,
        now
      ]
    );
    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
      [randomUUID(), "group-queue", "pr-1", "lane-1", 0]
    );
    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
      [randomUUID(), "group-queue", "pr-2", "lane-2", 1]
    );

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => [
          {
            id: "lane-2",
            name: "Lane 2",
            description: null,
            laneType: "worktree",
            branchRef: "feature/lane-2",
            baseRef: "main",
            worktreePath: lane2Worktree,
            attachedRootPath: null,
            isEditProtected: false,
            parentLaneId: null,
            color: null,
            icon: null,
            tags: [],
            status: { dirty: false, ahead: 0, behind: 0, conflict: "unknown", tests: "unknown", pr: "none" },
            stackDepth: 0,
            createdAt: now,
            archivedAt: null,
            childCount: 0,
            parentStatus: null,
          },
        ],
      } as any,
    });

    const suggestions = await service.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      laneId: "lane-2",
      baseLabel: "queue target main",
      groupContext: "Queue A",
      hasPr: true,
    });
  });

  it("keeps suggesting a queue rebase after landed members are removed from group membership", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-suggestions-pruned-"));
    seedRepo(repoRoot);
    const lane2Worktree = createBranchWorktree(repoRoot, "feature/lane-2", "ade-rebase-suggestions-pruned-lane2-");
    commitMainUpdate(repoRoot, "main-update.txt", "main drift\n", "main drift");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-rebase-suggestions-pruned";
    const now = "2026-03-23T12:00:00.000Z";

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, repoRoot, "demo", "main", now, now]
    );
    db.run(
      `
        insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
        values (?, ?, 'queue', ?, 0, 1, ?, ?)
      `,
      ["group-queue", projectId, "Queue A", "main", now]
    );
    db.run(
      `
        insert into pull_requests(
          id, lane_id, project_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
          title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
          last_synced_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "pr-1",
        "lane-1",
        projectId,
        "owner",
        "repo",
        1,
        "https://example.com/pr/1",
        null,
        "lane 1",
        "merged",
        "main",
        "feature/lane-1",
        "passing",
        "approved",
        0,
        0,
        now,
        now,
        now
      ]
    );
    db.run(
      `
        insert into pull_requests(
          id, lane_id, project_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
          title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
          last_synced_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "pr-2",
        "lane-2",
        projectId,
        "owner",
        "repo",
        2,
        "https://example.com/pr/2",
        null,
        "lane 2",
        "open",
        "main",
        "feature/lane-2",
        "passing",
        "approved",
        0,
        0,
        now,
        now,
        now
      ]
    );
    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
      [randomUUID(), "group-queue", "pr-2", "lane-2", 1]
    );

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => [
          {
            id: "lane-2",
            name: "Lane 2",
            description: null,
            laneType: "worktree",
            branchRef: "feature/lane-2",
            baseRef: "main",
            worktreePath: lane2Worktree,
            attachedRootPath: null,
            isEditProtected: false,
            parentLaneId: null,
            color: null,
            icon: null,
            tags: [],
            status: { dirty: false, ahead: 0, behind: 0, conflict: "unknown", tests: "unknown", pr: "none" },
            stackDepth: 0,
            createdAt: now,
            archivedAt: null,
            childCount: 0,
            parentStatus: null,
          },
        ],
      } as any,
    });

    const suggestions = await service.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      laneId: "lane-2",
      baseLabel: "queue target main",
      groupContext: "Queue A",
      hasPr: true,
    });
  });

  it("suggests rebasing every unfinished queue member after the landed prefix", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-suggestions-remaining-"));
    seedRepo(repoRoot);
    const lane2Worktree = createBranchWorktree(repoRoot, "feature/lane-2", "ade-rebase-suggestions-remaining-lane2-");
    const lane3Worktree = createBranchWorktree(repoRoot, "feature/lane-3", "ade-rebase-suggestions-remaining-lane3-");
    commitMainUpdate(repoRoot, "main-update.txt", "main drift\n", "main drift");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-rebase-suggestions-remaining";
    const now = "2026-03-23T12:00:00.000Z";

    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, repoRoot, "demo", "main", now, now]
    );
    db.run(
      `
        insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
        values (?, ?, 'queue', ?, 0, 1, ?, ?)
      `,
      ["group-queue", projectId, "Queue A", "main", now]
    );

    const insertPr = (id: string, laneId: string, prNumber: number, title: string, state: string) => {
      db.run(
        `
          insert into pull_requests(
            id, lane_id, project_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
            title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
            last_synced_at, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          laneId,
          projectId,
          "owner",
          "repo",
          prNumber,
          `https://example.com/pr/${prNumber}`,
          null,
          title,
          state,
          "main",
          `feature/${laneId}`,
          "passing",
          "approved",
          0,
          0,
          now,
          now,
          now,
        ]
      );
    };

    insertPr("pr-1", "lane-1", 1, "lane 1", "merged");
    insertPr("pr-2", "lane-2", 2, "lane 2", "open");
    insertPr("pr-3", "lane-3", 3, "lane 3", "open");

    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
      [randomUUID(), "group-queue", "pr-2", "lane-2", 1]
    );
    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
      [randomUUID(), "group-queue", "pr-3", "lane-3", 2]
    );

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => [
          {
            id: "lane-2",
            name: "Lane 2",
            description: null,
            laneType: "worktree",
            branchRef: "feature/lane-2",
            baseRef: "main",
            worktreePath: lane2Worktree,
            attachedRootPath: null,
            isEditProtected: false,
            parentLaneId: null,
            color: null,
            icon: null,
            tags: [],
            status: { dirty: false, ahead: 0, behind: 0, conflict: "unknown", tests: "unknown", pr: "none" },
            stackDepth: 0,
            createdAt: now,
            archivedAt: null,
            childCount: 0,
            parentStatus: null,
          },
          {
            id: "lane-3",
            name: "Lane 3",
            description: null,
            laneType: "worktree",
            branchRef: "feature/lane-3",
            baseRef: "main",
            worktreePath: lane3Worktree,
            attachedRootPath: null,
            isEditProtected: false,
            parentLaneId: null,
            color: null,
            icon: null,
            tags: [],
            status: { dirty: false, ahead: 0, behind: 0, conflict: "unknown", tests: "unknown", pr: "none" },
            stackDepth: 0,
            createdAt: now,
            archivedAt: null,
            childCount: 0,
            parentStatus: null,
          },
        ],
      } as any,
    });

    const suggestions = await service.listSuggestions();
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((suggestion) => suggestion.laneId)).toEqual(["lane-2", "lane-3"]);
    expect(suggestions.every((suggestion) => suggestion.baseLabel === "queue target main")).toBe(true);
  });

  it("dismiss short-circuits when existing state is present", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-dismiss-short-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-dismiss-short";
    const laneId = "lane-X";
    const previouslySuggestedAt = "2026-03-20T08:00:00.000Z";

    db.setJson(`rebase:suggestion:${laneId}`, {
      laneId,
      parentLaneId: "lane-parent",
      parentHeadSha: "abc123",
      behindCount: 2,
      lastSuggestedAt: previouslySuggestedAt,
      deferredUntil: null,
      dismissedAt: null,
    });

    const listMock = vi.fn(() => {
      throw new Error("laneService.list must not be called on dismiss short-circuit");
    });

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: { list: listMock } as any,
    });

    await service.dismiss({ laneId });

    expect(listMock).not.toHaveBeenCalled();
    const saved = db.getJson(`rebase:suggestion:${laneId}`) as any;
    expect(saved.dismissedAt).toBeTruthy();
    expect(typeof saved.dismissedAt).toBe("string");
    expect(saved.lastSuggestedAt).toBe(previouslySuggestedAt);
    expect(saved.deferredUntil).toBeNull();
    expect(saved.parentHeadSha).toBe("abc123");
    expect(saved.behindCount).toBe(2);
  });

  it("defer short-circuits when existing state is present", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-rebase-defer-short-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-defer-short";
    const laneId = "lane-Y";
    const previouslySuggestedAt = "2026-03-20T08:00:00.000Z";

    db.setJson(`rebase:suggestion:${laneId}`, {
      laneId,
      parentLaneId: "lane-parent",
      parentHeadSha: "def456",
      behindCount: 3,
      lastSuggestedAt: previouslySuggestedAt,
      deferredUntil: null,
      dismissedAt: "2026-03-20T09:00:00.000Z",
    });

    const listMock = vi.fn(() => {
      throw new Error("laneService.list must not be called on defer short-circuit");
    });

    const service = createRebaseSuggestionService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: { list: listMock } as any,
    });

    const before = Date.now();
    await service.defer({ laneId, minutes: 30 });
    const after = Date.now();

    expect(listMock).not.toHaveBeenCalled();
    const saved = db.getJson(`rebase:suggestion:${laneId}`) as any;
    expect(saved.dismissedAt).toBeNull();
    expect(typeof saved.deferredUntil).toBe("string");
    const deferMs = Date.parse(saved.deferredUntil);
    expect(Number.isFinite(deferMs)).toBe(true);
    // 30 minutes in future, allow wide tolerance
    expect(deferMs).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(deferMs).toBeLessThanOrEqual(after + 31 * 60_000);
    expect(saved.lastSuggestedAt).toBe(previouslySuggestedAt);
    expect(saved.parentHeadSha).toBe("def456");
    expect(saved.behindCount).toBe(3);
  });
});
