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
  parseGitStatusPorcelain: vi.fn(() => []),
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

const LANE_ID = "lane-42";
const REPO = { owner: "test-owner", name: "test-repo" };

function makeFakeLane(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: LANE_ID,
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

function makeGithubService(overrides?: Record<string, unknown>) {
  return {
    getRepoOrThrow: vi.fn(async () => REPO),
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
    list: vi.fn(async () => lanes ?? [makeFakeLane()]),
    getLaneBaseAndBranch: vi.fn(),
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
}

function buildService(opts: BuildServiceOpts = {}) {
  const db = opts.db ?? makeMockDb();
  const githubService = opts.githubService ?? makeGithubService();
  const laneService = opts.laneService ?? makeLaneService();

  // Make runGit succeed for upstream check (returns exitCode 0 → push path)
  mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "origin/my-feature", stderr: "" });
  // Make push succeed
  mockGit.runGitOrThrow.mockResolvedValue(undefined);

  const service = createPrService({
    db,
    logger: makeLogger(),
    projectId: "proj-1",
    projectRoot: "/tmp/test-project",
    laneService,
    operationService: makeOperationService(),
    githubService,
    projectConfigService: makeProjectConfigService(),
    openExternal: vi.fn(async () => {}),
  });

  return { service, db, githubService, laneService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prService.createFromLane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps githubService.apiRequest errors with branch context", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("Validation Failed: A pull request already exists")),
    });

    const { service } = buildService({ githubService: ghService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "description",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow(
      'Failed to create pull request for "my-feature" \u2192 "main": Validation Failed: A pull request already exists',
    );
  });

  it("preserves non-Error throwables in the wrapped message", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue("string error"),
    });

    const { service } = buildService({ githubService: ghService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow(
      'Failed to create pull request for "my-feature" \u2192 "main": string error',
    );
  });

  it("extracts PR number from successful creation response", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockResolvedValue({
        data: {
          number: 99,
          html_url: "https://github.com/test-owner/test-repo/pull/99",
          node_id: "PR_node1",
          title: "My PR",
          state: "open",
          draft: false,
          merged_at: null,
          head: { ref: "my-feature" },
          base: { ref: "main" },
          additions: 10,
          deletions: 2,
        },
        response: { status: 201 },
      }),
    });

    const db = makeMockDb();
    // refreshOne calls getRow → fetchPr → apiRequest(GET) → so we need
    // db.get to return the inserted row, and apiRequest for the refresh GET
    // We'll make db.get return a valid row on the second call (after upsertRow
    // inserts via db.run). On the first call (inside upsertRow's getRowForLane),
    // return null so it does an INSERT.
    let getCallCount = 0;
    db.get.mockImplementation(() => {
      getCallCount++;
      if (getCallCount === 1) {
        // getRowForLane inside upsertRow — no existing row
        return null;
      }
      // requireRow inside refreshOne — return the row
      return {
        id: "fake-uuid",
        lane_id: LANE_ID,
        project_id: "proj-1",
        repo_owner: "test-owner",
        repo_name: "test-repo",
        github_pr_number: 99,
        github_url: "https://github.com/test-owner/test-repo/pull/99",
        github_node_id: "PR_node1",
        title: "My PR",
        state: "open",
        base_branch: "main",
        head_branch: "my-feature",
        checks_status: "none",
        review_status: "none",
        additions: 10,
        deletions: 2,
        last_synced_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
    });

    // After the initial POST for creation, refreshOne calls fetchPr (GET)
    // and then several more GET calls for checks, reviews, comments, files, etc.
    // We need apiRequest to handle both the initial POST and subsequent GETs.
    let apiCallCount = 0;
    ghService.apiRequest.mockImplementation(async (args: any) => {
      apiCallCount++;
      if (apiCallCount === 1) {
        // The POST to create the PR
        return {
          data: {
            number: 99,
            html_url: "https://github.com/test-owner/test-repo/pull/99",
            node_id: "PR_node1",
            title: "My PR",
            state: "open",
            draft: false,
            merged_at: null,
            head: { ref: "my-feature" },
            base: { ref: "main" },
            additions: 10,
            deletions: 2,
          },
          response: { status: 201, headers: new Headers() },
        };
      }
      // All subsequent GETs (fetchPr, checks, reviews, comments, files, actions)
      return {
        data: args.path.endsWith("/pulls/99")
          ? {
              number: 99,
              html_url: "https://github.com/test-owner/test-repo/pull/99",
              title: "My PR",
              state: "open",
              draft: false,
              merged_at: null,
              head: { ref: "my-feature", sha: "abc123" },
              base: { ref: "main" },
              additions: 10,
              deletions: 2,
            }
          : [],
        response: {
          status: 200,
          headers: new Headers(),
        },
      };
    });

    const { service } = buildService({ githubService: ghService, db });

    const result = await service.createFromLane({
      laneId: LANE_ID,
      title: "My PR",
      body: "description",
      draft: false,
      allowDirtyWorktree: true,
    });

    expect(result.githubPrNumber).toBe(99);
    expect(result.headBranch).toBe("my-feature");
    expect(result.baseBranch).toBe("main");
  });

  it("uses the lane baseRef when legacy primary parent metadata disagrees with the current primary branch", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("stop after payload capture")),
    });
    const laneService = makeLaneService([
      makeFakeLane({
        parentLaneId: "lane-primary",
        baseRef: "refs/heads/main",
      }),
      makeFakeLane({
        id: "lane-primary",
        name: "Primary",
        laneType: "primary",
        baseRef: "refs/heads/release/2026",
        branchRef: "refs/heads/release/2026",
        parentLaneId: null,
      }),
    ]);

    const { service } = buildService({ githubService: ghService, laneService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "description",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow('Failed to create pull request for "my-feature" → "main": stop after payload capture');

    expect(ghService.apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          head: "my-feature",
          base: "main",
        }),
      }),
    );
  });

  it("throws when GitHub returns an invalid PR number", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockResolvedValue({
        data: { number: null },
        response: { status: 201 },
      }),
    });

    const db = makeMockDb();

    const { service } = buildService({ githubService: ghService, db });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("GitHub returned an invalid PR number");
  });

  it("throws when lane is not found", async () => {
    const laneService = makeLaneService([]); // empty list
    const { service } = buildService({ laneService });

    await expect(
      service.createFromLane({
        laneId: "nonexistent",
        title: "PR",
        body: "",
        draft: false,
      }),
    ).rejects.toThrow("Lane not found: nonexistent");
  });
});

