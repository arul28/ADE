import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";

const runGitMock = vi.fn();
const runGitOrThrowMock = vi.fn();
const fetchRemoteTrackingBranchMock = vi.fn();

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => runGitMock(...args),
  runGitOrThrow: (...args: unknown[]) => runGitOrThrowMock(...args),
  runGitMergeTree: vi.fn(),
}));

vi.mock("../shared/queueRebase", () => ({
  fetchRemoteTrackingBranch: (...args: unknown[]) => fetchRemoteTrackingBranchMock(...args),
}));

async function createServiceModule() {
  return await import("./prService");
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeLane(id: string, name: string, branchRef: string, worktreePath: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name,
    description: null,
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef,
    worktreePath,
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-30T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

async function seedProject(db: any, projectId: string, repoRoot: string) {
  const now = "2026-03-30T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, repoRoot, "ADE", "main", now, now],
  );
}

async function seedPr(db: any, args: {
  prId: string;
  projectId: string;
  laneId: string;
  number: number;
  baseBranch: string;
  headBranch: string;
  title: string;
}) {
  const now = "2026-03-30T00:00:00.000Z";
  db.run(
    `
      insert into pull_requests(
        id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
        title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
        last_synced_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      args.prId,
      args.projectId,
      args.laneId,
      "acme",
      "ade",
      args.number,
      `https://github.com/acme/ade/pull/${args.number}`,
      `node-${args.number}`,
      args.title,
      "open",
      args.baseBranch,
      args.headBranch,
      "passing",
      "approved",
      0,
      0,
      now,
      now,
      now,
    ],
  );
}

