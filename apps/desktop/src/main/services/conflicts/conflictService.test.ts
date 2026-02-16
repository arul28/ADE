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
  it("passes relevant file contexts into hosted conflict proposal jobs", async () => {
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
        get: () => ({ effective: { providerMode: "hosted" } })
      } as any,
      packService: {
        refreshLanePack: async () => {},
        refreshConflictPack: async () => {},
        getLaneExport: async () => ({ content: "lane export" }),
        getConflictExport: async () => ({
          content:
            '## Conflict Lineage\n```json\n{"pairwisePairsComputed":2,"pairwisePairsTotal":5,"stalePolicy":{"ttlMs":120000}}\n```'
        })
      } as any,
      hostedAgentService: {
        getStatus: () => ({ enabled: true }),
        requestConflictProposal: async (args: any) => {
          capturedRequest = args;
          return {
            jobId: "job-1",
            artifactId: "artifact-1",
            explanation: "hosted explanation",
            diffPatch: "diff --git a/src/a.ts b/src/a.ts\n",
            confidence: 0.8,
            rawContent: "raw"
          };
        }
      } as any
    });

    const preview = await service.prepareProposal({ laneId: "lane-1" });
    const proposal = await service.requestProposal({ laneId: "lane-1", contextDigest: preview.contextDigest });

    expect(proposal.diffPatch).toContain("diff --git");
    expect(capturedRequest).toBeTruthy();
    expect(Array.isArray(capturedRequest.conflictContext.relevantFilesForConflict)).toBe(true);
    expect(capturedRequest.conflictContext.relevantFilesForConflict.length).toBeGreaterThan(0);
    expect(Array.isArray(capturedRequest.conflictContext.fileContexts)).toBe(true);
    expect(capturedRequest.conflictContext.fileContexts.length).toBeGreaterThan(0);
    expect(capturedRequest.conflictContext.pairwisePairsComputed).toBe(2);
    expect(capturedRequest.conflictContext.pairwisePairsTotal).toBe(5);
    expect(capturedRequest.conflictContext.stalePolicy.ttlMs).toBe(120000);
    expect(typeof capturedRequest.conflictContext.predictionAgeMs).toBe("number");
  });

  it("returns insufficient-context proposal without calling hosted provider", async () => {
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
    let hostedCalled = false;
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
        get: () => ({ effective: { providerMode: "hosted" } })
      } as any,
      packService: {
        refreshLanePack: async () => {},
        refreshConflictPack: async () => {},
        getLaneExport: async () => ({ content: "lane export" }),
        getConflictExport: async () => ({
          content:
            '## Conflict Lineage\n```json\n{"pairwisePairsComputed":1,"pairwisePairsTotal":1,"stalePolicy":{"ttlMs":60000}}\n```'
        })
      } as any,
      hostedAgentService: {
        getStatus: () => ({ enabled: true }),
        requestConflictProposal: async () => {
          hostedCalled = true;
          throw new Error("should not be called");
        }
      } as any
    });

    const preview = await service.prepareProposal({ laneId: "lane-1" });
    const proposal = await service.requestProposal({ laneId: "lane-1", contextDigest: preview.contextDigest });

    expect(hostedCalled).toBe(false);
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
    fs.mkdirSync(path.join(packsRoot, "lanes", "lane-1"), { recursive: true });
    fs.mkdirSync(path.join(packsRoot, "lanes", "lane-target"), { recursive: true });
    fs.mkdirSync(path.join(packsRoot, "conflicts", "v2"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "docs", "architecture"), { recursive: true });
    fs.writeFileSync(path.join(packsRoot, "project_pack.md"), "# Project Pack\n", "utf8");
    fs.writeFileSync(path.join(packsRoot, "lanes", "lane-1", "lane_pack.md"), "# Lane 1 Pack\n", "utf8");
    fs.writeFileSync(path.join(packsRoot, "lanes", "lane-target", "lane_pack.md"), "# Lane Target Pack\n", "utf8");
    fs.writeFileSync(path.join(packsRoot, "conflicts", "v2", "lane-1__lane-target.md"), "# Conflict Pack\n", "utf8");
    fs.writeFileSync(path.join(repoRoot, "docs", "PRD.ade.md"), "# PRD\n", "utf8");
    fs.writeFileSync(path.join(repoRoot, "docs", "architecture", "ARCHITECTURE.ade.md"), "# Architecture\n", "utf8");

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
      packService: {
        refreshLanePack: async () => {},
        refreshConflictPack: async () => {},
        getLaneExport: async () => ({ content: "lane export" }),
        getConflictExport: async () => ({
          content:
            '## Conflict Lineage\n```json\n{"pairwisePairsComputed":1,"pairwisePairsTotal":1,"stalePolicy":{"ttlMs":120000}}\n```'
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
    expect(prompt).toContain("## ADE Pack References");
    expect(prompt).toContain(path.join(packsRoot, "project_pack.md"));
    expect(prompt).toContain(path.join(packsRoot, "lanes", "lane-1", "lane_pack.md"));
    expect(prompt).toContain(path.join(packsRoot, "lanes", "lane-target", "lane_pack.md"));
    expect(prompt).toContain(path.join(packsRoot, "conflicts", "v2", "lane-1__lane-target.md"));
    expect(prompt).toContain("Do not run: git add, git commit, git push");
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
      packService: {
        refreshLanePack: async () => {},
        refreshConflictPack: async () => {},
        getLaneExport: async () => ({ content: "lane export" }),
        getConflictExport: async () => ({
          content:
            '## Conflict Lineage\n```json\n{"pairwisePairsComputed":1,"pairwisePairsTotal":1,"stalePolicy":{"ttlMs":120000}}\n```'
        })
      } as any
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
      packService: {
        refreshLanePack: async () => {},
        refreshConflictPack: async () => {},
        getLaneExport: async () => ({ content: "lane export" }),
        getConflictExport: async () => ({
          content:
            '## Conflict Lineage\n```json\n{"pairwisePairsComputed":2,"pairwisePairsTotal":2,"stalePolicy":{"ttlMs":120000}}\n```'
        })
      } as any
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
      packService: {
        refreshLanePack: async () => {},
        refreshConflictPack: async () => {},
        getLaneExport: async () => ({ content: "lane export" }),
        getConflictExport: async () => ({
          content:
            '## Conflict Lineage\n```json\n{"pairwisePairsComputed":1,"pairwisePairsTotal":1,"stalePolicy":{"ttlMs":120000}}\n```'
        })
      } as any
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
});
