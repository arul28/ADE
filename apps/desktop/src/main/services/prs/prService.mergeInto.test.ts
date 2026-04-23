import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted mock state
// ---------------------------------------------------------------------------
const mockGit = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
  runGitMergeTree: vi.fn(),
}));

// ---------------------------------------------------------------------------
// vi.mock — external dependencies
// ---------------------------------------------------------------------------

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
  runGitOrThrow: (...args: unknown[]) => mockGit.runGitOrThrow(...args),
  runGitMergeTree: (...args: unknown[]) => mockGit.runGitMergeTree(...args),
}));

vi.mock("../ai/utils", () => ({
  extractFirstJsonObject: vi.fn(() => null),
}));

vi.mock("./integrationPlanning", () => ({
  buildIntegrationPreflight: vi.fn(),
}));

vi.mock("./integrationValidation", () => ({
  hasMergeConflictMarkers: vi.fn(() => false),
  parseGitStatusPorcelain: vi.fn(() => ({ unmergedPaths: [], modifiedPaths: [] })),
}));

vi.mock("../shared/queueRebase", () => ({
  fetchRemoteTrackingBranch: vi.fn(),
}));

import { buildIntegrationPreflight } from "./integrationPlanning";
import { createPrService } from "./prService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeMockDb() {
  return {
    get: vi.fn(() => null),
    all: vi.fn(() => []),
    run: vi.fn(),
    getJson: vi.fn(() => null),
    setJson: vi.fn(),
    sync: { getSiteId: vi.fn(), getDbVersion: vi.fn(), exportChangesSince: vi.fn(), applyChanges: vi.fn() },
    flushNow: vi.fn(),
    close: vi.fn(),
  } as any;
}

const BASE_LANE_ID = "lane-base";
const SOURCE_LANE_A_ID = "lane-a";
const SOURCE_LANE_B_ID = "lane-b";
const MERGE_INTO_LANE_ID = "lane-merge-into";