describe("prService.land auto-rebase follow-up", () => {
  beforeEach(() => {
    runGitMock.mockReset();
    runGitOrThrowMock.mockReset();
    fetchRemoteTrackingBranchMock.mockReset();
    fetchRemoteTrackingBranchMock.mockResolvedValue(undefined);
  });

  it("reparents, pushes, and retargets direct child lanes after a merged parent lane", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-land-auto-rebase-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      const { createPrService } = await createServiceModule();
      const projectId = "proj-land-auto-rebase";

      const mainLane = makeLane("lane-main", "main", "main", root, { laneType: "primary" });
      const parentLane = makeLane("lane-parent", "feature/parent", "feature/parent", path.join(root, "parent"), {
        parentLaneId: mainLane.id,
      });
      const childLane = makeLane("lane-child", "feature/child", "feature/child", path.join(root, "child"), {
        parentLaneId: parentLane.id,
        baseRef: "refs/heads/feature/parent",
      });
      const lanes = [mainLane, parentLane, childLane];

      await seedProject(db, projectId, root);
      await seedPr(db, {
        prId: "pr-parent",
        projectId,
        laneId: parentLane.id,
        number: 101,
        baseBranch: "main",
        headBranch: "feature/parent",
        title: "Parent PR",
      });
      await seedPr(db, {
        prId: "pr-child",
        projectId,
        laneId: childLane.id,
        number: 202,
        baseBranch: "feature/parent",
        headBranch: "feature/child",
        title: "Child PR",
      });

      const laneService = {
        list: vi.fn(async ({ includeArchived }: { includeArchived?: boolean } = {}) =>
          includeArchived ? lanes : lanes.filter((lane) => !lane.archivedAt)
        ),
        getChildren: vi.fn(async (laneId: string) => lanes.filter((lane) => lane.parentLaneId === laneId && !lane.archivedAt)),
        reparent: vi.fn(async ({ laneId, newParentLaneId }: { laneId: string; newParentLaneId: string }) => {
          const lane = lanes.find((entry) => entry.id === laneId)!;
          const newParent = lanes.find((entry) => entry.id === newParentLaneId)!;
          lane.parentLaneId = newParent.id;
          lane.baseRef = newParent.branchRef;
          return {
            laneId,
            previousParentLaneId: parentLane.id,
            newParentLaneId,
            previousBaseRef: "refs/heads/feature/parent",
            newBaseRef: newParent.branchRef,
            preHeadSha: "child-pre",
            postHeadSha: "child-post",
          };
        }),
        archive: vi.fn(async ({ laneId }: { laneId: string }) => {
          const lane = lanes.find((entry) => entry.id === laneId)!;
          lane.archivedAt = "2026-03-30T01:00:00.000Z";
        }),
        invalidateCache: vi.fn(),
      };

      runGitMock.mockResolvedValue({ exitCode: 0, stdout: "origin/feature/child\n", stderr: "" });
      runGitOrThrowMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      const apiRequest = vi.fn(async ({ method, path: requestPath, body }: { method: string; path: string; body?: any }) => {
        if (method === "PUT" && requestPath === "/repos/acme/ade/pulls/101/merge") {
          return { data: { sha: "merge-sha" } };
        }
        if (method === "PATCH" && requestPath === "/repos/acme/ade/pulls/202") {
          expect(body).toMatchObject({ base: "main" });
          return { data: {} };
        }
        if (method === "DELETE" && requestPath === "/repos/acme/ade/git/refs/heads/feature/parent") {
          return { data: {} };
        }
        return { data: {} };
      });

      const autoRebaseService = {
        recordAttentionStatus: vi.fn(async () => undefined),
        refreshActiveRebaseNeeds: vi.fn(async () => undefined),
      };

      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: laneService as any,
        operationService: {
          start: () => ({ operationId: "op-1" }),
          finish: vi.fn(),
        } as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {
          getEffective: () => ({ git: { autoRebaseOnHeadChange: true } }),
        } as any,
        conflictService: { scanRebaseNeeds: vi.fn(async () => []) } as any,
        autoRebaseService: autoRebaseService as any,
        rebaseSuggestionService: { refresh: vi.fn(async () => undefined) } as any,
        openExternal: async () => {},
      });

      const result = await service.land({ prId: "pr-parent", method: "squash", archiveLane: true });

      expect(result).toMatchObject({ success: true, branchDeleted: true, laneArchived: true });
      expect(laneService.reparent).toHaveBeenCalledWith({ laneId: "lane-child", newParentLaneId: "lane-main" });
      expect(runGitOrThrowMock).toHaveBeenCalledWith(
        ["push", "--force-with-lease"],
        expect.objectContaining({ cwd: childLane.worktreePath }),
      );
      expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
        method: "PATCH",
        path: "/repos/acme/ade/pulls/202",
      }));
      expect(laneService.archive).toHaveBeenCalledWith({ laneId: "lane-parent" });
      expect(autoRebaseService.recordAttentionStatus).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-child",
        state: "autoRebased",
      }));
      expect(autoRebaseService.refreshActiveRebaseNeeds).toHaveBeenCalledWith("merge_completed");
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the child lane and skips cleanup when the auto-push fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-land-auto-rebase-fail-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      const { createPrService } = await createServiceModule();
      const projectId = "proj-land-auto-rebase-fail";

      const mainLane = makeLane("lane-main", "main", "main", root, { laneType: "primary" });
      const parentLane = makeLane("lane-parent", "feature/parent", "feature/parent", path.join(root, "parent"), {
        parentLaneId: mainLane.id,
      });
      const childLane = makeLane("lane-child", "feature/child", "feature/child", path.join(root, "child"), {
        parentLaneId: parentLane.id,
        baseRef: "refs/heads/feature/parent",
      });
      const lanes = [mainLane, parentLane, childLane];

      await seedProject(db, projectId, root);
      await seedPr(db, {
        prId: "pr-parent",
        projectId,
        laneId: parentLane.id,
        number: 101,
        baseBranch: "main",
        headBranch: "feature/parent",
        title: "Parent PR",
      });

      const laneService = {
        list: vi.fn(async ({ includeArchived }: { includeArchived?: boolean } = {}) =>
          includeArchived ? lanes : lanes.filter((lane) => !lane.archivedAt)
        ),
        getChildren: vi.fn(async () => [childLane]),
        reparent: vi.fn(async ({ laneId, newParentLaneId }: { laneId: string; newParentLaneId: string }) => {
          childLane.parentLaneId = newParentLaneId;
          childLane.baseRef = "main";
          return {
            laneId,
            previousParentLaneId: parentLane.id,
            newParentLaneId,
            previousBaseRef: "refs/heads/feature/parent",
            newBaseRef: "main",
            preHeadSha: "child-pre",
            postHeadSha: "child-post",
          };
        }),
        archive: vi.fn(async () => undefined),
        invalidateCache: vi.fn(),
      };

      runGitMock.mockResolvedValue({ exitCode: 0, stdout: "origin/feature/child\n", stderr: "" });
      runGitOrThrowMock.mockImplementation(async (args: string[]) => {
        if (args[0] === "push") {
          throw new Error("remote rejected push");
        }
        if (args[0] === "reset") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const apiRequest = vi.fn(async ({ method, path: requestPath }: { method: string; path: string }) => {
        if (method === "PUT" && requestPath === "/repos/acme/ade/pulls/101/merge") {
          return { data: { sha: "merge-sha" } };
        }
        if (method === "DELETE" && requestPath === "/repos/acme/ade/git/refs/heads/feature/parent") {
          return { data: {} };
        }
        return { data: {} };
      });

      const autoRebaseService = {
        recordAttentionStatus: vi.fn(async () => undefined),
        refreshActiveRebaseNeeds: vi.fn(async () => undefined),
      };

      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: laneService as any,
        operationService: {
          start: () => ({ operationId: "op-1" }),
          finish: vi.fn(),
        } as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {
          getEffective: () => ({ git: { autoRebaseOnHeadChange: true } }),
        } as any,
        conflictService: { scanRebaseNeeds: vi.fn(async () => []) } as any,
        autoRebaseService: autoRebaseService as any,
        rebaseSuggestionService: { refresh: vi.fn(async () => undefined) } as any,
        openExternal: async () => {},
      });

      const result = await service.land({ prId: "pr-parent", method: "squash", archiveLane: true });

      expect(result).toMatchObject({ success: true, branchDeleted: false, laneArchived: false });
      expect(runGitOrThrowMock).toHaveBeenCalledWith(
        ["reset", "--hard", "child-pre"],
        expect.objectContaining({ cwd: childLane.worktreePath }),
      );
      expect(laneService.archive).not.toHaveBeenCalled();
      expect(apiRequest).not.toHaveBeenCalledWith(expect.objectContaining({
        method: "DELETE",
        path: "/repos/acme/ade/git/refs/heads/feature/parent",
      }));
      expect(autoRebaseService.recordAttentionStatus).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-child",
        state: "rebaseFailed",
      }));
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
