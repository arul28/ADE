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