function makeFakeLane(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "lane-42",
    name: "my-feature",
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef: "refs/heads/my-feature",
    worktreePath: "/tmp/lane-wt",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const baseLane = makeFakeLane({
  id: BASE_LANE_ID,
  name: "main",
  laneType: "primary",
  branchRef: "refs/heads/main",
  worktreePath: "/tmp/lane-base-wt",
});

const sourceLaneA = makeFakeLane({
  id: SOURCE_LANE_A_ID,
  name: "feature-a",
  branchRef: "refs/heads/feature-a",
  worktreePath: "/tmp/lane-a-wt",
  status: { dirty: false },
});

const sourceLaneB = makeFakeLane({
  id: SOURCE_LANE_B_ID,
  name: "feature-b",
  branchRef: "refs/heads/feature-b",
  worktreePath: "/tmp/lane-b-wt",
  status: { dirty: false },
});

const mergeIntoLane = makeFakeLane({
  id: MERGE_INTO_LANE_ID,
  name: "develop",
  branchRef: "refs/heads/develop",
  worktreePath: "/tmp/lane-merge-into-wt",
  status: { dirty: false },
});

const integrationLane = makeFakeLane({
  id: "lane-integration",
  name: "integration/test",
  branchRef: "refs/heads/integration/test",
  worktreePath: "/tmp/lane-integration-wt",
});

function makeGithubService(overrides?: Record<string, unknown>) {
  return {
    getRepoOrThrow: vi.fn(async () => ({ owner: "test-owner", name: "test-repo" })),
    apiRequest: vi.fn(),
    getStatus: vi.fn(),
    setToken: vi.fn(),
    clearToken: vi.fn(),
    getTokenOrThrow: vi.fn(() => "ghp_mock"),
    ...overrides,
  } as any;
}

function makeLaneService(lanes?: unknown[]) {
  return {
    list: vi.fn(async () => lanes ?? [baseLane, sourceLaneA, sourceLaneB]),
    getLaneBaseAndBranch: vi.fn(),
    createChild: vi.fn(async () => integrationLane),
    archive: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as any;
}

function makeOperationService() {
  return {
    start: vi.fn(() => ({ operationId: "op-1" })),
    finish: vi.fn(),
  } as any;
}

function makeProjectConfigService() {
  return {
    get: vi.fn(() => ({ effective: { ai: {} } })),
  } as any;
}

interface BuildServiceOpts {
  githubService?: any;
  laneService?: any;
  db?: any;
  logger?: any;
}

function buildService(opts: BuildServiceOpts = {}) {
  const db = opts.db ?? makeMockDb();
  const logger = opts.logger ?? makeLogger();
  const githubService = opts.githubService ?? makeGithubService();
  const laneService = opts.laneService ?? makeLaneService();

  mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  mockGit.runGitOrThrow.mockResolvedValue("");
  mockGit.runGitMergeTree.mockResolvedValue({ exitCode: 0, treeOid: null, conflicts: [] });

  const service = createPrService({
    db,
    logger,
    projectId: "proj-1",
    projectRoot: "/tmp/test-project",
    laneService,
    operationService: makeOperationService(),
    githubService,
    projectConfigService: makeProjectConfigService(),
    openExternal: vi.fn(async () => {}),
  });

  return { service, db, githubService, laneService, logger };
}

// ---------------------------------------------------------------------------
// Test Suite 1: updateIntegrationProposal with new fields
// ---------------------------------------------------------------------------

describe("updateIntegrationProposal with new fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists preferredIntegrationLaneId to DB", () => {
    const { service, db } = buildService();

    service.updateIntegrationProposal({
      proposalId: "prop-1",
      preferredIntegrationLaneId: "lane-xyz",
    });

    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("preferred_integration_lane_id = ?");
    expect(params).toContain("lane-xyz");
    expect(params[params.length - 1]).toBe("prop-1");
  });

  it("persists mergeIntoHeadSha to DB", () => {
    const { service, db } = buildService();

    service.updateIntegrationProposal({
      proposalId: "prop-1",
      mergeIntoHeadSha: "abc123sha",
    });

    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("merge_into_head_sha = ?");
    expect(params).toContain("abc123sha");
  });

  it("keeps merge-into previews out of the single-source proposal cleanup query", async () => {
    const { service, db } = buildService();

    await service.listIntegrationProposals();

    const [sql] = db.run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("preferred_integration_lane_id");
    expect(sql).toContain("merge_into_head_sha");
  });

  it("trims whitespace from preferredIntegrationLaneId", () => {
    const { service, db } = buildService();

    service.updateIntegrationProposal({
      proposalId: "prop-1",
      preferredIntegrationLaneId: "  lane-xyz  ",
    });

    const [, params] = db.run.mock.calls[0] as [string, unknown[]];
    expect(params).toContain("lane-xyz");
  });

  it("sets preferredIntegrationLaneId to null when given empty string", () => {
    const { service, db } = buildService();

    service.updateIntegrationProposal({
      proposalId: "prop-1",
      preferredIntegrationLaneId: "",
    });

    const [sql, params] = db.run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("preferred_integration_lane_id = ?");
    expect(params[0]).toBeNull();
  });

  it("clearIntegrationBinding sets integration_lane_id and resolution_state_json to null", () => {
    const { service, db } = buildService();

    service.updateIntegrationProposal({
      proposalId: "prop-1",
      clearIntegrationBinding: true,
    });

    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("integration_lane_id = ?");
    expect(sql).toContain("resolution_state_json = ?");
    // Both values should be null
    const nullCount = params.filter((p: unknown) => p === null).length;
    expect(nullCount).toBe(2);
  });

  it("does nothing when no fields are set", () => {
    const { service, db } = buildService();

    service.updateIntegrationProposal({
      proposalId: "prop-1",
    });

    expect(db.run).not.toHaveBeenCalled();
  });

  it("combines multiple new fields in a single update", () => {
    const { service, db } = buildService();

    service.updateIntegrationProposal({
      proposalId: "prop-1",
      preferredIntegrationLaneId: "lane-xyz",
      mergeIntoHeadSha: "sha-456",
      clearIntegrationBinding: true,
    });

    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("preferred_integration_lane_id = ?");
    expect(sql).toContain("merge_into_head_sha = ?");
    expect(sql).toContain("integration_lane_id = ?");
    expect(sql).toContain("resolution_state_json = ?");
    // proposalId is the last param
    expect(params[params.length - 1]).toBe("prop-1");
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: createIntegrationPr with existingIntegrationLaneId
// ---------------------------------------------------------------------------

describe("createIntegrationPr with existingIntegrationLaneId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupPreflight() {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
  }

  it("reuses existing lane instead of calling createChild", async () => {
    setupPreflight();
    const allLanes = [baseLane, sourceLaneA, sourceLaneB, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });

    // Make merges succeed, GitHub API succeed, etc.
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          html_url: "https://github.com/test-owner/test-repo/pull/42",
          node_id: "PR_node42",
          title: "Integration PR",
          state: "open",
          draft: false,
          merged_at: null,
          head: { ref: "develop", sha: "abc123" },
          base: { ref: "main" },
          additions: 5,
          deletions: 1,
        },
        response: { status: 201, headers: new Headers() },
      }),
    });
    const db = makeMockDb();
    let getCallCount = 0;
    db.get.mockImplementation(() => {
      getCallCount++;
      if (getCallCount <= 1) return null;
      return {
        id: "fake-uuid",
        lane_id: MERGE_INTO_LANE_ID,
        project_id: "proj-1",
        repo_owner: "test-owner",
        repo_name: "test-repo",
        github_pr_number: 42,
        github_url: "https://github.com/test-owner/test-repo/pull/42",
        github_node_id: "PR_node42",
        title: "Integration PR",
        state: "open",
        base_branch: "main",
        head_branch: "develop",
        checks_status: "none",
        review_status: "none",
        additions: 5,
        deletions: 1,
        last_synced_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
    });

    const { service: svc2 } = buildService({
      laneService,
      githubService: ghService,
      db,
    });

    await svc2.createIntegrationPr({
      sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      title: "Integration PR",
      existingIntegrationLaneId: MERGE_INTO_LANE_ID,
      allowDirtyWorktree: true,
    });

    // createChild should NOT have been called
    expect(laneService.createChild).not.toHaveBeenCalled();
  });

  it("throws when existingIntegrationLaneId matches a source lane", async () => {
    setupPreflight();
    const laneService = makeLaneService([baseLane, sourceLaneA, sourceLaneB]);
    const { service } = buildService({ laneService });

    await expect(
      service.createIntegrationPr({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        title: "Integration PR",
        existingIntegrationLaneId: SOURCE_LANE_A_ID,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("Integration lane cannot be one of the source lanes.");
  });

  it("throws when existingIntegrationLaneId is not found among lanes", async () => {
    setupPreflight();
    const laneService = makeLaneService([baseLane, sourceLaneA, sourceLaneB]);
    const { service } = buildService({ laneService });

    await expect(
      service.createIntegrationPr({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        title: "Integration PR",
        existingIntegrationLaneId: "nonexistent-lane",
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("Integration lane not found: nonexistent-lane");
  });

  it("throws when existingIntegrationLaneId points at the primary lane", async () => {
    setupPreflight();
    const laneService = makeLaneService([baseLane, sourceLaneA, sourceLaneB]);
    const { service } = buildService({ laneService });

    await expect(
      service.createIntegrationPr({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        title: "Integration PR",
        existingIntegrationLaneId: BASE_LANE_ID,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("Integration lane cannot be the primary lane.");
  });

  it("does NOT archive integration lane on cleanup when it was adopted (not newly created)", async () => {
    setupPreflight();
    const allLanes = [baseLane, sourceLaneA, sourceLaneB, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });

    // Force merge to throw so we enter the catch block
    mockGit.runGit.mockRejectedValue(new Error("git merge crashed"));

    await expect(
      service.createIntegrationPr({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        title: "Integration PR",
        existingIntegrationLaneId: MERGE_INTO_LANE_ID,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("git merge crashed");

    // archive should NOT be called since we adopted an existing lane
    expect(laneService.archive).not.toHaveBeenCalled();
  });

  it("DOES archive integration lane on cleanup when it was newly created", async () => {
    setupPreflight();
    const laneService = makeLaneService([baseLane, sourceLaneA, sourceLaneB]);
    const { service } = buildService({ laneService });

    // Force merge to throw
    mockGit.runGit.mockRejectedValue(new Error("git merge crashed"));

    await expect(
      service.createIntegrationPr({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        title: "Integration PR",
        // no existingIntegrationLaneId — will create a new lane
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("git merge crashed");

    // archive SHOULD be called since a new lane was created
    expect(laneService.archive).toHaveBeenCalledWith({ laneId: "lane-integration" });
  });

  it("includes existingIntegrationLaneId in dirty worktree checks", async () => {
    setupPreflight();
    const dirtyMergeIntoLane = {
      ...mergeIntoLane,
      status: { dirty: true },
    };
    const allLanes = [baseLane, sourceLaneA, sourceLaneB, dirtyMergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });

    await expect(
      service.createIntegrationPr({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        title: "Integration PR",
        existingIntegrationLaneId: MERGE_INTO_LANE_ID,
        // allowDirtyWorktree intentionally omitted
      }),
    ).rejects.toThrow(/Uncommitted changes/);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: simulateIntegration with mergeIntoLaneId
// ---------------------------------------------------------------------------

describe("simulateIntegration with mergeIntoLaneId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupSimulationPreflight(sourceLaneIds: string[] = [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID]) {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: sourceLaneIds,
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
  }

  function setupGitShaResolution() {
    // rev-parse calls: baseSha, mergeIntoHeadSha, per-lane HEAD SHAs, rev-list, diff --shortstat
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        if (args[1] === "main") return "base-sha-000\n";
        if (args[1] === "develop") return "merge-into-sha-111\n";
        if (args[1] === "feature-a") return "head-sha-aaa\n";
        if (args[1] === "feature-b") return "head-sha-bbb\n";
        if (args[1] === "HEAD") return "head-sha-999\n";
        return "unknown-sha\n";
      }
      if (args[0] === "rev-list") return "1\n";
      if (args[0] === "diff" && args[1] === "--shortstat") return " 1 file changed, 1 insertion(+)\n";
      // worktree add/remove
      if (args[0] === "worktree") return "";
      return "";
    });
  }

  it("throws when mergeIntoLaneId matches a source lane", async () => {
    setupSimulationPreflight();
    const allLanes = [baseLane, sourceLaneA, sourceLaneB, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });
    setupGitShaResolution();

    await expect(
      service.simulateIntegration({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        baseBranch: "main",
        mergeIntoLaneId: SOURCE_LANE_A_ID,
      }),
    ).rejects.toThrow("Merge-into lane cannot be one of the source lanes.");
  });

  it("throws when mergeIntoLaneId is not found among lanes", async () => {
    setupSimulationPreflight();
    const allLanes = [baseLane, sourceLaneA, sourceLaneB];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });
    setupGitShaResolution();

    await expect(
      service.simulateIntegration({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
        baseBranch: "main",
        mergeIntoLaneId: "nonexistent-lane",
      }),
    ).rejects.toThrow("Merge-into lane not found: nonexistent-lane");
  });

  it("throws when mergeIntoLaneId points at the primary lane", async () => {
    setupSimulationPreflight();
    const allLanes = [baseLane, sourceLaneA, sourceLaneB];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });
    setupGitShaResolution();

    await expect(
      service.simulateIntegration({
        sourceLaneIds: [SOURCE_LANE_A_ID],
        baseBranch: "main",
        mergeIntoLaneId: BASE_LANE_ID,
      }),
    ).rejects.toThrow("Merge-into lane cannot be the primary lane.");
  });

  it("merge-into conflicts factor into lane outcomes", async () => {
    setupSimulationPreflight([SOURCE_LANE_A_ID]);
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    const { service } = buildService({ laneService, db });
    setupGitShaResolution();

    // Pairwise merge-tree (base vs source lanes): clean
    let mergeTreeCallCount = 0;
    mockGit.runGitMergeTree.mockImplementation(async (args: any) => {
      mergeTreeCallCount++;
      // The merge-into check (mergeIntoHeadSha vs source lane head) conflicts
      if (args.branchA === "merge-into-sha-111") {
        return {
          exitCode: 1,
          treeOid: "tree-oid-conflict",
          conflicts: [{ path: "conflicting-file.ts" }],
        };
      }
      // All other pairwise checks are clean
      return { exitCode: 0, treeOid: null, conflicts: [] };
    });

    // git diff for conflict detail extraction
    mockGit.runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff") {
        return { exitCode: 0, stdout: "diff content", stderr: "" };
      }
      // Sequential merge
      if (args[0] === "merge") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // show for conflict markers
      if (args[0] === "show") {
        return { exitCode: 0, stdout: "file content", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const proposal = await service.simulateIntegration({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      baseBranch: "main",
      mergeIntoLaneId: MERGE_INTO_LANE_ID,
      persist: false,
    });

    // The source lane A should have "conflict" outcome due to merge-into conflict
    const laneASummary = proposal.laneSummaries.find((s) => s.laneId === SOURCE_LANE_A_ID);
    expect(laneASummary).toBeDefined();
    expect(laneASummary!.outcome).toBe("conflict");
  });

  it("sequentialStartSha uses merge-into HEAD when provided", async () => {
    setupSimulationPreflight([SOURCE_LANE_A_ID]);
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });
    setupGitShaResolution();

    // Track the worktree add call to verify sequentialStartSha
    const worktreeAddCalls: string[][] = [];
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAddCalls.push(args);
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "main") return "base-sha-000\n";
        if (args[1] === "develop") return "merge-into-sha-111\n";
        if (args[1] === "feature-a") return "head-sha-aaa\n";
        return "unknown-sha\n";
      }
      if (args[0] === "rev-list") return "1\n";
      if (args[0] === "diff" && args[1] === "--shortstat") return " 1 file changed, 1 insertion(+)\n";
      return "";
    });
    mockGit.runGitMergeTree.mockResolvedValue({ exitCode: 0, treeOid: null, conflicts: [] });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await service.simulateIntegration({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      baseBranch: "main",
      mergeIntoLaneId: MERGE_INTO_LANE_ID,
      persist: false,
    });

    // The worktree add should use merge-into HEAD sha, not base sha
    const addCall = worktreeAddCalls.find((args) => args[1] === "add" && args[2] === "--detach");
    expect(addCall).toBeDefined();
    // The last arg in "worktree add --detach <path> <sha>" is the sha
    expect(addCall![addCall!.length - 1]).toBe("merge-into-sha-111");
  });

  it("persists preferred_integration_lane_id and merge_into_head_sha in DB insert", async () => {
    setupSimulationPreflight([SOURCE_LANE_A_ID]);
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    const { service } = buildService({ laneService, db });
    setupGitShaResolution();
    mockGit.runGitMergeTree.mockResolvedValue({ exitCode: 0, treeOid: null, conflicts: [] });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await service.simulateIntegration({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      baseBranch: "main",
      mergeIntoLaneId: MERGE_INTO_LANE_ID,
      persist: true,
    });

    // Find the insert into integration_proposals
    const insertCall = db.run.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into integration_proposals"),
    );
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall as [string, unknown[]];
    expect(sql).toContain("preferred_integration_lane_id");
    expect(sql).toContain("merge_into_head_sha");
    // The mergeIntoLaneId should be in the params
    expect(params).toContain(MERGE_INTO_LANE_ID);
    // The merge-into HEAD sha should be in the params
    expect(params).toContain("merge-into-sha-111");
  });

  it("returns preferredIntegrationLaneId and mergeIntoHeadSha in proposal object", async () => {
    setupSimulationPreflight([SOURCE_LANE_A_ID]);
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });
    setupGitShaResolution();
    mockGit.runGitMergeTree.mockResolvedValue({ exitCode: 0, treeOid: null, conflicts: [] });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const proposal = await service.simulateIntegration({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      baseBranch: "main",
      mergeIntoLaneId: MERGE_INTO_LANE_ID,
      persist: false,
    });

    expect(proposal.preferredIntegrationLaneId).toBe(MERGE_INTO_LANE_ID);
    expect(proposal.mergeIntoHeadSha).toBe("merge-into-sha-111");
  });

  it("sets preferredIntegrationLaneId and mergeIntoHeadSha to null when mergeIntoLaneId is not provided", async () => {
    setupSimulationPreflight([SOURCE_LANE_A_ID]);
    const allLanes = [baseLane, sourceLaneA];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });
    setupGitShaResolution();
    mockGit.runGitMergeTree.mockResolvedValue({ exitCode: 0, treeOid: null, conflicts: [] });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const proposal = await service.simulateIntegration({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      baseBranch: "main",
      persist: false,
    });

    expect(proposal.preferredIntegrationLaneId).toBeNull();
    expect(proposal.mergeIntoHeadSha).toBeNull();
  });

  it("clean outcome when merge-into has no conflicts", async () => {
    setupSimulationPreflight([SOURCE_LANE_A_ID]);
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const { service } = buildService({ laneService });
    setupGitShaResolution();

    // All merge-tree checks are clean
    mockGit.runGitMergeTree.mockResolvedValue({ exitCode: 0, treeOid: null, conflicts: [] });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const proposal = await service.simulateIntegration({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      baseBranch: "main",
      mergeIntoLaneId: MERGE_INTO_LANE_ID,
      persist: false,
    });

    const laneASummary = proposal.laneSummaries.find((s) => s.laneId === SOURCE_LANE_A_ID);
    expect(laneASummary).toBeDefined();
    expect(laneASummary!.outcome).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// Test Suite 4: createIntegrationLaneForProposal with preferred lane adoption
// ---------------------------------------------------------------------------

describe("createIntegrationLaneForProposal with preferred lane adoption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupProposalPreflight() {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
  }

  function makeProposalRow(overrides?: Record<string, unknown>) {
    return {
      id: "prop-1",
      source_lane_ids_json: JSON.stringify([SOURCE_LANE_A_ID]),
      base_branch: "main",
      steps_json: JSON.stringify([
        { laneId: SOURCE_LANE_A_ID, outcome: "clean", conflictingFiles: [], diffStat: { insertions: 0, deletions: 0, filesChanged: 0 } },
      ]),
      overall_outcome: "clean",
      integration_lane_name: "integration/test",
      integration_lane_id: null,
      preferred_integration_lane_id: null,
      merge_into_head_sha: null,
      resolution_state_json: null,
      created_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("adopts preferred lane instead of creating a new child lane", async () => {
    setupProposalPreflight();
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
      merge_into_head_sha: "stored-sha-111",
    }));

    const logger = makeLogger();
    const { service } = buildService({ laneService, db, logger });

    // rev-parse HEAD for drift check
    mockGit.runGitOrThrow.mockResolvedValue("stored-sha-111\n");
    // Merges succeed
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const result = await service.createIntegrationLaneForProposal({
      proposalId: "prop-1",
      allowDirtyWorktree: true,
    });

    expect(result.integrationLaneId).toBe(MERGE_INTO_LANE_ID);
    expect(laneService.createChild).not.toHaveBeenCalled();
  });

  it("warns about HEAD drift when stored sha differs from current", async () => {
    setupProposalPreflight();
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
      merge_into_head_sha: "stored-sha-111",
    }));

    const logger = makeLogger();
    const { service } = buildService({ laneService, db, logger });

    // Current HEAD differs from stored
    mockGit.runGitOrThrow.mockResolvedValue("different-sha-222\n");
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await service.createIntegrationLaneForProposal({
      proposalId: "prop-1",
      allowDirtyWorktree: true,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "prs.integration_merge_into_head_drift",
      expect.objectContaining({
        proposalId: "prop-1",
        preferredIntegrationLaneId: MERGE_INTO_LANE_ID,
        storedHead: "stored-sha-111",
        currentHead: "different-sha-222",
      }),
    );
  });

  it("does not warn when stored sha matches current HEAD", async () => {
    setupProposalPreflight();
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
      merge_into_head_sha: "same-sha-111",
    }));

    const logger = makeLogger();
    const { service } = buildService({ laneService, db, logger });

    mockGit.runGitOrThrow.mockResolvedValue("same-sha-111\n");
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await service.createIntegrationLaneForProposal({
      proposalId: "prop-1",
      allowDirtyWorktree: true,
    });

    expect(logger.warn).not.toHaveBeenCalledWith(
      "prs.integration_merge_into_head_drift",
      expect.anything(),
    );
  });

  it("warns gracefully when HEAD read fails for preferred lane", async () => {
    setupProposalPreflight();
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
      merge_into_head_sha: "stored-sha-111",
    }));

    const logger = makeLogger();
    const { service } = buildService({ laneService, db, logger });

    // rev-parse HEAD fails
    mockGit.runGitOrThrow.mockRejectedValue(new Error("fatal: not a git repository"));
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await service.createIntegrationLaneForProposal({
      proposalId: "prop-1",
      allowDirtyWorktree: true,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "prs.integration_merge_into_head_read_failed",
      expect.objectContaining({
        proposalId: "prop-1",
        preferredIntegrationLaneId: MERGE_INTO_LANE_ID,
        error: "fatal: not a git repository",
      }),
    );
  });

  it("throws when preferred lane is not found", async () => {
    setupProposalPreflight();
    const allLanes = [baseLane, sourceLaneA]; // mergeIntoLane NOT in allLanes
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
    }));

    const { service } = buildService({ laneService, db });

    await expect(
      service.createIntegrationLaneForProposal({
        proposalId: "prop-1",
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow(`Preferred integration lane not found: ${MERGE_INTO_LANE_ID}`);
  });

  it("throws when preferred lane is one of the source lanes", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID, MERGE_INTO_LANE_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
    const allLanes = [baseLane, sourceLaneA, mergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      source_lane_ids_json: JSON.stringify([SOURCE_LANE_A_ID, MERGE_INTO_LANE_ID]),
      steps_json: JSON.stringify([
        { laneId: SOURCE_LANE_A_ID, outcome: "clean", conflictingFiles: [], diffStat: { insertions: 0, deletions: 0, filesChanged: 0 } },
        { laneId: MERGE_INTO_LANE_ID, outcome: "clean", conflictingFiles: [], diffStat: { insertions: 0, deletions: 0, filesChanged: 0 } },
      ]),
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
    }));

    const { service } = buildService({ laneService, db });

    await expect(
      service.createIntegrationLaneForProposal({
        proposalId: "prop-1",
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("Preferred integration lane cannot be one of the source lanes.");
  });

  it("throws when preferred lane points at the primary lane", async () => {
    setupProposalPreflight();
    const allLanes = [baseLane, sourceLaneA];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: BASE_LANE_ID,
    }));

    const { service } = buildService({ laneService, db });

    await expect(
      service.createIntegrationLaneForProposal({
        proposalId: "prop-1",
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("Preferred integration lane cannot be the primary lane.");
  });

  it("creates child lane when no preferred lane is set", async () => {
    setupProposalPreflight();
    const allLanes = [baseLane, sourceLaneA];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: null,
    }));

    const { service } = buildService({ laneService, db });

    mockGit.runGitOrThrow.mockResolvedValue("");
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const result = await service.createIntegrationLaneForProposal({
      proposalId: "prop-1",
      allowDirtyWorktree: true,
    });

    // createChild SHOULD be called since no preferred lane
    expect(laneService.createChild).toHaveBeenCalledWith(
      expect.objectContaining({
        parentLaneId: BASE_LANE_ID,
        name: "integration/test",
      }),
    );
    expect(result.integrationLaneId).toBe("lane-integration");
  });

  it("includes preferred lane in dirty worktree checks", async () => {
    setupProposalPreflight();
    const dirtyMergeIntoLane = {
      ...mergeIntoLane,
      status: { dirty: true },
    };
    const allLanes = [baseLane, sourceLaneA, dirtyMergeIntoLane];
    const laneService = makeLaneService(allLanes);
    const db = makeMockDb();
    db.get.mockReturnValue(makeProposalRow({
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
    }));

    const { service } = buildService({ laneService, db });

    await expect(
      service.createIntegrationLaneForProposal({
        proposalId: "prop-1",
        // allowDirtyWorktree intentionally omitted
      }),
    ).rejects.toThrow(/Uncommitted changes/);
  });
});

