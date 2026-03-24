import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createPrService } from "./prService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeLane(id: string, name: string, branchRef: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name,
    description: null,
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef,
    worktreePath: `/tmp/${id}`,
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
    createdAt: "2026-03-24T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

async function seedProject(db: any, projectId: string, repoRoot: string) {
  const now = "2026-03-24T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, repoRoot, "ADE", "main", now, now],
  );
}

async function seedLane(db: any, projectId: string, lane: LaneSummary) {
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      lane.id,
      projectId,
      lane.name,
      lane.description,
      lane.laneType,
      lane.baseRef,
      lane.branchRef,
      lane.worktreePath,
      lane.attachedRootPath,
      lane.isEditProtected ? 1 : 0,
      lane.parentLaneId,
      lane.color,
      lane.icon,
      JSON.stringify(lane.tags),
      "active",
      lane.createdAt,
      lane.archivedAt,
    ],
  );
}

async function seedPr(db: any, args: {
  prId: string;
  projectId: string;
  laneId: string;
  baseBranch: string;
  headBranch: string;
  title: string;
}) {
  const now = "2026-03-24T00:00:00.000Z";
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
      101,
      "https://github.com/acme/ade/pull/101",
      "node-101",
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

describe("prService hot refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tracks hot windows and decays from 5s to 15s to idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-hot-delay-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId: "proj-hot-delay",
        projectRoot: root,
        laneService: { list: async () => [] } as any,
        operationService: {} as any,
        githubService: { apiRequest: async () => ({ data: {} }), getStatus: async () => ({ tokenStored: false, repo: null, userLogin: null }) } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        rebaseSuggestionService: null,
        openExternal: async () => {},
      });

      expect(service.getHotRefreshPrIds()).toEqual([]);
      expect(service.getHotRefreshDelayMs()).toBeNull();

      service.markHotRefresh(["pr-1"]);
      expect(service.getHotRefreshPrIds()).toEqual(["pr-1"]);
      expect(service.getHotRefreshDelayMs()).toBe(5_000);

      vi.setSystemTime(new Date("2026-03-24T12:01:01.000Z"));
      expect(service.getHotRefreshDelayMs()).toBe(15_000);

      vi.setSystemTime(new Date("2026-03-24T12:03:01.000Z"));
      expect(service.getHotRefreshPrIds()).toEqual([]);
      expect(service.getHotRefreshDelayMs()).toBeNull();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates the GitHub snapshot cache on hot starts and summary changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-hot-cache-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      const projectId = "proj-hot-cache";
      const lane = makeLane("lane-1", "feature/pr-1", "refs/heads/feature/pr-1");
      await seedProject(db, projectId, root);
      await seedLane(db, projectId, lane);
      await seedPr(db, {
        prId: "pr-1",
        projectId,
        laneId: lane.id,
        baseBranch: "main",
        headBranch: "feature/pr-1",
        title: "Old title",
      });

      let snapshotTitle = "Old title";
      const apiRequest = vi.fn(async ({ path: requestPath }: { path: string }) => {
        if (requestPath === "/repos/acme/ade/pulls") {
          return {
            data: [
              {
                id: 101,
                node_id: "node-101",
                number: 101,
                title: snapshotTitle,
                state: "open",
                draft: false,
                html_url: "https://github.com/acme/ade/pull/101",
                updated_at: "2026-03-24T12:00:00.000Z",
                created_at: "2026-03-24T00:00:00.000Z",
                base: { ref: "main", repo: { owner: { login: "acme" }, name: "ade" } },
                head: { ref: "feature/pr-1", sha: "head-sha-1", repo: { owner: { login: "acme" }, name: "ade" } },
                user: { login: "alice" },
              },
            ],
          };
        }
        if (requestPath === "/repos/acme/ade/pulls/101") {
          return {
            data: {
              node_id: "node-101",
              html_url: "https://github.com/acme/ade/pull/101",
              title: snapshotTitle,
              state: "open",
              draft: false,
              updated_at: "2026-03-24T12:00:00.000Z",
              created_at: "2026-03-24T00:00:00.000Z",
              additions: 3,
              deletions: 1,
              base: { ref: "main", sha: "base-sha-1" },
              head: { ref: "feature/pr-1", sha: "head-sha-1" },
              user: { login: "alice", avatar_url: null },
              labels: [],
              assignees: [],
              requested_reviewers: [],
              milestone: null,
            },
          };
        }
        if (requestPath === "/repos/acme/ade/commits/head-sha-1/status") {
          return { data: { state: "success", statuses: [] } };
        }
        if (requestPath === "/repos/acme/ade/commits/head-sha-1/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (requestPath === "/repos/acme/ade/pulls/101/reviews") {
          return { data: [] };
        }
        return { data: {} };
      });

      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: {
          apiRequest,
          getStatus: async () => ({ tokenStored: true, repo: { owner: "acme", name: "ade" }, userLogin: null }),
        } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        rebaseSuggestionService: null,
        openExternal: async () => {},
      });

      const firstSnapshot = await service.getGithubSnapshot();
      expect(firstSnapshot.repoPullRequests).toHaveLength(1);
      expect(firstSnapshot.repoPullRequests[0]?.title).toBe("Old title");
      const callsAfterFirstSnapshot = apiRequest.mock.calls.length;

      service.markHotRefresh(["pr-1"]);
      const secondSnapshot = await service.getGithubSnapshot();
      expect(apiRequest.mock.calls.length).toBeGreaterThan(callsAfterFirstSnapshot);
      expect(secondSnapshot.repoPullRequests[0]?.title).toBe("Old title");

      snapshotTitle = "New title";
      await service.refresh({ prId: "pr-1" });
      const thirdSnapshot = await service.getGithubSnapshot();
      expect(apiRequest.mock.calls.length).toBeGreaterThan(callsAfterFirstSnapshot + 1);
      expect(thirdSnapshot.repoPullRequests[0]?.title).toBe("New title");
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
