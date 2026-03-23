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
    createdAt: "2026-03-23T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

async function seedProject(db: any, projectId: string, repoRoot: string) {
  const now = "2026-03-23T00:00:00.000Z";
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
  const now = "2026-03-23T00:00:00.000Z";
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
      80,
      "https://github.com/arul28/ADE/pull/80",
      null,
      args.title,
      "open",
      args.baseBranch,
      args.headBranch,
      "failing",
      "changes_requested",
      0,
      0,
      now,
      now,
      now,
    ],
  );
}

describe("prService.getReviewThreads", () => {
  it("fetches review threads without querying unsupported thread timestamps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-review-threads-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-review-threads";
    const lane = makeLane("lane-80", "feature/pr-80", "refs/heads/feature/pr-80", { worktreePath: root });

    await seedProject(db, projectId, root);
    await seedLane(db, projectId, lane);
    await seedPr(db, {
      prId: "pr-80",
      projectId,
      laneId: lane.id,
      baseBranch: "main",
      headBranch: "feature/pr-80",
      title: "Fix PR review thread loading",
    });

    const apiRequest = vi.fn(async ({ path: requestPath, body }: { path: string; body?: { query?: string } }) => {
      if (requestPath !== "/graphql") return { data: {} };
      const query = body?.query ?? "";
      expect(query.match(/\bcreatedAt\b/g)?.length ?? 0).toBe(1);
      expect(query.match(/\bupdatedAt\b/g)?.length ?? 0).toBe(1);
      return {
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: false,
                      path: "apps/desktop/src/main/services/prs/prService.ts",
                      line: 1097,
                      originalLine: 1097,
                      startLine: null,
                      originalStartLine: null,
                      diffSide: "RIGHT",
                      comments: {
                        nodes: [
                          {
                            id: "comment-1",
                            body: "Please load CodeRabbit review threads correctly.",
                            url: "https://github.com/arul28/ADE/pull/80#discussion_r1",
                            createdAt: "2026-03-23T01:00:00.000Z",
                            updatedAt: "2026-03-23T01:05:00.000Z",
                            author: {
                              login: "coderabbitai",
                              avatarUrl: "https://example.com/avatar.png",
                            },
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
    });

    const service = createPrService({
      db,
      logger: createLogger() as any,
      projectId,
      projectRoot: root,
      laneService: {
        list: async () => [lane],
      } as any,
      operationService: {} as any,
      githubService: { apiRequest } as any,
      aiIntegrationService: undefined,
      projectConfigService: {} as any,
      conflictService: undefined,
      openExternal: async () => {},
    });

    await expect(service.getReviewThreads("pr-80")).resolves.toEqual([
      {
        id: "thread-1",
        isResolved: false,
        isOutdated: false,
        path: "apps/desktop/src/main/services/prs/prService.ts",
        line: 1097,
        originalLine: 1097,
        startLine: 0,
        originalStartLine: 0,
        diffSide: "RIGHT",
        url: "https://github.com/arul28/ADE/pull/80#discussion_r1",
        createdAt: "2026-03-23T01:00:00.000Z",
        updatedAt: "2026-03-23T01:05:00.000Z",
        comments: [
          {
            id: "comment-1",
            author: "coderabbitai",
            authorAvatarUrl: "https://example.com/avatar.png",
            body: "Please load CodeRabbit review threads correctly.",
            url: "https://github.com/arul28/ADE/pull/80#discussion_r1",
            createdAt: "2026-03-23T01:00:00.000Z",
            updatedAt: "2026-03-23T01:05:00.000Z",
          },
        ],
      },
    ]);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});