describe("commitIntegration dirty-worktree retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates allowDirtyWorktree when preparing a new integration lane", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const dirtySourceLane = {
      ...sourceLaneA,
      status: { dirty: true },
    };
    const laneService = makeLaneService([baseLane, dirtySourceLane]);
    laneService.list.mockResolvedValue([baseLane, dirtySourceLane, integrationLane]);
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (sql.includes("from integration_proposals")) {
        return {
          id: "prop-dirty",
          source_lane_ids_json: JSON.stringify([SOURCE_LANE_A_ID]),
          base_branch: "main",
          steps_json: JSON.stringify([
            { laneId: SOURCE_LANE_A_ID, laneName: dirtySourceLane.name, position: 0, outcome: "clean", conflictingFiles: [], diffStat: { insertions: 0, deletions: 0, filesChanged: 0 } },
          ]),
          integration_lane_id: null,
          integration_lane_name: "integration/test",
          preferred_integration_lane_id: null,
          overall_outcome: "clean",
          merge_into_head_sha: null,
          resolution_state_json: null,
          created_at: "2026-01-01T00:00:00Z",
        };
      }
      if (sql.includes("from pull_requests where id")) {
        return {
          id: "pr-integration",
          lane_id: integrationLane.id,
          repo_owner: "test-owner",
          repo_name: "test-repo",
          github_pr_number: 42,
          github_url: "https://github.com/test-owner/test-repo/pull/42",
          github_node_id: "PR_node42",
          title: "Integration PR",
          state: "open",
          base_branch: "main",
          head_branch: "integration/test",
          checks_status: "none",
          review_status: "none",
          additions: 5,
          deletions: 1,
          last_synced_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        };
      }
      if (sql.includes("from pull_requests where lane_id")) {
        return null;
      }
      return null;
    });

    const githubService = makeGithubService({
      apiRequest: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          html_url: "https://github.com/test-owner/test-repo/pull/42",
          node_id: "PR_node42",
          title: "Integration PR",
          state: "open",
          draft: false,
          merged_at: null,
          additions: 5,
          deletions: 1,
        },
        response: { status: 201, headers: new Headers() },
      }),
    });

    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const { service } = buildService({ laneService, db, githubService });

    await expect(
      service.commitIntegration({
        proposalId: "prop-dirty",
        integrationLaneName: "integration/test",
        title: "Integration PR",
        body: "",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).resolves.toMatchObject({
      integrationLaneId: "lane-integration",
      pr: expect.objectContaining({
        laneId: "lane-integration",
        githubPrNumber: 42,
      }),
    });

    expect(laneService.createChild).toHaveBeenCalledOnce();
  });
});

