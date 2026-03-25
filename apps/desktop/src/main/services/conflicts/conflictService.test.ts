import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openKvDb } from "../state/kvDb";
import { createConflictService } from "./conflictService";

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

function seedQueueRebaseRepo(root: string): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export const base = 1;\n", "utf8");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "ade@test.local"]);
  git(root, ["config", "user.name", "ADE Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);

  git(root, ["checkout", "-b", "feature/lane-2"]);
  fs.writeFileSync(path.join(root, "src", "lane2.ts"), "export const lane2 = true;\n", "utf8");
  git(root, ["add", "src/lane2.ts"]);
  git(root, ["commit", "-m", "lane 2 work"]);

  git(root, ["checkout", "main"]);
  fs.writeFileSync(path.join(root, "src", "landed.ts"), "export const landed = true;\n", "utf8");
  git(root, ["add", "src/landed.ts"]);
  git(root, ["commit", "-m", "land queue item 1"]);

  git(root, ["checkout", "feature/lane-2"]);
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
      "2026-02-15T18:50:00.000Z",
      "2026-02-15T20:00:00.000Z"
    ]
  );
}

describe("conflictService conflict context integrity", () => {
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
        list: async () => [laneSummary],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/lane-1" })
      } as any,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "subscription" } })
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
    expect(typeof capturedRequest.prompt).toBe("string");
    expect(capturedRequest.prompt).toContain("relevantFilesForConflict");
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

  it("runs external resolver in source lane worktree for single-lane merge and ingests patch output", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-external-single-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-external-single";
    await seedProjectAndLane(db, projectId, repoRoot);
    const packsRoot = path.join(repoRoot, ".ade", "packs");

    insertPrediction({
      db,
      projectId,
      laneAId: "lane-1",
      laneBId: "lane-target",
      laneASha: laneHeadSha,
      overlaps: ["src/a.ts"],
      status: "clean"
    });

    const lanes = [
      createLaneSummary(repoRoot, { id: "lane-1", name: "Source lane", branchRef: "feature/lane-1" }),
      createLaneSummary(repoRoot, { id: "lane-target", name: "Target lane", branchRef: "main", parentLaneId: null })
    ];
    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => lanes,
        create: async () => {
          throw new Error("integration lane should not be created for single-lane run");
        },
        getLaneBaseAndBranch: ({ laneId }: { laneId: string }) => {
          const lane = lanes.find((entry) => entry.id === laneId) ?? lanes[0]!;
          return { worktreePath: lane.worktreePath, baseRef: lane.baseRef, branchRef: lane.branchRef };
        }
      } as any,
      projectConfigService: {
        get: () => ({
	          local: {
	            providers: {
	              contextTools: {
	                conflictResolvers: {
	                  codex: {
	                    command: ["sh", "-lc", "echo '// resolver change' >> src/a.ts; printf \"Done. Here's what changed:\\n- src/a.ts\\n\""]
	                  }
	                }
	              }
	            }
          },
          effective: { providerMode: "guest", providers: {} }
        })
      } as any,
      conflictPacksDir: path.join(packsRoot, "conflicts")
    });

    const run = await service.runExternalResolver({
      provider: "codex",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-1"]
    });

    expect(run.status).toBe("completed");
    expect(run.cwdLaneId).toBe("lane-1");
    expect(run.integrationLaneId).toBeNull();
    expect(run.patchPath).toBeTruthy();
    expect(fs.existsSync(run.patchPath!)).toBe(true);
    expect(fs.readFileSync(run.patchPath!, "utf8")).toContain("diff --git");
    expect(run.summary ?? "").toContain("src/a.ts");
    const promptPath = path.join(path.dirname(run.logPath ?? run.patchPath!), "prompt.md");
    const prompt = fs.readFileSync(promptPath, "utf8");
    const runDir = path.dirname(promptPath);
    const projectContextPath = path.join(runDir, "project-context.md");
    const sourceLaneContextPath = path.join(runDir, "lane-context-lane-1.md");
    const targetLaneContextPath = path.join(runDir, "lane-context-lane-target.md");
    const conflictContextPath = path.join(runDir, "conflict-context-lane-1-to-lane-target.json");
    expect(prompt).toContain("## ADE Context Files");
    expect(prompt).toContain("Read all required generated ADE context files listed below.");
    expect(prompt).toContain(projectContextPath);
    expect(prompt).toContain(sourceLaneContextPath);
    expect(prompt).toContain(targetLaneContextPath);
    expect(prompt).toContain(conflictContextPath);
    expect(prompt).not.toContain("## Optional Docs");
    expect(fs.existsSync(projectContextPath)).toBe(true);
    expect(fs.existsSync(sourceLaneContextPath)).toBe(true);
    expect(fs.existsSync(targetLaneContextPath)).toBe(true);
    expect(fs.existsSync(conflictContextPath)).toBe(true);
    expect(prompt).toContain("Do not run: git add, git commit, git push");
    expect(prompt).toContain("Modify/delete or rename/delete conflicts default to the target-side deletion");
    const conflictContext = JSON.parse(fs.readFileSync(conflictContextPath, "utf8"));
    expect(conflictContext.relationship).toBe("source-vs-target");
    expect(conflictContext.intent?.source?.laneId).toBe("lane-1");
    expect(conflictContext).not.toHaveProperty("conflictContext");
  });

  it("commits only external resolver patch paths when quick-commit is used", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-external-commit-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-external-commit";
    await seedProjectAndLane(db, projectId, repoRoot);

    insertPrediction({
      db,
      projectId,
      laneAId: "lane-1",
      laneBId: "lane-target",
      laneASha: laneHeadSha,
      overlaps: ["src/a.ts"],
      status: "clean"
    });

    const lanes = [
      createLaneSummary(repoRoot, { id: "lane-1", name: "Source lane", branchRef: "feature/lane-1" }),
      createLaneSummary(repoRoot, { id: "lane-target", name: "Target lane", branchRef: "main", parentLaneId: null })
    ];
    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => lanes,
        create: async () => {
          throw new Error("integration lane should not be created for single-lane run");
        },
        getLaneBaseAndBranch: ({ laneId }: { laneId: string }) => {
          const lane = lanes.find((entry) => entry.id === laneId) ?? lanes[0]!;
          return { worktreePath: lane.worktreePath, baseRef: lane.baseRef, branchRef: lane.branchRef };
        }
      } as any,
      projectConfigService: {
        get: () => ({
	          local: {
	            providers: {
	              contextTools: {
	                conflictResolvers: {
	                  codex: {
	                    command: ["sh", "-lc", "echo '// resolver change' >> src/a.ts; printf \"Done. Here's what changed:\\n- src/a.ts\\n\""]
	                  }
	                }
	              }
	            }
          },
          effective: { providerMode: "guest", providers: {} }
        })
      } as any,
    });

    const run = await service.runExternalResolver({
      provider: "codex",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-1"]
    });
    expect(run.status).toBe("completed");
    expect(run.runId).toBeTruthy();

    fs.writeFileSync(path.join(repoRoot, "src", "unrelated.ts"), "export const unrelated = true;\n", "utf8");
    git(repoRoot, ["add", "src/unrelated.ts"]);

    const committed = await service.commitExternalResolverRun({
      runId: run.runId,
      message: "Resolve conflicts via external run"
    });
    expect(committed.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(committed.committedPaths).toContain("src/a.ts");
    expect(git(repoRoot, ["log", "-1", "--pretty=%s"])).toBe("Resolve conflicts via external run");

    const committedFiles = git(repoRoot, ["show", "--name-only", "--pretty=format:", "HEAD"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(committedFiles).toContain("src/a.ts");
    expect(committedFiles).not.toContain("src/unrelated.ts");

    const stillStaged = git(repoRoot, ["diff", "--name-only", "--cached"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(stillStaged).toContain("src/unrelated.ts");

    const runs = service.listExternalResolverRuns({ laneId: "lane-1" });
    const saved = runs.find((entry) => entry.runId === run.runId);
    expect(saved?.commitSha).toBe(committed.commitSha);
    expect(saved?.commitMessage).toBe("Resolve conflicts via external run");
  });

  it("creates/uses integration lane for multi-lane external resolver runs", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-external-multi-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-external-multi";
    await seedProjectAndLane(db, projectId, repoRoot);

    insertPrediction({
      db,
      projectId,
      laneAId: "lane-1",
      laneBId: "lane-target",
      laneASha: laneHeadSha,
      overlaps: ["src/a.ts"]
    });
    insertPrediction({
      db,
      projectId,
      laneAId: "lane-2",
      laneBId: "lane-target",
      laneASha: laneHeadSha,
      overlaps: ["src/a.ts"]
    });

    const integrationLane = createLaneSummary(repoRoot, { id: "lane-integration", name: "Integration lane", branchRef: "ade/integration" });
    let createCalled = false;
    const lanes = [
      createLaneSummary(repoRoot, { id: "lane-1", name: "Source 1", branchRef: "feature/one" }),
      createLaneSummary(repoRoot, { id: "lane-2", name: "Source 2", branchRef: "feature/two" }),
      createLaneSummary(repoRoot, { id: "lane-target", name: "Target", branchRef: "main" })
    ];

    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => lanes,
        create: async () => {
          createCalled = true;
          return integrationLane;
        },
        getLaneBaseAndBranch: ({ laneId }: { laneId: string }) => {
          const lane = laneId === integrationLane.id ? integrationLane : (lanes.find((entry) => entry.id === laneId) ?? lanes[0]!);
          return { worktreePath: lane.worktreePath, baseRef: lane.baseRef, branchRef: lane.branchRef };
        }
      } as any,
      projectConfigService: {
        get: () => ({
	          local: {
	            providers: {
	              contextTools: {
	                conflictResolvers: {
	                  claude: {
	                    command: ["sh", "-lc", "printf \"Done. Here's what changed:\\n- src/a.ts\\n\""]
	                  }
	                }
	              }
	            }
          },
          effective: { providerMode: "guest", providers: {} }
        })
      } as any,
    });

    const run = await service.runExternalResolver({
      provider: "claude",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-1", "lane-2"],
      integrationLaneName: "Integration lane"
    });

    expect(createCalled).toBe(true);
    expect(run.integrationLaneId).toBe("lane-integration");
    expect(run.cwdLaneId).toBe("lane-integration");
  });

  it("tracks shared resolver session metadata across prepare, attach, and cancel", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-session-meta-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-session-meta";
    await seedProjectAndLane(db, projectId, repoRoot);

    insertPrediction({
      db,
      projectId,
      laneAId: "lane-1",
      laneBId: "lane-target",
      laneASha: laneHeadSha,
      overlaps: ["src/a.ts"]
    });

    const lanes = [
      createLaneSummary(repoRoot, { id: "lane-1", name: "Source lane", branchRef: "feature/lane-1" }),
      createLaneSummary(repoRoot, { id: "lane-target", name: "Target lane", branchRef: "main" })
    ];
    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => lanes,
        getLaneBaseAndBranch: ({ laneId }: { laneId: string }) => {
          const lane = lanes.find((entry) => entry.id === laneId) ?? lanes[0]!;
          return { worktreePath: lane.worktreePath, baseRef: lane.baseRef, branchRef: lane.branchRef };
        }
      } as any,
      projectConfigService: {
        get: () => ({
          local: { providers: { contextTools: { conflictResolvers: {} } } },
          effective: { providerMode: "guest", providers: {} }
        })
      } as any,
    });

    const prepared = await service.prepareResolverSession({
      provider: "claude",
      sourceLaneIds: ["lane-1"],
      targetLaneId: "lane-target",
      scenario: "single-merge",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "high",
      permissionMode: "full_edit",
      originSurface: "mission",
      originMissionId: "mission-1",
      originRunId: "run-1",
      originLabel: "Mission finalization",
    });

    expect(prepared.status).toBe("blocked");
    const preparedSummary = service.listExternalResolverRuns({ laneId: "lane-1" }).find((entry) => entry.runId === prepared.runId);
    expect(preparedSummary?.originSurface).toBe("mission");
    expect(preparedSummary?.originMissionId).toBe("mission-1");
    expect(preparedSummary?.originRunId).toBe("run-1");
    expect(preparedSummary?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(preparedSummary?.reasoningEffort).toBe("high");
    expect(preparedSummary?.permissionMode).toBe("full_edit");
    expect(preparedSummary?.resolverContextKey).toBeTruthy();

    const attached = await service.attachResolverSession({
      runId: prepared.runId,
      sessionId: "session-1",
      ptyId: "pty-1",
      command: ["claude", "--dangerously-skip-permissions"],
    });

    expect(attached.status).toBe("blocked");
    expect(attached.sessionId).toBe("session-1");
    expect(attached.ptyId).toBe("pty-1");
    expect(attached.command).toEqual(["claude", "--dangerously-skip-permissions"]);

    const canceled = await service.cancelResolverSession({
      runId: prepared.runId,
      reason: "User canceled the resolver.",
    });

    expect(canceled.status).toBe("canceled");
    expect(canceled.error).toContain("User canceled");
  });

  it("short-circuits external resolver when context is insufficient", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-external-insufficient-"));
    const { laneHeadSha } = seedRepoWithLaneWork(repoRoot);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-external-insufficient";
    await seedProjectAndLane(db, projectId, repoRoot);

    insertPrediction({
      db,
      projectId,
      laneAId: "lane-1",
      laneBId: "lane-target",
      laneASha: laneHeadSha,
      overlaps: ["src/missing.ts"]
    });

    const lanes = [
      createLaneSummary(repoRoot, { id: "lane-1", name: "Source lane", branchRef: "feature/lane-1" }),
      createLaneSummary(repoRoot, { id: "lane-target", name: "Target lane", branchRef: "main" })
    ];
    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => lanes,
        create: async () => {
          throw new Error("integration lane should not be created");
        },
        getLaneBaseAndBranch: ({ laneId }: { laneId: string }) => {
          const lane = lanes.find((entry) => entry.id === laneId) ?? lanes[0]!;
          return { worktreePath: lane.worktreePath, baseRef: lane.baseRef, branchRef: lane.branchRef };
        }
      } as any,
      projectConfigService: {
        get: () => ({
          local: {
            providers: {
              contextTools: {
                conflictResolvers: {
                  codex: {
                    command: ["sh", "-lc", "exit 99"]
                  }
                }
              }
            }
          },
          effective: { providerMode: "guest", providers: {} }
        })
      } as any,
    });

    const run = await service.runExternalResolver({
      provider: "codex",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-1"]
    });

    expect(run.status).toBe("blocked");
    expect(run.insufficientContext).toBe(true);
    expect(run.contextGaps.length).toBeGreaterThan(0);
    expect(run.patchPath).toBeNull();
  });

  it("uses proposal pairwise context and reuses the existing integration lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-proposal-session-"));
    seedRepoWithLaneWork(repoRoot);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-proposal-session";
    await seedProjectAndLane(db, projectId, repoRoot);

    const now = "2026-03-11T05:00:00.000Z";
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["lane-integration", projectId, "Integration lane", null, "worktree", "main", "integration/proposal", repoRoot, null, 0, "lane-target", null, null, null, "active", now, null]
    );

    db.run(
      `
        insert into integration_proposals(
          id, project_id, source_lane_ids_json, base_branch, steps_json, pairwise_results_json,
          lane_summaries_json, overall_outcome, created_at, status, integration_lane_id, resolution_state_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "proposal-1",
        projectId,
        JSON.stringify(["lane-1", "lane-2"]),
        "main",
        JSON.stringify([
          { laneId: "lane-1", laneName: "Lane 1", position: 0, outcome: "conflict", conflictingFiles: [], diffStat: { insertions: 1, deletions: 0, filesChanged: 1 } },
          { laneId: "lane-2", laneName: "Lane 2", position: 1, outcome: "conflict", conflictingFiles: [], diffStat: { insertions: 1, deletions: 0, filesChanged: 1 } }
        ]),
        JSON.stringify([
          {
            laneAId: "lane-1",
            laneAName: "Lane 1",
            laneBId: "lane-2",
            laneBName: "Lane 2",
            outcome: "conflict",
            conflictingFiles: [
              {
                path: "src/a.ts",
                conflictMarkers: "<<<<<<< ours",
                oursExcerpt: "export const a = 2;",
                theirsExcerpt: "export const a = 3;",
                diffHunk: "@@"
              }
            ]
          }
        ]),
        JSON.stringify([]),
        "conflict",
        now,
        "proposed",
        "lane-integration",
        JSON.stringify({
          integrationLaneId: "lane-integration",
          stepResolutions: { "lane-1": "resolving", "lane-2": "pending" },
          activeWorkerStepId: "worker-1",
          activeLaneId: "lane-1",
          updatedAt: now
        })
      ]
    );

    const lanes = [
      createLaneSummary(repoRoot, { id: "lane-1", name: "Lane 1", branchRef: "feature/lane-1" }),
      createLaneSummary(repoRoot, { id: "lane-2", name: "Lane 2", branchRef: "feature/lane-2" }),
      createLaneSummary(repoRoot, { id: "lane-target", name: "Target Lane", branchRef: "main" }),
      createLaneSummary(repoRoot, { id: "lane-integration", name: "Integration lane", branchRef: "integration/proposal", parentLaneId: "lane-target" })
    ];

    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => lanes,
        create: async () => {
          throw new Error("should not create a generic integration lane");
        },
        getLaneBaseAndBranch: ({ laneId }: { laneId: string }) => {
          const lane = lanes.find((entry) => entry.id === laneId) ?? lanes[0]!;
          return { worktreePath: lane.worktreePath, baseRef: lane.baseRef, branchRef: lane.branchRef };
        }
      } as any,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "guest" }, local: {} })
      } as any,
    });

    const prepared = await service.prepareResolverSession({
      provider: "claude",
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-1", "lane-2"],
      cwdLaneId: "lane-integration",
      proposalId: "proposal-1",
      scenario: "integration-merge",
      originSurface: "integration"
    });

    expect(prepared.cwdLaneId).toBe("lane-integration");
    expect(prepared.integrationLaneId).toBe("lane-integration");

    const prompt = fs.readFileSync(prepared.promptFilePath, "utf8");
    expect(prompt).toContain("### Pair lane-1 -> lane-2");
    expect(prompt).not.toContain("### Pair lane-1 -> lane-target");
    expect(prompt).toContain("Relationship: peer-vs-peer");
    expect(prompt).toContain("Prior integration steps:");

    const runRecordPath = path.join(path.dirname(prepared.promptFilePath), "run.json");
    const runRecord = JSON.parse(fs.readFileSync(runRecordPath, "utf8"));
    expect(runRecord.integrationLaneId).toBe("lane-integration");
    expect(runRecord.sourceLaneIds).toEqual(["lane-1", "lane-2"]);
    expect(runRecord.resolverContextKey).toBeTruthy();
  });

  it("surfaces and executes queue-aware rebases against the queue target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-queue-rebase-"));
    const repoRoot = path.join(root, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    seedQueueRebaseRepo(repoRoot);
    const db = await openKvDb(path.join(root, "kv.sqlite"), createLogger());
    const projectId = "proj-queue-rebase";
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

    const lane = createLaneSummary(repoRoot, {
      id: "lane-2",
      name: "Lane 2",
      branchRef: "feature/lane-2",
      baseRef: "feature/lane-1",
      parentLaneId: "lane-1"
    });

    const service = createConflictService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: repoRoot,
      laneService: {
        list: async () => [lane],
        getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "feature/lane-1", branchRef: "feature/lane-2" })
      } as any,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "guest" }, local: {} })
      } as any,
    });

    const needs = await service.scanRebaseNeeds();
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({
      laneId: "lane-2",
      baseBranch: "main",
      groupContext: "Queue A",
    });
    expect((needs[0]?.behindBy ?? 0) > 0).toBe(true);

    const rebased = await service.rebaseLane({ laneId: "lane-2" });
    expect(rebased.success).toBe(true);
    expect(git(repoRoot, ["rev-list", "--count", "HEAD..main"])).toBe("0");
  });

  it("prefers the current parent lane branch when baseRef is stale", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-parent-branch-"));
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

      git(repoRoot, ["checkout", "-b", "feature/parent-current"]);
      git(repoRoot, ["checkout", "-b", "feature/child"]);
      fs.writeFileSync(path.join(repoRoot, "file.txt"), "child\n", "utf8");
      git(repoRoot, ["add", "file.txt"]);
      git(repoRoot, ["commit", "-m", "child work"]);

      git(repoRoot, ["checkout", "main"]);
      fs.writeFileSync(path.join(repoRoot, "main.txt"), "main advance\n", "utf8");
      git(repoRoot, ["add", "main.txt"]);
      git(repoRoot, ["commit", "-m", "main advance"]);
      git(repoRoot, ["checkout", "feature/child"]);

      const parentLane = {
        ...createLaneSummary(repoRoot, {
          id: "lane-parent",
          name: "Primary",
          branchRef: "feature/parent-current",
          baseRef: "main",
          parentLaneId: null
        }),
        laneType: "primary" as const,
      };
      const childLane = createLaneSummary(repoRoot, {
        id: "lane-child",
        name: "Child",
        branchRef: "feature/child",
        baseRef: "main",
        parentLaneId: "lane-parent"
      });

      const service = createConflictService({
        db,
        logger: createLogger(),
        projectId,
        projectRoot: repoRoot,
        laneService: {
          list: async () => [parentLane, childLane],
          getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/child" })
        } as any,
        projectConfigService: {
          get: () => ({ effective: { providerMode: "guest" }, local: {} })
        } as any,
      });

      expect(await service.scanRebaseNeeds()).toEqual([]);
      expect(await service.getRebaseNeed("lane-child")).toBeNull();
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses non-primary parent branchRef directly (no origin/ prefix) as rebase target", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-worktree-parent-"));
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

      // Create a worktree-type parent lane
      git(repoRoot, ["checkout", "-b", "feature/worktree-parent"]);
      fs.writeFileSync(path.join(repoRoot, "parent.txt"), "parent work\n", "utf8");
      git(repoRoot, ["add", "parent.txt"]);
      git(repoRoot, ["commit", "-m", "parent work"]);

      // Create a child branch off the parent
      git(repoRoot, ["checkout", "-b", "feature/grandchild"]);
      fs.writeFileSync(path.join(repoRoot, "child.txt"), "grandchild\n", "utf8");
      git(repoRoot, ["add", "child.txt"]);
      git(repoRoot, ["commit", "-m", "grandchild work"]);

      // Advance the parent so the child is behind
      git(repoRoot, ["checkout", "feature/worktree-parent"]);
      fs.writeFileSync(path.join(repoRoot, "parent2.txt"), "parent advance\n", "utf8");
      git(repoRoot, ["add", "parent2.txt"]);
      git(repoRoot, ["commit", "-m", "parent advance"]);
      git(repoRoot, ["checkout", "feature/grandchild"]);

      // Parent is NOT primary — it's a regular worktree lane
      const parentLane = createLaneSummary(repoRoot, {
        id: "lane-wt-parent",
        name: "Worktree Parent",
        branchRef: "feature/worktree-parent",
        baseRef: "main",
        parentLaneId: null
      });
      const childLane = createLaneSummary(repoRoot, {
        id: "lane-grandchild",
        name: "Grandchild",
        branchRef: "feature/grandchild",
        baseRef: "main",
        parentLaneId: "lane-wt-parent"
      });

      const service = createConflictService({
        db,
        logger: createLogger(),
        projectId,
        projectRoot: repoRoot,
        laneService: {
          list: async () => [parentLane, childLane],
          getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/grandchild" })
        } as any,
        projectConfigService: {
          get: () => ({ effective: { providerMode: "guest" }, local: {} })
        } as any,
      });

      // The child should see the parent's new commits via the local branchRef
      // (not origin/feature/worktree-parent, since the parent is not primary)
      const needs = await service.scanRebaseNeeds();
      expect(needs).toHaveLength(1);
      expect(needs[0]).toMatchObject({
        laneId: "lane-grandchild",
        baseBranch: "feature/worktree-parent",
      });
      expect(needs[0]!.behindBy).toBeGreaterThan(0);

      // Also verify getRebaseNeed returns the same result
      const single = await service.getRebaseNeed("lane-grandchild");
      expect(single).toBeTruthy();
      expect(single!.baseBranch).toBe("feature/worktree-parent");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("falls back to lane.baseRef when parent lane has no branchRef", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflicts-no-parent-branch-"));
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

      git(repoRoot, ["checkout", "-b", "feature/orphan-child"]);
      fs.writeFileSync(path.join(repoRoot, "orphan.txt"), "orphan\n", "utf8");
      git(repoRoot, ["add", "orphan.txt"]);
      git(repoRoot, ["commit", "-m", "orphan work"]);

      git(repoRoot, ["checkout", "main"]);
      fs.writeFileSync(path.join(repoRoot, "main2.txt"), "main advance\n", "utf8");
      git(repoRoot, ["add", "main2.txt"]);
      git(repoRoot, ["commit", "-m", "main advance"]);
      git(repoRoot, ["checkout", "feature/orphan-child"]);

      // Parent lane exists but has an empty branchRef — make it primary so it's
      // skipped by scanRebaseNeeds and only the child is evaluated.
      const parentLane = {
        ...createLaneSummary(repoRoot, {
          id: "lane-empty-parent",
          name: "Empty Parent",
          branchRef: "",
          baseRef: "main",
          parentLaneId: null
        }),
        laneType: "primary" as const,
      };
      const childLane = createLaneSummary(repoRoot, {
        id: "lane-orphan",
        name: "Orphan",
        branchRef: "feature/orphan-child",
        baseRef: "main",
        parentLaneId: "lane-empty-parent"
      });

      const service = createConflictService({
        db,
        logger: createLogger(),
        projectId,
        projectRoot: repoRoot,
        laneService: {
          list: async () => [parentLane, childLane],
          getLaneBaseAndBranch: () => ({ worktreePath: repoRoot, baseRef: "main", branchRef: "feature/orphan-child" })
        } as any,
        projectConfigService: {
          get: () => ({ effective: { providerMode: "guest" }, local: {} })
        } as any,
      });

      // Should fall back to baseRef ("main") since parent branchRef is empty
      const needs = await service.scanRebaseNeeds();
      expect(needs).toHaveLength(1);
      expect(needs[0]).toMatchObject({
        laneId: "lane-orphan",
        baseBranch: "main",
      });
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
