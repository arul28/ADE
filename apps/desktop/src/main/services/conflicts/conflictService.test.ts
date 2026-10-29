import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openKvDb } from "../state/kvDb";
import { createConflictService } from "./conflictService";
import { missingFeatureModelMessage } from "../ai/aiIntegrationService";

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
    error: () => {}
  } as any;
}

function createLaneSummary(repoRoot: string, args: { id?: string; name?: string; branchRef?: string; baseRef?: string; parentLaneId?: string | null } = {}) {
  return {
    id: args.id ?? "lane-1",
    name: args.name ?? "Lane 1",
    description: null,
    laneType: "worktree",
    branchRef: args.branchRef ?? "feature/lane-1",
    baseRef: args.baseRef ?? "main",
    worktreePath: repoRoot,
    attachedRootPath: null,
    isEditProtected: false,
    parentLaneId: args.parentLaneId ?? null,
    color: null,
    icon: null,
    tags: [],
    status: { dirty: false, ahead: 1, behind: 0, conflict: "unknown", tests: "unknown", pr: "none" },
    stackDepth: 0,
    createdAt: "2026-02-15T00:00:00.000Z",
    archivedAt: null
  };
}

function seedRepoWithLaneWork(root: string): { laneHeadSha: string } {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "ade@test.local"]);
  git(root, ["config", "user.name", "ADE Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["checkout", "-b", "feature/lane-1"]);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\nexport const b = 3;\n", "utf8");
  git(root, ["add", "src/a.ts"]);
  git(root, ["commit", "-m", "lane change"]);
  return { laneHeadSha: git(root, ["rev-parse", "HEAD"]) };
}

async function seedProjectAndLane(db: any, projectId: string, repoRoot: string) {
  const now = "2026-02-15T19:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, repoRoot, "demo", "main", now, now]
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-1", projectId, "Lane 1", null, "worktree", "main", "feature/lane-1", repoRoot, null, 0, null, null, null, null, "active", now, null]
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-target", projectId, "Target Lane", null, "worktree", "main", "feature/target", repoRoot, null, 0, null, null, null, null, "active", now, null]
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-2", projectId, "Lane 2", null, "worktree", "main", "feature/lane-2", repoRoot, null, 0, null, null, null, null, "active", now, null]
  );
}

