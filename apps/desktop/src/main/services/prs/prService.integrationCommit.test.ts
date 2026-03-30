import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";

const runGitMock = vi.fn();
const runGitOrThrowMock = vi.fn();
const runGitMergeTreeMock = vi.fn();

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => runGitMock(...args),
  runGitOrThrow: (...args: unknown[]) => runGitOrThrowMock(...args),
  runGitMergeTree: (...args: unknown[]) => runGitMergeTreeMock(...args),
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
    createdAt: "2026-03-12T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

async function seedProject(db: any, projectId: string, repoRoot: string) {
  const now = "2026-03-12T00:00:00.000Z";
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

describe("prService.commitIntegration", () => {
  beforeEach(() => {
    runGitMock.mockReset();
    runGitOrThrowMock.mockReset();
    runGitMergeTreeMock.mockReset();
  });

  it("preserves the integration lane on sequential merge conflicts so the proposal can be resolved", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-integration-commit-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-integration-commit";

    const baseLane = makeLane("lane-main", "main", "refs/heads/main", root, {
      laneType: "primary",
    });
    const cleanLane = makeLane("lane-clean", "clean-lane", "refs/heads/feature/clean", path.join(root, "clean"));
    const conflictLane = makeLane("lane-conflict", "computer-use", "refs/heads/feature/computer-use", path.join(root, "conflict"));

    await seedProject(db, projectId, root);
    await seedLane(db, projectId, baseLane);
    await seedLane(db, projectId, cleanLane);
    await seedLane(db, projectId, conflictLane);

    const proposalId = "12345678-abcd-4abc-8def-1234567890ab";
    db.run(
      `insert into integration_proposals(
        id, project_id, source_lane_ids_json, base_branch, steps_json, pairwise_results_json, lane_summaries_json, overall_outcome, created_at, status
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proposalId,
        projectId,
        JSON.stringify([cleanLane.id, conflictLane.id]),
        "main",
        JSON.stringify([
          { laneId: cleanLane.id, laneName: cleanLane.name, position: 0, outcome: "clean", conflictingFiles: [], diffStat: { insertions: 0, deletions: 0, filesChanged: 0 } },
          { laneId: conflictLane.id, laneName: conflictLane.name, position: 1, outcome: "clean", conflictingFiles: [], diffStat: { insertions: 0, deletions: 0, filesChanged: 0 } },
        ]),
        JSON.stringify([]),
        JSON.stringify([]),
        "clean",
        "2026-03-12T00:00:00.000Z",
        "proposed",
      ],
    );

    const laneState: LaneSummary[] = [baseLane, cleanLane, conflictLane];
    const archiveSpy = vi.fn();
    const createChildSpy = vi.fn(async ({ name, parentLaneId }: { name: string; parentLaneId: string }) => {
      const integrationLane = makeLane(
        "lane-int",
        name,
        `refs/heads/${name}`,
        path.join(root, "integration-lane"),
        { parentLaneId },
      );
      laneState.push(integrationLane);
      return integrationLane;
    });

    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "merge" && args[1] === "--abort") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge") {
        const branch = args[args.length - 1];
        if (branch === "feature/clean") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (branch === "feature/computer-use") {
          return { exitCode: 1, stdout: "", stderr: "merge conflict" };
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const { createPrService } = await createServiceModule();
    const service = createPrService({
      db,
      logger: createLogger() as any,
      projectId,
      projectRoot: root,
      laneService: {
        list: async () => laneState,
        createChild: createChildSpy,
        archive: archiveSpy,
      } as any,
      operationService: {} as any,
      githubService: {
        getRepoOrThrow: vi.fn(),
        apiRequest: vi.fn(),
      } as any,
      aiIntegrationService: undefined,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "guest" } }),
      } as any,
      conflictService: undefined,
      openExternal: async () => {},
    });

    await expect(
      service.commitIntegration({
        proposalId,
        integrationLaneName: "integration/12345678",
        title: "Integration PR",
        body: "",
        draft: false,
      }),
    ).rejects.toThrow("Integration merge blocked. Resolve conflicts for: computer-use.");

    expect(createChildSpy).toHaveBeenCalledOnce();
    expect(archiveSpy).not.toHaveBeenCalled();

    const proposals = await service.listIntegrationProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposalId,
      integrationLaneId: "lane-int",
      integrationLaneName: "integration/12345678",
    });
    expect(proposals[0]?.resolutionState?.stepResolutions).toMatchObject({
      "lane-clean": "merged-clean",
      "lane-conflict": "pending",
    });
  });

  it("marks sequential merge conflicts during simulation even when pairwise merge-tree reports clean", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-integration-sim-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-integration-sim";

    const baseLane = makeLane("lane-main", "main", "refs/heads/main", root, {
      laneType: "primary",
    });
    const firstLane = makeLane("lane-a", "fixing linear flow", "refs/heads/feature/linear", path.join(root, "linear"));
    const secondLane = makeLane("lane-b", "computer-use", "refs/heads/feature/computer-use", path.join(root, "computer"));

    await seedProject(db, projectId, root);
    await seedLane(db, projectId, baseLane);
    await seedLane(db, projectId, firstLane);
    await seedLane(db, projectId, secondLane);

    const tempRoots: string[] = [];
    const originalMkdtemp = fs.mkdtempSync;
    const originalReadFile = fs.readFileSync;
    vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix, options) => {
      const dir = originalMkdtemp(prefix as string, options as BufferEncoding | undefined);
      tempRoots.push(dir);
      return dir;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, encoding?: any) => {
      if (typeof filePath === "string" && filePath.endsWith(path.join("src", "conflicted.ts"))) {
        return "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n";
      }
      return originalReadFile(filePath as any, encoding);
    }) as typeof fs.readFileSync);

    runGitOrThrowMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "main") return "base-sha";
      if (args[0] === "rev-parse" && args[1] === "feature/linear") return "linear-sha";
      if (args[0] === "rev-parse" && args[1] === "feature/computer-use") return "computer-sha";
      return "";
    });

    runGitMergeTreeMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      mergeBase: "base-sha",
      branchA: "linear-sha",
      branchB: "computer-sha",
      conflicts: [],
      treeOid: null,
      usedMergeBaseFlag: true,
      usedWriteTree: true,
    });

    runGitMock.mockImplementation(async (args: string[], options?: { cwd?: string }) => {
      if (args[0] === "rev-list" || args[0] === "diff") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--short") {
        if (args[2] === "linear-sha") return { exitCode: 0, stdout: "linear12", stderr: "" };
        if (args[2] === "computer-sha") return { exitCode: 0, stdout: "computer", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge" && args[1] === "--abort") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge") {
        const branch = args[args.length - 1];
        if (branch === "feature/linear") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (branch === "feature/computer-use") {
          return { exitCode: 1, stdout: "", stderr: "merge conflict" };
        }
      }
      if (args[0] === "status" && options?.cwd?.includes(`${path.sep}worktree`)) {
        return { exitCode: 0, stdout: "UU src/conflicted.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const { createPrService } = await createServiceModule();
    const service = createPrService({
      db,
      logger: createLogger() as any,
      projectId,
      projectRoot: root,
      laneService: {
        list: async () => [baseLane, firstLane, secondLane],
      } as any,
      operationService: {} as any,
      githubService: {
        getRepoOrThrow: vi.fn(),
        apiRequest: vi.fn(),
      } as any,
      aiIntegrationService: undefined,
      projectConfigService: {
        get: () => ({ effective: { providerMode: "guest" } }),
      } as any,
      conflictService: undefined,
      openExternal: async () => {},
    });

    const proposal = await service.simulateIntegration({
      sourceLaneIds: [firstLane.id, secondLane.id],
      baseBranch: "main",
    });

    expect(proposal.overallOutcome).toBe("conflict");
    expect(proposal.pairwiseResults).toHaveLength(1);
    expect(proposal.pairwiseResults[0]?.outcome).toBe("clean");
    expect(proposal.steps.find((step) => step.laneId === secondLane.id)).toMatchObject({
      outcome: "conflict",
    });
    expect(proposal.steps.find((step) => step.laneId === secondLane.id)?.conflictingFiles[0]?.path).toBe("src/conflicted.ts");
    expect(runGitMergeTreeMock).toHaveBeenCalledOnce();
  });

  it("does not read conflict previews through symlinked worktree escapes during simulation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-integration-symlink-preview-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-integration-symlink-outside-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    const projectId = "proj-integration-symlink-preview";

    try {
      const baseLane = makeLane("lane-main", "main", "refs/heads/main", root, {
        laneType: "primary",
      });
      const conflictLane = makeLane("lane-conflict", "computer-use", "refs/heads/feature/computer-use", path.join(root, "conflict"));

      await seedProject(db, projectId, root);
      await seedLane(db, projectId, baseLane);
      await seedLane(db, projectId, conflictLane);

      runGitOrThrowMock.mockImplementation(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "main") return "base-sha";
        if (args[0] === "rev-parse" && args[1] === "feature/computer-use") return "computer-sha";
        return "";
      });

      runGitMergeTreeMock.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
        mergeBase: "base-sha",
        branchA: "base-sha",
        branchB: "computer-sha",
        conflicts: [],
        treeOid: null,
        usedMergeBaseFlag: true,
        usedWriteTree: true,
      });

      runGitMock.mockImplementation(async (args: string[], options?: { cwd?: string }) => {
        if (args[0] === "rev-list" || args[0] === "diff") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--short" && args[2] === "computer-sha") {
          return { exitCode: 0, stdout: "computer", stderr: "" };
        }
        if (args[0] === "merge" && args[1] === "--abort") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "worktree" && args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "merge") {
          fs.writeFileSync(path.join(outsideDir, "secret.ts"), "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n", "utf8");
          fs.mkdirSync(options!.cwd!, { recursive: true });
          fs.symlinkSync(outsideDir, path.join(options!.cwd!, "linked"));
          return { exitCode: 1, stdout: "", stderr: "merge conflict" };
        }
        if (args[0] === "status" && options?.cwd?.includes(`${path.sep}worktree`)) {
          return { exitCode: 0, stdout: "UU linked/secret.ts\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const { createPrService } = await createServiceModule();
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: {
          list: async () => [baseLane, conflictLane],
        } as any,
        operationService: {} as any,
        githubService: {
          getRepoOrThrow: vi.fn(),
          apiRequest: vi.fn(),
        } as any,
        aiIntegrationService: undefined,
        projectConfigService: {
          get: () => ({ effective: { providerMode: "guest" } }),
        } as any,
        conflictService: undefined,
        openExternal: async () => {},
      });

      const proposal = await service.simulateIntegration({
        sourceLaneIds: [conflictLane.id],
        baseBranch: "main",
      });

      expect(proposal.steps[0]?.conflictingFiles[0]).toMatchObject({
        path: "linked/secret.ts",
        conflictType: null,
        conflictMarkers: "",
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("ignores symlinked conflict marker files that escape the integration lane during recheck", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-integration-symlink-recheck-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-integration-recheck-outside-"));
    let db: Awaited<ReturnType<typeof openKvDb>> | null = null;
    try {
      db = await openKvDb(path.join(root, ".ade.db"), createLogger());
      const projectId = "proj-integration-symlink-recheck";
      const now = "2026-03-12T00:00:00.000Z";

      const baseLane = makeLane("lane-main", "main", "refs/heads/main", root, {
        laneType: "primary",
      });
      const sourceLane = makeLane("lane-source", "source", "refs/heads/feature/source", path.join(root, "source"));
      const integrationLane = makeLane("lane-int", "integration", "refs/heads/integration/test", path.join(root, "integration"));

      fs.mkdirSync(integrationLane.worktreePath, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "secret.ts"), "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n", "utf8");
      fs.symlinkSync(outsideDir, path.join(integrationLane.worktreePath, "linked"));

      await seedProject(db, projectId, root);
      await seedLane(db, projectId, baseLane);
      await seedLane(db, projectId, sourceLane);
      await seedLane(db, projectId, integrationLane);

      const proposalId = "proposal-symlink-recheck";
      db.run(
        `insert into integration_proposals(
          id, project_id, source_lane_ids_json, base_branch, steps_json, pairwise_results_json, lane_summaries_json, overall_outcome, created_at, status, integration_lane_id, resolution_state_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          proposalId,
          projectId,
          JSON.stringify([sourceLane.id]),
          "main",
          JSON.stringify([
            { laneId: sourceLane.id, laneName: sourceLane.name, position: 0, outcome: "conflict", conflictingFiles: [{ path: "linked/secret.ts" }], diffStat: { insertions: 0, deletions: 0, filesChanged: 1 } },
          ]),
          JSON.stringify([]),
          JSON.stringify([]),
          "conflict",
          now,
          "committed",
          integrationLane.id,
          JSON.stringify({
            integrationLaneId: integrationLane.id,
            stepResolutions: { [sourceLane.id]: "pending" },
            activeWorkerStepId: null,
            activeLaneId: null,
            updatedAt: now,
          }),
        ],
      );

      runGitMock.mockImplementation(async (args: string[]) => {
        if (args[0] === "status") {
          return { exitCode: 0, stdout: " M linked/secret.ts\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const { createPrService } = await createServiceModule();
      const service = createPrService({
        db,
        logger: createLogger() as any,
        projectId,
        projectRoot: root,
        laneService: {
          list: async () => [baseLane, sourceLane, integrationLane],
        } as any,
        operationService: {} as any,
        githubService: {
          getRepoOrThrow: vi.fn(),
          apiRequest: vi.fn(),
        } as any,
        aiIntegrationService: undefined,
        projectConfigService: {
          get: () => ({ effective: { providerMode: "guest" } }),
        } as any,
        conflictService: undefined,
        openExternal: async () => {},
      });

      const result = await service.recheckIntegrationStep({ proposalId, laneId: sourceLane.id });

      expect(result).toMatchObject({
        resolution: "resolved",
        remainingConflictFiles: [],
        allResolved: true,
        message: null,
      });
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