// ---------------------------------------------------------------------------
// createIntegrationLane
// ---------------------------------------------------------------------------

describe("prService.createIntegrationLane", () => {
  const BASE_LANE_ID = "lane-base";
  const SOURCE_LANE_A_ID = "lane-a";
  const SOURCE_LANE_B_ID = "lane-b";

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

  const integrationLane = makeFakeLane({
    id: "lane-integration",
    name: "integration/test",
    branchRef: "refs/heads/integration/test",
    worktreePath: "/tmp/lane-integration-wt",
  });

  function makeIntegrationLaneService(lanes?: unknown[]) {
    return {
      list: vi.fn(async () => lanes ?? [baseLane, sourceLaneA, sourceLaneB]),
      getLaneBaseAndBranch: vi.fn(),
      createChild: vi.fn(async () => integrationLane),
      archive: vi.fn(async () => {}),
    } as any;
  }

  function buildIntegrationService(opts: { laneService?: any; db?: any } = {}) {
    const db = opts.db ?? makeMockDb();
    const laneService = opts.laneService ?? makeIntegrationLaneService();

    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mockGit.runGitOrThrow.mockResolvedValue(undefined);

    const service = createPrService({
      db,
      logger: makeLogger(),
      projectId: "proj-1",
      projectRoot: "/tmp/test-project",
      laneService,
      operationService: makeOperationService(),
      githubService: makeGithubService(),
      projectConfigService: makeProjectConfigService(),
      openExternal: vi.fn(async () => {}),
    });

    return { service, db, laneService };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when sourceLaneIds is empty", async () => {
    const { service } = buildIntegrationService();

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [],
        integrationLaneName: "integration/test",
        baseBranch: "main",
      }),
    ).rejects.toThrow("At least one source lane is required");
  });

  it("throws when integrationLaneName is empty or whitespace", async () => {
    const { service } = buildIntegrationService();

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID],
        integrationLaneName: "   ",
        baseBranch: "main",
      }),
    ).rejects.toThrow("Integration lane name is required");
  });

  it("throws when preflight reports no valid source lanes", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const { service } = buildIntegrationService();

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
      }),
    ).rejects.toThrow("At least one valid source lane is required");
  });

  it("throws when preflight reports duplicate source lanes", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [SOURCE_LANE_A_ID],
      missingSourceLaneIds: [],
    });

    const { service } = buildIntegrationService();

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_A_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
      }),
    ).rejects.toThrow("Duplicate source lanes selected");
  });

  it("throws when preflight reports missing source lanes", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID, "missing-lane"],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: ["missing-lane"],
    });

    const { service } = buildIntegrationService();

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID, "missing-lane"],
        integrationLaneName: "integration/test",
        baseBranch: "main",
      }),
    ).rejects.toThrow("Source lanes not found: missing-lane");
  });

  it("throws when base lane cannot be resolved", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: null,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const { service } = buildIntegrationService();

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID],
        integrationLaneName: "integration/test",
        baseBranch: "nonexistent-base",
      }),
    ).rejects.toThrow('Could not map base branch "nonexistent-base" to an active lane');
  });

  it("creates integration lane and merges all source branches successfully", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    const result = await service.createIntegrationLane({
      sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      allowDirtyWorktree: true,
    });

    // Lane was created as child of base lane
    expect(laneService.createChild).toHaveBeenCalledWith(
      expect.objectContaining({
        parentLaneId: BASE_LANE_ID,
        name: "integration/test",
        laneRole: "integration",
      }),
    );

    // Both merges succeeded
    expect(result.integrationLane.id).toBe("lane-integration");
    expect(result.mergeResults).toHaveLength(2);
    expect(result.mergeResults[0]).toEqual({ laneId: SOURCE_LANE_A_ID, success: true });
    expect(result.mergeResults[1]).toEqual({ laneId: SOURCE_LANE_B_ID, success: true });

    // Git merge was called for each source lane
    const mergeCalls = mockGit.runGit.mock.calls.filter(
      (call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[])[0] === "merge",
    );
    expect(mergeCalls.length).toBe(2);
  });

  it("records merge failure and aborts when a source branch fails to merge", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    // Set mockImplementation AFTER buildIntegrationService (which sets mockResolvedValue)
    let mergeCallCount = 0;
    mockGit.runGit.mockImplementation(async (gitArgs: string[]) => {
      if (gitArgs[0] === "merge" && gitArgs[1] === "--no-ff") {
        mergeCallCount++;
        if (mergeCallCount === 1) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // Second merge fails
        return { exitCode: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict" };
      }
      // merge --abort
      if (gitArgs[0] === "merge" && gitArgs[1] === "--abort") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await service.createIntegrationLane({
      sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      allowDirtyWorktree: true,
    });

    expect(result.mergeResults[0]).toEqual({ laneId: SOURCE_LANE_A_ID, success: true });
    expect(result.mergeResults[1]).toEqual({
      laneId: SOURCE_LANE_B_ID,
      success: false,
      error: "CONFLICT (content): Merge conflict",
    });

    // merge --abort was called after the failure
    const abortCalls = mockGit.runGit.mock.calls.filter(
      (call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[])[0] === "merge" && (call[0] as string[])[1] === "--abort",
    );
    expect(abortCalls.length).toBe(1);
  });

  it("uses 'Merge failed' when stderr is empty on merge failure", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    // Set mockImplementation AFTER buildIntegrationService
    mockGit.runGit.mockImplementation(async (gitArgs: string[]) => {
      if (gitArgs[0] === "merge" && gitArgs[1] === "--no-ff") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await service.createIntegrationLane({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      allowDirtyWorktree: true,
    });

    expect(result.mergeResults[0]).toEqual({
      laneId: SOURCE_LANE_A_ID,
      success: false,
      error: "Merge failed",
    });
  });

  it("uses custom description when provided", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    await service.createIntegrationLane({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      description: "Custom description for testing",
      allowDirtyWorktree: true,
    });

    expect(laneService.createChild).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Custom description for testing",
      }),
    );
  });

  it("generates default description from source lane names when no description given", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    await service.createIntegrationLane({
      sourceLaneIds: [SOURCE_LANE_A_ID, SOURCE_LANE_B_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      allowDirtyWorktree: true,
    });

    expect(laneService.createChild).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Integration lane for merging: feature-a, feature-b",
      }),
    );
  });

  it("archives integration lane on error during merge loop", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    // Set mock AFTER buildIntegrationService — createChild succeeds, but merge throws
    mockGit.runGit.mockRejectedValue(new Error("unexpected git failure"));

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("unexpected git failure");

    // Should have attempted to archive the integration lane
    expect(laneService.archive).toHaveBeenCalledWith({ laneId: "lane-integration" });
  });

  it("still throws the original error if archive cleanup also fails", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const laneService = makeIntegrationLaneService();
    laneService.archive.mockRejectedValue(new Error("archive failed too"));
    const { service } = buildIntegrationService({ laneService });

    // Set mock AFTER buildIntegrationService
    mockGit.runGit.mockRejectedValue(new Error("git merge crashed"));

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("git merge crashed");
  });

  it("passes custom laneRole through to createChild", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    await service.createIntegrationLane({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      laneRole: "result",
      allowDirtyWorktree: true,
    });

    expect(laneService.createChild).toHaveBeenCalledWith(
      expect.objectContaining({ laneRole: "result" }),
    );
  });

  it("defaults laneRole to 'integration' when not specified", async () => {
    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const laneService = makeIntegrationLaneService();
    const { service } = buildIntegrationService({ laneService });

    await service.createIntegrationLane({
      sourceLaneIds: [SOURCE_LANE_A_ID],
      integrationLaneName: "integration/test",
      baseBranch: "main",
      allowDirtyWorktree: true,
    });

    expect(laneService.createChild).toHaveBeenCalledWith(
      expect.objectContaining({ laneRole: "integration" }),
    );
  });

  it("throws when dirty worktrees are detected without allowDirtyWorktree", async () => {
    const dirtyLaneA = {
      ...sourceLaneA,
      status: { dirty: true },
    };

    vi.mocked(buildIntegrationPreflight).mockReturnValue({
      baseLane: baseLane as any,
      uniqueSourceLaneIds: [SOURCE_LANE_A_ID],
      duplicateSourceLaneIds: [],
      missingSourceLaneIds: [],
    });

    const laneService = makeIntegrationLaneService([baseLane, dirtyLaneA, sourceLaneB]);
    const { service } = buildIntegrationService({ laneService });

    await expect(
      service.createIntegrationLane({
        sourceLaneIds: [SOURCE_LANE_A_ID],
        integrationLaneName: "integration/test",
        baseBranch: "main",
        // allowDirtyWorktree intentionally omitted
      }),
    ).rejects.toThrow(/Uncommitted changes/);
  });
});