describe("adopted integration lane cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not delete an adopted merge-into lane when deleting a proposal", async () => {
    const laneService = makeLaneService([baseLane, sourceLaneA, mergeIntoLane]);
    const db = makeMockDb();
    db.get.mockReturnValue({
      id: "prop-adopted",
      integration_lane_id: MERGE_INTO_LANE_ID,
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
    });

    const { service } = buildService({ laneService, db });

    await expect(
      service.deleteIntegrationProposal({
        proposalId: "prop-adopted",
        deleteIntegrationLane: true,
      }),
    ).resolves.toMatchObject({
      proposalId: "prop-adopted",
      integrationLaneId: MERGE_INTO_LANE_ID,
      deletedIntegrationLane: false,
    });

    expect(laneService.delete).not.toHaveBeenCalled();
  });

  it("skips archiving an adopted merge-into lane during workflow cleanup", async () => {
    const laneService = makeLaneService([baseLane, sourceLaneA, mergeIntoLane]);
    const db = makeMockDb();
    db.get.mockReturnValue({
      id: "prop-adopted",
      project_id: "proj-1",
      source_lane_ids_json: JSON.stringify([SOURCE_LANE_A_ID]),
      base_branch: "main",
      steps_json: JSON.stringify([]),
      overall_outcome: "clean",
      created_at: "2026-01-01T00:00:00Z",
      title: "",
      body: "",
      draft: 0,
      integration_lane_name: mergeIntoLane.name,
      status: "committed",
      integration_lane_id: MERGE_INTO_LANE_ID,
      preferred_integration_lane_id: MERGE_INTO_LANE_ID,
      resolution_state_json: null,
      pairwise_results_json: "[]",
      lane_summaries_json: "[]",
      linked_group_id: null,
      linked_pr_id: null,
      workflow_display_state: "active",
      cleanup_state: "required",
      closed_at: null,
      merged_at: null,
      completed_at: null,
      cleanup_declined_at: null,
      cleanup_completed_at: null,
      merge_into_head_sha: "sha-merge-into",
    });

    const { service } = buildService({ laneService, db });

    await expect(
      service.cleanupIntegrationWorkflow({
        proposalId: "prop-adopted",
      }),
    ).resolves.toMatchObject({
      proposalId: "prop-adopted",
      archivedLaneIds: [],
      skippedLaneIds: [MERGE_INTO_LANE_ID],
      workflowDisplayState: "history",
      cleanupState: "completed",
    });

    expect(laneService.archive).not.toHaveBeenCalled();
  });
});
