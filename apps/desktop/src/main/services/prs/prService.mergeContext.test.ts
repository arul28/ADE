import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
    createdAt: "2026-03-11T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

async function seedProject(db: any, projectId: string, repoRoot: string) {
  const now = "2026-03-11T00:00:00.000Z";
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
  const now = "2026-03-11T00:00:00.000Z";
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
      "https://example.com/pr/101",
      null,
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

describe("prService.getMergeContext", () => {
  it("returns base lane and integration lane separately for committed integration PRs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-merge-context-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-merge-context";

    const baseLane = makeLane("lane-main", "main", "refs/heads/main", { laneType: "primary", worktreePath: root });
    const sourceLaneA = makeLane("lane-a", "feature/a", "refs/heads/feature/a");
    const sourceLaneB = makeLane("lane-b", "feature/b", "refs/heads/feature/b");
    const integrationLane = makeLane("lane-int", "integration/search", "refs/heads/integration/search");

    await seedProject(db, projectId, root);
    await seedLane(db, projectId, baseLane);
    await seedLane(db, projectId, sourceLaneA);
    await seedLane(db, projectId, sourceLaneB);
    await seedLane(db, projectId, integrationLane);
    await seedPr(db, {
      prId: "pr-int",
      projectId,
      laneId: integrationLane.id,
      baseBranch: "main",
      headBranch: "integration/search",
      title: "Integration PR",
    });

    db.run(`insert into pr_groups(id, project_id, group_type, created_at) values (?, ?, 'integration', ?)`, [
      "group-int",
      projectId,
      "2026-03-11T00:00:00.000Z",
    ]);
    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, ?)`,
      ["member-int", "group-int", "pr-int", integrationLane.id, 0, "integration"],
    );
    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, ?)`,
      ["member-a", "group-int", "pr-int", sourceLaneA.id, 1, "source"],
    );
    db.run(
      `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, ?)`,
      ["member-b", "group-int", "pr-int", sourceLaneB.id, 2, "source"],
    );

    const service = createPrService({
      db,
      logger: createLogger() as any,
      projectId,
      projectRoot: root,
      laneService: {
        list: async () => [sourceLaneA, sourceLaneB, integrationLane, baseLane],
      } as any,
      operationService: {} as any,
      githubService: { apiRequest: async () => ({ data: {} }) } as any,
      aiIntegrationService: undefined,
      projectConfigService: {} as any,
      conflictService: undefined,
      openExternal: async () => {},
    });

    await expect(service.getMergeContext("pr-int")).resolves.toMatchObject({
      prId: "pr-int",
      groupId: "group-int",
      groupType: "integration",
      sourceLaneIds: ["lane-a", "lane-b"],
      targetLaneId: "lane-main",
      integrationLaneId: "lane-int",
    });
  });

  it("keeps integrationLaneId null for regular PRs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-merge-context-normal-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-merge-context-normal";

    const baseLane = makeLane("lane-main", "main", "refs/heads/main", { laneType: "primary", worktreePath: root });
    const sourceLane = makeLane("lane-auth", "feature/auth", "refs/heads/feature/auth");

    await seedProject(db, projectId, root);
    await seedLane(db, projectId, baseLane);
    await seedLane(db, projectId, sourceLane);
    await seedPr(db, {
      prId: "pr-normal",
      projectId,
      laneId: sourceLane.id,
      baseBranch: "main",
      headBranch: "feature/auth",
      title: "Normal PR",
    });

    const service = createPrService({
      db,
      logger: createLogger() as any,
      projectId,
      projectRoot: root,
      laneService: {
        list: async () => [sourceLane, baseLane],
      } as any,
      operationService: {} as any,
      githubService: { apiRequest: async () => ({ data: {} }) } as any,
      aiIntegrationService: undefined,
      projectConfigService: {} as any,
      conflictService: undefined,
      openExternal: async () => {},
    });

    await expect(service.getMergeContext("pr-normal")).resolves.toMatchObject({
      prId: "pr-normal",
      groupId: null,
      groupType: null,
      sourceLaneIds: ["lane-auth"],
      targetLaneId: "lane-main",
      integrationLaneId: null,
    });
  });

  it("does not infer a target lane from baseRef-only matches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-merge-context-base-ref-only-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-merge-context-base-ref-only";

    const sourceLane = makeLane("lane-auth", "feature/auth", "refs/heads/feature/auth");
    const siblingLane = makeLane("lane-other", "feature/other", "refs/heads/feature/other", {
      baseRef: "refs/heads/main",
    });

    await seedProject(db, projectId, root);
    await seedLane(db, projectId, sourceLane);
    await seedLane(db, projectId, siblingLane);
    await seedPr(db, {
      prId: "pr-normal",
      projectId,
      laneId: sourceLane.id,
      baseBranch: "main",
      headBranch: "feature/auth",
      title: "Normal PR",
    });

    const service = createPrService({
      db,
      logger: createLogger() as any,
      projectId,
      projectRoot: root,
      laneService: {
        list: async () => [sourceLane, siblingLane],
      } as any,
      operationService: {} as any,
      githubService: { apiRequest: async () => ({ data: {} }) } as any,
      aiIntegrationService: undefined,
      projectConfigService: {} as any,
      conflictService: undefined,
      openExternal: async () => {},
    });

    await expect(service.getMergeContext("pr-normal")).resolves.toMatchObject({
      prId: "pr-normal",
      sourceLaneIds: ["lane-auth"],
      targetLaneId: null,
      integrationLaneId: null,
    });
  });
});
