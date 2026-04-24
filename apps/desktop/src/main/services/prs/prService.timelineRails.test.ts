import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    createdAt: "2026-04-14T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

async function seedProject(db: any, projectId: string, repoRoot: string) {
  const now = "2026-04-14T00:00:00.000Z";
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

async function seedPr(db: any, args: { prId: string; projectId: string; laneId: string; prNumber: number }) {
  const now = "2026-04-14T00:00:00.000Z";
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
      "arul28",
      "ADE",
      args.prNumber,
      `https://github.com/arul28/ADE/pull/${args.prNumber}`,
      null,
      "Timeline + Rails",
      "open",
      "main",
      "feature/timeline",
      "passing",
      "approved",
      10,
      0,
      now,
      now,
      now,
    ],
  );
}

function mockReviewThreadsResponse() {
  return {
    data: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "thread-abc",
                  isResolved: false,
                  isOutdated: false,
                  path: "src/app.ts",
                  line: 10,
                  originalLine: 10,
                  startLine: null,
                  originalStartLine: null,
                  diffSide: "RIGHT",
                  comments: {
                    nodes: [
                      {
                        id: "comment-1",
                        body: "Please fix.",
                        url: "https://github.com/x/y/pull/1#r1",
                        createdAt: "2026-04-14T01:00:00.000Z",
                        updatedAt: "2026-04-14T01:00:00.000Z",
                        author: { login: "rev", avatarUrl: null },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

async function buildService(root: string) {
  const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
  const projectId = "proj-timeline";
  const lane = makeLane("lane-1", "feature/timeline", "refs/heads/feature/timeline", { worktreePath: root });
  await seedProject(db, projectId, root);
  await seedLane(db, projectId, lane);
  await seedPr(db, { prId: "pr-1", projectId, laneId: lane.id, prNumber: 42 });
  return { db, projectId, lane };
}

describe("prService.postReviewComment", () => {
  it("issues an addPullRequestReviewThreadReply GraphQL mutation and maps the response", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-post-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const apiRequest = vi.fn(async ({ path: requestPath, body }: any) => {
        if (requestPath !== "/graphql") return { data: {} };
        const query: string = body?.query ?? "";
        if (query.includes("reviewThreads(first:")) {
          return mockReviewThreadsResponse();
        }
        expect(query).toContain("addPullRequestReviewThreadReply");
        expect(body.variables).toMatchObject({ threadId: "thread-abc", body: "Thanks!" });
        return {
          data: {
            data: {
              addPullRequestReviewThreadReply: {
                comment: {
                  id: "comment-2",
                  body: "Thanks!",
                  url: "https://github.com/x/y/pull/1#r2",
                  createdAt: "2026-04-14T02:00:00.000Z",
                  updatedAt: "2026-04-14T02:00:00.000Z",
                  author: { login: "me", avatarUrl: "avatar.png" },
                },
              },
            },
          },
        };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });
      await expect(
        service.postReviewComment({ prId: "pr-1", threadId: "thread-abc", body: "Thanks!" }),
      ).resolves.toEqual({
        id: "comment-2",
        author: "me",
        authorAvatarUrl: "avatar.png",
        body: "Thanks!",
        url: "https://github.com/x/y/pull/1#r2",
        createdAt: "2026-04-14T02:00:00.000Z",
        updatedAt: "2026-04-14T02:00:00.000Z",
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects when the thread does not belong to the PR", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-post-wrong-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const apiRequest = vi.fn(async ({ path: p }: any) => {
        if (p === "/graphql") return mockReviewThreadsResponse();
        return { data: {} };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });
      await expect(
        service.postReviewComment({ prId: "pr-1", threadId: "not-mine", body: "..." }),
      ).rejects.toThrow(/does not belong/);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prService.setReviewThreadResolved", () => {
  it("uses resolveReviewThread mutation when resolved=true", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-resolve-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const apiRequest = vi.fn(async ({ path: p, body }: any) => {
        if (p !== "/graphql") return { data: {} };
        const q: string = body?.query ?? "";
        if (q.includes("reviewThreads(first:")) return mockReviewThreadsResponse();
        expect(q).toContain("resolveReviewThread(");
        expect(q).not.toContain("unresolveReviewThread");
        return {
          data: { data: { resolveReviewThread: { thread: { id: "thread-abc", isResolved: true } } } },
        };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });
      await expect(
        service.setReviewThreadResolved({ prId: "pr-1", threadId: "thread-abc", resolved: true }),
      ).resolves.toEqual({ threadId: "thread-abc", isResolved: true });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses unresolveReviewThread mutation when resolved=false", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-unresolve-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const apiRequest = vi.fn(async ({ path: p, body }: any) => {
        if (p !== "/graphql") return { data: {} };
        const q: string = body?.query ?? "";
        if (q.includes("reviewThreads(first:")) return mockReviewThreadsResponse();
        expect(q).toContain("unresolveReviewThread(");
        return {
          data: { data: { unresolveReviewThread: { thread: { id: "thread-abc", isResolved: false } } } },
        };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });
      await expect(
        service.setReviewThreadResolved({ prId: "pr-1", threadId: "thread-abc", resolved: false }),
      ).resolves.toEqual({ threadId: "thread-abc", isResolved: false });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prService.reactToComment", () => {
  it("issues addReaction with the correct enum value", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-react-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const apiRequest = vi.fn(async ({ path: p, body }: any) => {
        if (p !== "/graphql") return { data: {} };
        const q: string = body?.query ?? "";
        expect(q).toContain("addReaction(");
        expect(body.variables).toEqual({ subjectId: "comment-1", content: "ROCKET" });
        return { data: { data: { addReaction: { reaction: { id: "r1", content: "ROCKET" } } } } };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });
      await expect(
        service.reactToComment({ prId: "pr-1", commentId: "comment-1", content: "rocket" }),
      ).resolves.toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prService.getDeployments", () => {
  it("maps GitHub deployments + latest status into PrDeployment shape", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-deploy-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const apiRequest = vi.fn(async ({ path: p, query }: any) => {
        if (p === "/repos/arul28/ADE/pulls/42") {
          return { data: { head: { sha: "deadbeef" }, base: { sha: "baseabc" }, state: "open" } };
        }
        if (p === "/repos/arul28/ADE/deployments") {
          expect(query).toMatchObject({ sha: "deadbeef" });
          return {
            data: [
              {
                id: 1001,
                environment: "staging",
                description: "deploy-desc",
                payload: { web_url: "https://payload.example" },
                sha: "deadbeef",
                ref: "feature/timeline",
                creator: { login: "arul" },
                created_at: "2026-04-14T01:00:00.000Z",
                updated_at: "2026-04-14T01:00:00.000Z",
              },
            ],
          };
        }
        if (p === "/repos/arul28/ADE/deployments/1001/statuses") {
          return {
            data: [
              {
                state: "success",
                environment_url: "https://preview.example",
                log_url: "https://logs.example",
                target_url: "https://target.example",
                updated_at: "2026-04-14T02:00:00.000Z",
              },
            ],
          };
        }
        return { data: [] };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });
      const deployments = await service.getDeployments("pr-1");
      expect(deployments).toHaveLength(1);
      expect(deployments[0]).toMatchObject({
        environment: "staging",
        state: "success",
        environmentUrl: "https://preview.example",
        logUrl: "https://logs.example",
        sha: "deadbeef",
        ref: "feature/timeline",
        creator: "arul",
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty array when the PR has no head SHA", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-deploy-empty-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const apiRequest = vi.fn(async ({ path: p }: any) => {
        if (p === "/repos/arul28/ADE/pulls/42") {
          return { data: { head: {}, base: {} } };
        }
        return { data: [] };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });
      await expect(service.getDeployments("pr-1")).resolves.toEqual([]);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prService.refreshSnapshots commits", () => {
  it("stores the newest PR commits when GitHub returns more than 30", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-commits-"));
    const { db, projectId, lane } = await buildService(root);
    try {
      const commits = Array.from({ length: 35 }, (_, index) => {
        const n = String(index + 1).padStart(2, "0");
        return {
          sha: `sha-${n}`,
          commit: {
            message: `commit ${n}\n\nbody`,
            author: {
              name: `Author ${n}`,
              email: `a${n}@example.test`,
              date: `2026-04-14T00:${n}:00.000Z`,
            },
          },
          author: { login: `author-${n}` },
        };
      });
      const apiRequest = vi.fn(async ({ path: p }: any) => {
        if (p === "/repos/arul28/ADE/pulls/42") {
          return { data: { head: { sha: "sha-35" }, base: { sha: "base" }, state: "open" } };
        }
        if (p === "/repos/arul28/ADE/pulls/42/commits") {
          return { data: commits };
        }
        if (p.endsWith("/check-runs")) {
          return { data: { check_runs: [] } };
        }
        if (p.endsWith("/status")) {
          return { data: { state: "success", statuses: [] } };
        }
        return { data: [] };
      });
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: { list: async () => [lane] } as any,
        operationService: {} as any,
        githubService: { apiRequest } as any,
        aiIntegrationService: undefined,
        projectConfigService: {} as any,
        conflictService: undefined,
        openExternal: async () => {},
      });

      await service.refreshSnapshots({ prId: "pr-1" });
      const [snapshot] = service.listSnapshots({ prId: "pr-1" });

      expect(snapshot.commits).toHaveLength(30);
      expect(snapshot.commits[0].sha).toBe("sha-06");
      expect(snapshot.commits.at(-1)?.sha).toBe("sha-35");
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