function insertPrediction(args: {
  db: any;
  projectId: string;
  laneAId: string;
  laneBSha?: string | null;
  laneBId?: string | null;
  laneASha: string;
  overlaps: string[];
  status?: "clean" | "conflict" | "unknown";
  predictedAt?: string;
}) {
  args.db.run(
    `
      insert into conflict_predictions(
        id, project_id, lane_a_id, lane_b_id, status, conflicting_files_json, overlap_files_json,
        lane_a_sha, lane_b_sha, predicted_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      randomUUID(),
      args.projectId,
      args.laneAId,
      args.laneBId ?? null,
      args.status ?? "conflict",
      JSON.stringify([]),
      JSON.stringify(args.overlaps),
      args.laneASha,
      args.laneBSha ?? null,
      args.predictedAt ?? "2026-02-15T18:50:00.000Z",
      "2026-02-15T20:00:00.000Z"
    ]
  );
}

describe("conflictService conflict context integrity", () => {
  it("marks risk matrix predictions stale when the lane HEAD SHA changed", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-stale-sha-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const baseHeadSha = git(repoRoot, ["rev-parse", "main"]);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-stale-sha";
    try {
      await seedProjectAndLane(db, projectId, repoRoot);
      insertPrediction({
        db,
        projectId,
        laneAId: "lane-1",
        laneASha: "old-lane-head",
        laneBSha: baseHeadSha,
        overlaps: ["src/a.ts"],
        predictedAt: new Date().toISOString(),
      });
      const laneSummary = createLaneSummary(repoRoot);
      const service = createConflictService({
        db,
        logger: createLogger(),
        projectId,
        projectRoot: repoRoot,
        laneService: {
          getCompareBase: () => "main",
          list: async () => [laneSummary],
          getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/lane-1" }),
        } as any,
        projectConfigService: {
          get: () => ({ effective: { providerMode: "subscription" } }),
        } as any,
      });

      const matrix = await service.getRiskMatrix();

      expect(laneHeadSha).not.toBe("old-lane-head");
      expect(matrix.find((entry) => entry.laneAId === "lane-1" && entry.laneBId === "lane-1")?.stale).toBe(true);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("passes relevant file contexts into subscription conflict proposal jobs", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-ctx-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const dbPath = path.join(repoRoot, "kv.sqlite");
    const db = await openKvDb(dbPath, createLogger());
    const projectId = "proj-ctx";
    await seedProjectAndLane(db, projectId, repoRoot);

    db.run(
      `
        insert into conflict_predictions(
          id, project_id, lane_a_id, lane_b_id, status, conflicting_files_json, overlap_files_json,
          lane_a_sha, lane_b_sha, predicted_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        projectId,
        "lane-1",
        null,
        "conflict",
        JSON.stringify([]),
        JSON.stringify(["src/a.ts"]),
        laneHeadSha,
        null,
        "2026-02-15T18:50:00.000Z",
        "2026-02-15T20:00:00.000Z"
      ]
    );

    const laneSummary = createLaneSummary(repoRoot);
    let capturedRequest: any = null;
    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        getCompareBase: () => "main",
        list: async () => [laneSummary],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/lane-1" })
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            providerMode: "subscription",
            ai: { featureModelOverrides: { conflict_proposals: "anthropic/claude-sonnet-5" } },
          },
        })
      } as any,
      aiIntegrationService: {
        getMode: () => "subscription",
        requestConflictProposal: async (args: any) => {
          capturedRequest = args;
          return {
            text: JSON.stringify({
              explanation: "subscription explanation",
              confidence: 0.8,
              diffPatch: "diff --git a/src/a.ts b/src/a.ts\n"
            }),
            structuredOutput: {
              explanation: "subscription explanation",
              confidence: 0.8,
              diffPatch: "diff --git a/src/a.ts b/src/a.ts\n"
            },
            provider: "claude",
            model: "sonnet",
            sessionId: "ai-session-1",
            inputTokens: 100,
            outputTokens: 80,
            durationMs: 1200
          };
        }
      } as any
    });

    const preview = await service.prepareProposal({ laneId: "lane-1" });
    const proposal = await service.requestProposal({ laneId: "lane-1", contextDigest: preview.contextDigest });

    expect(proposal.diffPatch).toContain("diff --git");
    expect(capturedRequest).toBeTruthy();
    expect(capturedRequest.model).toBe("anthropic/claude-sonnet-5");
    expect(typeof capturedRequest.prompt).toBe("string");
    expect(capturedRequest.prompt).toContain("relevantFilesForConflict");
  });

  it("refuses subscription conflict proposals when no Conflict Proposals model is configured", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-no-model-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const dbPath = path.join(repoRoot, "kv.sqlite");
    const db = await openKvDb(dbPath, createLogger());
    const projectId = "proj-no-model";
    await seedProjectAndLane(db, projectId, repoRoot);

    db.run(
      `
        insert into conflict_predictions(
          id, project_id, lane_a_id, lane_b_id, status, conflicting_files_json, overlap_files_json,
          lane_a_sha, lane_b_sha, predicted_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        projectId,
        "lane-1",
        null,
        "conflict",
        JSON.stringify([]),
        JSON.stringify(["src/a.ts"]),
        laneHeadSha,
        null,
        "2026-02-15T18:50:00.000Z",
        "2026-02-15T20:00:00.000Z"
      ]
    );

    const laneSummary = createLaneSummary(repoRoot);
    const requestConflictProposal = vi.fn();
    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        getCompareBase: () => "main",
        list: async () => [laneSummary],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/lane-1" })
      } as any,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "subscription" } })
      } as any,
      aiIntegrationService: {
        getMode: () => "subscription",
        requestConflictProposal,
      } as any
    });

    const preview = await service.prepareProposal({ laneId: "lane-1" });
    await expect(
      service.requestProposal({ laneId: "lane-1", contextDigest: preview.contextDigest }),
    ).rejects.toThrow(missingFeatureModelMessage("conflict_proposals"));
    expect(requestConflictProposal).not.toHaveBeenCalled();
    db.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("returns insufficient-context proposal without calling subscription provider", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-insufficient-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const dbPath = path.join(repoRoot, "kv.sqlite");
    const db = await openKvDb(dbPath, createLogger());
    const projectId = "proj-insufficient";
    await seedProjectAndLane(db, projectId, repoRoot);

    db.run(
      `
        insert into conflict_predictions(
          id, project_id, lane_a_id, lane_b_id, status, conflicting_files_json, overlap_files_json,
          lane_a_sha, lane_b_sha, predicted_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        projectId,
        "lane-1",
        null,
        "conflict",
        JSON.stringify([]),
        JSON.stringify(["src/missing.ts"]),
        laneHeadSha,
        null,
        "2026-02-15T18:50:00.000Z",
        "2026-02-15T20:00:00.000Z"
      ]
    );

    const laneSummary = createLaneSummary(repoRoot);
    let aiCalled = false;
    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        getCompareBase: () => "main",
        list: async () => [laneSummary],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/lane-1" })
      } as any,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "subscription" } })
      } as any,
      aiIntegrationService: {
        getMode: () => "subscription",
        requestConflictProposal: async () => {
          aiCalled = true;
          throw new Error("should not be called");
        }
      } as any
    });

    const preview = await service.prepareProposal({ laneId: "lane-1" });
    const proposal = await service.requestProposal({ laneId: "lane-1", contextDigest: preview.contextDigest });

    expect(aiCalled).toBe(false);
    expect(proposal.source).toBe("local");
    expect(proposal.diffPatch).toBe("");
    expect(proposal.explanation).toContain("Insufficient context");
  });

  it("prefers origin/<baseRef> for unparented lanes when the remote has advanced", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-root-base-remote-"));
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-root-base-remote-origin-"));
    const remoteWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-root-base-remote-work-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = randomUUID();
    const now = "2026-03-24T12:00:00.000Z";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        [projectId, repoRoot, "demo", "main", now, now]
      );

      fs.writeFileSync(path.join(repoRoot, "file.txt"), "base\n", "utf8");
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.email", "ade@test.local"]);
      git(repoRoot, ["config", "user.name", "ADE Test"]);
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-m", "base"]);
      git(remoteRoot, ["init", "--bare"]);
      git(repoRoot, ["remote", "add", "origin", remoteRoot]);
      git(repoRoot, ["push", "-u", "origin", "main"]);

      git(repoRoot, ["checkout", "-b", "feature/root-lane"]);

      git(remoteWorkRoot, ["clone", remoteRoot, "."]);
      git(remoteWorkRoot, ["checkout", "-B", "main", "origin/main"]);
      git(remoteWorkRoot, ["config", "user.email", "ade@test.local"]);
      git(remoteWorkRoot, ["config", "user.name", "ADE Test"]);
      fs.writeFileSync(path.join(remoteWorkRoot, "base.txt"), "new base commit\n", "utf8");
      git(remoteWorkRoot, ["add", "base.txt"]);
      git(remoteWorkRoot, ["commit", "-m", "base advance"]);
      git(remoteWorkRoot, ["push", "origin", "HEAD:main"]);

      git(repoRoot, ["fetch", "origin"]);

      const rootLane = createLaneSummary(repoRoot, {
        id: "lane-root",
        name: "Root",
        branchRef: "feature/root-lane",
        baseRef: "main",
        parentLaneId: null,
      });

      const service = createConflictService({
        db,
        logger: createLogger(),
        projectId,
        projectRoot: repoRoot,
        laneService: {
          getCompareBase: () => "main",
          list: async () => [rootLane],
          getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/root-lane" }),
        } as any,
        projectConfigService: {
          get: () => ({ effective: { providerMode: "guest" }, local: {} }),
        } as any,
      });

      const needs = await service.scanRebaseNeeds();
      expect(needs).toHaveLength(1);
      expect(needs[0]).toMatchObject({
        laneId: "lane-root",
        baseBranch: "main",
      });
      expect(needs[0]!.behindBy).toBeGreaterThan(0);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(remoteRoot, { recursive: true, force: true });
      fs.rmSync(remoteWorkRoot, { recursive: true, force: true });
    }
  });
});
