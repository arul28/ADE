import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted mock state
// ---------------------------------------------------------------------------
const mockGit = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
  runGitMergeTree: vi.fn(),
}));

const mockChildProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// vi.mock — external dependencies
// ---------------------------------------------------------------------------

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
  runGitOrThrow: (...args: unknown[]) => mockGit.runGitOrThrow(...args),
  runGitMergeTree: (...args: unknown[]) => mockGit.runGitMergeTree(...args),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockChildProcess.spawn(...args),
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

vi.mock("../shared/remoteTrackingBranch", () => ({
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
    sync: { getSiteId: vi.fn(), getDbVersion: vi.fn(), exportChangesSince: vi.fn(), applyChanges: vi.fn(), discardUnpublishedChangesForTables: vi.fn() },
    flushNow: vi.fn(),
    close: vi.fn(),
  } as any;
}

const LANE_ID = "lane-42";
const REPO = { owner: "test-owner", name: "test-repo" };
const GITHUB_SNAPSHOT_TTL_MS_FOR_TEST = 120_000;

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
    archivedAt: null,
    ...overrides,
  };
}

function makePrRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "pr-row-1",
    lane_id: LANE_ID,
    project_id: "proj-1",
    repo_owner: REPO.owner,
    repo_name: REPO.name,
    github_pr_number: 90,
    github_url: "https://github.com/test-owner/test-repo/pull/90",
    github_node_id: "PR_node90",
    title: "Linked PR",
    state: "open",
    base_branch: "main",
    head_branch: "my-feature",
    checks_status: "none",
    review_status: "none",
    additions: 1,
    deletions: 1,
    merge_conflicts: null,
    behind_base_by: null,
    last_synced_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    merged_at: null,
    creation_strategy: "pr_target",
    ...overrides,
  };
}

function makeGithubProjectionRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    project_id: "proj-1",
    repo_owner: REPO.owner,
    repo_name: REPO.name,
    github_pr_number: 404,
    github_node_id: "PR_node404",
    github_url: "https://github.com/test-owner/test-repo/pull/404",
    title: "External PR",
    state: "open",
    is_draft: 0,
    base_branch: "main",
    head_branch: "my-feature",
    head_repo_owner: REPO.owner,
    head_repo_name: REPO.name,
    head_sha: "head-sha-404",
    base_sha: "base-sha-404",
    author: "octocat",
    labels_json: "[]",
    is_bot: 0,
    comment_count: 0,
    created_at: "2026-01-03T00:00:00Z",
    updated_at: "2026-01-04T00:00:00Z",
    synced_at: "2026-01-04T00:01:00Z",
    last_event_name: "snapshot",
    last_delivery_id: null,
    ...overrides,
  };
}

function makeGitHubPull(overrides?: Partial<Record<string, unknown>>) {
  return {
    node_id: "PR_node_1",
    number: 1,
    html_url: "https://github.com/test-owner/test-repo/pull/1",
    title: "Cached PR",
    state: "open",
    draft: false,
    base: {
      ref: "main",
      repo: {
        owner: { login: REPO.owner },
        name: REPO.name,
      },
    },
    head: { ref: "feature/cached" },
    user: { login: "octocat", type: "User" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    labels: [],
    comments: 0,
    ...overrides,
  };
}

function makeUnmappedBranchPull(overrides?: Partial<Record<string, unknown>>) {
  return makeGitHubPull({
    node_id: "PR_node_unmapped",
    number: 404,
    html_url: "https://github.com/test-owner/test-repo/pull/404",
    title: "Unmapped branch PR",
    base: {
      ref: "main",
      repo: {
        owner: { login: REPO.owner },
        name: REPO.name,
      },
    },
    head: {
      ref: "feature/unmapped",
      sha: "head-sha-unmapped",
      user: { login: REPO.owner },
      repo: {
        owner: { login: REPO.owner },
        name: REPO.name,
      },
    },
    ...overrides,
  });
}

function makeGithubService(overrides?: Record<string, unknown>) {
  const getTokenOrThrow = (overrides?.getTokenOrThrow as (() => string) | undefined)
    ?? vi.fn(() => "ghp_mock");
  const apiRequestOverride = overrides?.apiRequest as
    | ((args: { path: string; [key: string]: unknown }) => unknown)
    | undefined;
  const stackApiRequestOverride = overrides?.stackApiRequest as
    | ((args: { path: string; [key: string]: unknown }) => unknown)
    | undefined;
  const {
    apiRequest: _apiRequest,
    stackApiRequest: _stackApiRequest,
    ...remainingOverrides
  } = overrides ?? {};
  return {
    getRepoOrThrow: vi.fn(async () => REPO),
    apiRequest: vi.fn(async (args: { path: string; [key: string]: unknown }) => {
      if (
        args.method === "GET"
        && args.path === `/repos/${REPO.owner}/${REPO.name}/stacks`
      ) {
        if (stackApiRequestOverride) return await stackApiRequestOverride(args);
        return { data: [], linkHeader: null };
      }
      return await apiRequestOverride?.(args);
    }),
    parseNextLink: vi.fn(() => null),
    createSecretGist: vi.fn(),
    getStatus: vi.fn(),
    setToken: vi.fn(),
    clearToken: vi.fn(),
    getTokenOrThrow,
    getTokenOrThrowAsync: vi.fn(async () => getTokenOrThrow()),
    ...remainingOverrides,
  } as any;
}

function makeGithubStatus(overrides?: Record<string, unknown>) {
  return {
    tokenStored: true,
    patTokenStored: true,
    tokenDecryptionFailed: false,
    storageScope: "app",
    authSource: "pat",
    tokenType: "classic",
    connected: true,
    repo: REPO,
    hasOrigin: true,
    userLogin: "octocat",
    scopes: ["repo", "workflow"],
    ghCliPath: null,
    ghAuthError: null,
    checkedAt: "2026-05-10T00:00:00.000Z",
    repoAccessOk: null,
    repoAccessError: null,
    ...overrides,
  };
}

function makeLaneService(lanes?: unknown[]) {
  return {
    list: vi.fn(async () => lanes ?? [makeFakeLane()]),
    getLaneBaseAndBranch: vi.fn(),
    delete: vi.fn(async () => undefined),
  } as any;
}

function makeOperationService() {
  return {
    start: vi.fn(() => ({ operationId: "op-1" })),
    finish: vi.fn(),
  } as any;
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
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
  conflictService?: any;
  projectConfigService?: any;
  aiIntegrationService?: any;
  onHotRefreshChanged?: () => void;
}

function buildService(opts: BuildServiceOpts = {}) {
  const db = opts.db ?? makeMockDb();
  const githubService = opts.githubService ?? makeGithubService();
  const laneService = opts.laneService ?? makeLaneService();
  const logger = makeLogger();

  mockGit.runGit.mockImplementation(async (args: unknown[]) => {
    const command = Array.isArray(args) ? args[0] : null;
    if (command === "rev-list") {
      return { exitCode: 0, stdout: "0\t1\n", stderr: "" };
    }
    if (command === "fetch" || command === "push") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "ls-remote") {
      const branch = String(args[3] ?? "feature/unmapped");
      return { exitCode: 0, stdout: `head-sha-unmapped\trefs/heads/${branch}\n`, stderr: "" };
    }
    if (command === "rev-parse" && args[1] === "--verify" && String(args[2] ?? "").startsWith("refs/heads/")) {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (command === "rev-parse" && args[1] === "HEAD") {
      return { exitCode: 0, stdout: "head-sha-unmapped\n", stderr: "" };
    }
    // Make runGit succeed for upstream check (returns exitCode 0 → push path)
    return { exitCode: 0, stdout: "origin/my-feature", stderr: "" };
  });
  // Make push succeed
  mockGit.runGitOrThrow.mockResolvedValue(undefined);

  const service = createPrService({
    db,
    logger,
    projectId: "proj-1",
    projectRoot: "/tmp/test-project",
    laneService,
    operationService: makeOperationService(),
    githubService,
    conflictService: opts.conflictService,
    projectConfigService: opts.projectConfigService ?? makeProjectConfigService(),
    ...(opts.aiIntegrationService ? { aiIntegrationService: opts.aiIntegrationService } : {}),
    onHotRefreshChanged: opts.onHotRefreshChanged,
    openExternal: vi.fn(async () => {}),
  });

  return { service, db, githubService, laneService, logger };
}

function serviceWithPrBranchActions(service: ReturnType<typeof buildService>["service"]) {
  return service as typeof service & {
    preflightCreateLaneFromPrBranch: (args: { prUrlOrNumber: string; laneName?: string }) => Promise<any>;
    createLaneFromPrBranch: (args: { prUrlOrNumber: string; laneName?: string }) => Promise<any>;
  };
}

function preflightDisposition(preflight: any): string {
  if (typeof preflight?.status === "string") return preflight.status;
  if (typeof preflight?.state === "string") return preflight.state;
  if (typeof preflight?.ok === "boolean") return preflight.ok ? "ready" : "blocked";
  if (typeof preflight?.blocked === "boolean") return preflight.blocked ? "blocked" : "ready";
  return "";
}

function preflightConflicts(preflight: any): unknown[] {
  if (Array.isArray(preflight?.blockingConflicts)) return preflight.blockingConflicts;
  if (Array.isArray(preflight?.conflicts)) return preflight.conflicts;
  if (Array.isArray(preflight?.blockers)) return preflight.blockers;
  if (preflight?.blockingConflict) return [preflight.blockingConflict];
  return [];
}

function installPullRequestRowStore(db: ReturnType<typeof makeMockDb>, initialRows: any[] = []) {
  const rows = [...initialRows];

  // Lane-scoped and ownership lookups carry `detached_at is null`; identity lookups
  // (by row id) deliberately do not. Honouring that here keeps the store faithful to
  // the real queries — without it a detached row looks live to every lookup and the
  // detach behaviour cannot be exercised.
  const liveOnly = (text: string) => text.includes("detached_at is null");
  const matchesLiveness = (row: any, text: string) => !liveOnly(text) || !row.detached_at;

  db.get.mockImplementation((sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (!text.includes("from pull_requests")) return null;
    if (text.includes("where id = ?")) {
      return rows.find((row) => row.id === params[0] && row.project_id === params[1]) ?? null;
    }
    if (text.includes("lower(repo_owner)") && text.includes("github_pr_number")) {
      const [projectIdParam, owner, name, prNumber] = params;
      return rows.find((row) =>
        row.project_id === projectIdParam
        && String(row.repo_owner).toLowerCase() === String(owner).toLowerCase()
        && String(row.repo_name).toLowerCase() === String(name).toLowerCase()
        && Number(row.github_pr_number) === Number(prNumber)
        && matchesLiveness(row, text)
      ) ?? null;
    }
    if (text.includes("where lane_id = ?")) {
      return rows.find((row) =>
        row.lane_id === params[0] && row.project_id === params[1] && matchesLiveness(row, text)
      ) ?? null;
    }
    return null;
  });

  db.all.mockImplementation((sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (!text.includes("from pull_requests")) return [];
    if (text.includes("where lane_id = ?")) {
      return rows.filter((row) =>
        row.lane_id === params[0] && row.project_id === params[1] && matchesLiveness(row, text)
      );
    }
    if (text.includes("where project_id = ?")) {
      return rows.filter((row) => row.project_id === params[0] && matchesLiveness(row, text));
    }
    return rows;
  });

  db.run.mockImplementation((sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes("update pull_requests")) {
      const prId = params[12];
      const projectIdParam = params[13];
      const row = rows.find((entry) => entry.id === prId && entry.project_id === projectIdParam);
      if (row) {
        row.repo_owner = params[0];
        row.repo_name = params[1];
        row.github_pr_number = params[2];
        row.github_url = params[3];
        row.github_node_id = params[4];
        row.title = params[5];
        row.state = params[6];
        row.base_branch = params[7] ?? row.base_branch;
        row.head_branch = params[8] ?? row.head_branch;
        row.last_synced_at = params[9];
        row.updated_at = params[10];
        row.head_sha = params[11] ?? row.head_sha ?? null;
      }
      return undefined;
    }
    if (!text.includes("insert into pull_requests(")) return undefined;
    rows.push({
      id: params[0],
      project_id: params[1],
      lane_id: params[2],
      repo_owner: params[3],
      repo_name: params[4],
      github_pr_number: params[5],
      github_url: params[6],
      github_node_id: params[7],
      title: params[8],
      state: params[9],
      base_branch: params[10],
      head_branch: params[11],
      checks_status: params[12],
      review_status: params[13],
      additions: params[14],
      deletions: params[15],
      last_synced_at: params[16],
      created_at: params[17],
      updated_at: params[18],
      merged_at: params[19] ?? null,
      creation_strategy: params[20] ?? null,
      merge_conflicts: params[21] ?? null,
      behind_base_by: params[22] ?? null,
    });
    return undefined;
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prService.getForLane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildGetForLaneService(
    laneOrLanes: ReturnType<typeof makeFakeLane> | ReturnType<typeof makeFakeLane>[],
    rows: Array<ReturnType<typeof makePrRow>>,
    projectionRows: Array<ReturnType<typeof makeGithubProjectionRow>> = [],
    stackRows: Array<Record<string, unknown>> = [],
    stackEntryRows: Array<Record<string, unknown>> = [],
  ) {
    const lanes = Array.isArray(laneOrLanes) ? laneOrLanes : [laneOrLanes];
    const db = makeMockDb();
    db.get.mockImplementation((sql: string, params: unknown[] = []) => {
      if (String(sql).includes("from lanes")) {
        const lane = lanes.find((candidate) => candidate.id === params[0]);
        if (!lane) return null;
        return {
          lane_type: lane.laneType,
          branch_ref: lane.branchRef,
          base_ref: lane.baseRef,
          archived_at: lane.archivedAt ?? null,
        };
      }
      return null;
    });
    db.all.mockImplementation((sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes("from github_pr_stack_entries")) {
        return stackEntryRows;
      }
      if (text.includes("from github_pr_stacks")) {
        return stackRows;
      }
      if (text.includes("from github_pr_projections")) {
        const mappedKeys = new Set(rows.map((row) => (
          `${String(row.repo_owner).toLowerCase()}/${String(row.repo_name).toLowerCase()}#${Number(row.github_pr_number)}`
        )));
        return projectionRows.filter((row) =>
          row.project_id === params[0]
          && !mappedKeys.has(`${String(row.repo_owner).toLowerCase()}/${String(row.repo_name).toLowerCase()}#${Number(row.github_pr_number)}`)
        );
      }
      if (text.includes("from pull_requests")) {
        if (text.includes("where lane_id = ?")) {
          return rows.filter((row) => row.lane_id === params[0] && row.project_id === params[1]);
        }
        if (text.includes("where project_id = ?")) {
          return rows.filter((row) => row.project_id === params[0]);
        }
        return rows;
      }
      return [];
    });
    return buildService({ db, laneService: makeLaneService(lanes) }).service;
  }

  it("selects and projects the persisted merge timestamp in list snapshots", () => {
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) => {
      if (!String(sql).includes("from pull_requests")) return [];
      expect(String(sql)).toContain("merged_at");
      return [makePrRow({
        state: "merged",
        merged_at: "2026-07-15T00:00:00Z",
      })];
    });
    const { service } = buildService({ db });

    expect(service.listAll()).toEqual([
      expect.objectContaining({
        state: "merged",
        mergedAt: "2026-07-15T00:00:00Z",
      }),
    ]);
  });

  it("includes native GitHub stack membership in lane and list summaries", async () => {
    const lane = makeFakeLane({ branchRef: "refs/heads/stack-ui" });
    const service = buildGetForLaneService(
      lane,
      [makePrRow({
        lane_id: lane.id,
        github_pr_number: 91,
        head_branch: "stack-ui",
      })],
      [],
      [{
        project_id: "proj-1",
        repo_owner: REPO.owner,
        repo_name: REPO.name,
        github_stack_number: 18,
        github_stack_id: "5018",
        github_node_id: "STACK_node18",
        base_branch: "main",
        is_open: 1,
        created_at: "2026-07-30T10:00:00Z",
        synced_at: "2026-07-30T10:01:00Z",
        last_error: null,
      }],
      [
        {
          project_id: "proj-1",
          repo_owner: REPO.owner,
          repo_name: REPO.name,
          github_stack_number: 18,
          github_pr_number: 90,
          position: 1,
          state: "open",
          is_draft: 0,
          merged_at: null,
          head_branch: "stack-core",
          head_sha: "sha-core",
        },
        {
          project_id: "proj-1",
          repo_owner: REPO.owner,
          repo_name: REPO.name,
          github_stack_number: 18,
          github_pr_number: 91,
          position: 2,
          state: "open",
          is_draft: 0,
          merged_at: null,
          head_branch: "stack-ui",
          head_sha: "sha-ui",
        },
      ],
    );

    const expectedStack = {
      id: "5018",
      number: 18,
      size: 2,
      position: 2,
      baseBranch: "main",
    };
    expect(service.getForLane(lane.id)?.stack).toEqual(expectedStack);
    expect(service.listAll()[0]?.stack).toEqual(expectedStack);
    await expect(service.listPrsByLane()).resolves.toEqual([
      expect.objectContaining({
        laneId: lane.id,
        number: 91,
        stack: expectedStack,
      }),
    ]);
  });

  it("does not surface a PR for primary when primary is on its base branch", () => {
    const lane = makeFakeLane({
      laneType: "primary",
      branchRef: "main",
      baseRef: "main",
    });
    const service = buildGetForLaneService(lane, [
      makePrRow({
        lane_id: lane.id,
        state: "open",
        head_branch: "main",
      }),
    ]);

    expect(service.getForLane(lane.id)).toBeNull();
  });

  it("ignores stale PR rows whose head branch no longer matches the lane branch", () => {
    const lane = makeFakeLane({
      branchRef: "refs/heads/current-feature",
    });
    const service = buildGetForLaneService(lane, [
      makePrRow({
        lane_id: lane.id,
        state: "open",
        head_branch: "old-feature",
      }),
    ]);

    expect(service.getForLane(lane.id)).toBeNull();
  });

  it("prefers the PR whose head matches the current lane branch", () => {
    const lane = makeFakeLane({
      branchRef: "refs/heads/current-feature",
    });
    const service = buildGetForLaneService(lane, [
      makePrRow({
        id: "stale-pr",
        lane_id: lane.id,
        github_pr_number: 91,
        head_branch: "old-feature",
        updated_at: "2026-01-03T00:00:00Z",
      }),
      makePrRow({
        id: "current-pr",
        lane_id: lane.id,
        github_pr_number: 92,
        head_branch: "current-feature",
        updated_at: "2026-01-02T00:00:00Z",
      }),
    ]);

    expect(service.getForLane(lane.id)?.githubPrNumber).toBe(92);
  });

  it("returns null for branch-less lanes so a stray PR row never claims an unbranched lane", () => {
    const lane = makeFakeLane({
      branchRef: null,
    });
    const service = buildGetForLaneService(lane, [
      makePrRow({
        lane_id: lane.id,
        github_pr_number: 93,
        head_branch: "latest-active",
      }),
    ]);

    expect(service.getForLane(lane.id)).toBeNull();
  });

  it("surfaces a merged PR row when it still matches the current lane branch", () => {
    const lane = makeFakeLane({
      branchRef: "refs/heads/current-feature",
    });
    const service = buildGetForLaneService(lane, [
      makePrRow({
        lane_id: lane.id,
        state: "merged",
        head_branch: "current-feature",
      }),
    ]);

    expect(service.getForLane(lane.id)?.state).toBe("merged");
  });

  it("ignores terminal PR rows whose head branch no longer matches the lane branch", () => {
    const lane = makeFakeLane({
      branchRef: "refs/heads/current-feature",
    });
    const service = buildGetForLaneService(lane, [
      makePrRow({
        lane_id: lane.id,
        state: "merged",
        head_branch: "old-feature",
      }),
    ]);

    expect(service.getForLane(lane.id)).toBeNull();
  });

  it("allows primary to show an active PR only when checked out to that PR head branch", () => {
    const lane = makeFakeLane({
      laneType: "primary",
      branchRef: "refs/heads/direct-work",
      baseRef: "refs/heads/main",
    });
    const service = buildGetForLaneService(lane, [
      makePrRow({
        lane_id: lane.id,
        github_pr_number: 91,
        state: "draft",
        head_branch: "direct-work",
      }),
    ]);

    expect(service.getForLane(lane.id)?.githubPrNumber).toBe(91);
  });

  it("synthesizes a stable unmapped summary for a projection-only PR on the lane branch", () => {
    const lane = makeFakeLane({ branchRef: "refs/heads/external-feature" });
    const service = buildGetForLaneService(lane, [], [
      makeGithubProjectionRow({
        github_pr_number: 404,
        head_branch: "origin/external-feature",
      }),
    ]);

    expect(service.getForLane(lane.id)).toMatchObject({
      id: "gh:test-owner/test-repo#404",
      unmapped: true,
      laneId: lane.id,
      projectId: "proj-1",
      repoOwner: "test-owner",
      repoName: "test-repo",
      githubPrNumber: 404,
      state: "open",
      headBranch: "origin/external-feature",
      checksStatus: "none",
      reviewStatus: "none",
    });
  });

  it("keeps a terminal mapped row over a stale non-terminal projection for the same PR", () => {
    const lane = makeFakeLane();
    const mapped = makePrRow({
      state: "merged",
      github_pr_number: 404,
      updated_at: "2026-01-05T00:00:00Z",
    });
    const service = buildGetForLaneService(lane, [mapped], [
      makeGithubProjectionRow({
        state: "open",
        github_pr_number: 404,
        updated_at: "2026-01-06T00:00:00Z",
      }),
    ]);

    expect(service.getForLane(lane.id)).toMatchObject({
      id: mapped.id,
      state: "merged",
      githubPrNumber: 404,
    });
  });

  it("ranks active projection-only PRs ahead of terminal mapped PRs across the union", () => {
    const lane = makeFakeLane();
    const service = buildGetForLaneService(lane, [
      makePrRow({ state: "merged", github_pr_number: 90 }),
    ], [
      makeGithubProjectionRow({ state: "open", github_pr_number: 405 }),
    ]);

    expect(service.getForLane(lane.id)).toMatchObject({
      id: "gh:test-owner/test-repo#405",
      unmapped: true,
      state: "open",
      githubPrNumber: 405,
    });
  });

  it("uses recency to rank mapped and projection-only PRs in the same state bucket", () => {
    const lane = makeFakeLane();
    const service = buildGetForLaneService(lane, [
      makePrRow({
        state: "open",
        github_pr_number: 406,
        updated_at: "2026-01-04T00:00:00Z",
      }),
    ], [
      makeGithubProjectionRow({
        state: "draft",
        is_draft: 1,
        github_pr_number: 407,
        updated_at: "2026-01-05T00:00:00Z",
      }),
    ]);

    expect(service.getForLane(lane.id)).toMatchObject({
      id: "gh:test-owner/test-repo#407",
      unmapped: true,
      state: "draft",
      githubPrNumber: 407,
    });
  });

  it("keeps listPrsByLane in parity with the branch-first per-lane resolver", async () => {
    const mappedLane = makeFakeLane({ id: "lane-mapped", branchRef: "refs/heads/mapped-feature" });
    const projectedLane = makeFakeLane({ id: "lane-projected", branchRef: "refs/heads/projected-feature" });
    const emptyLane = makeFakeLane({ id: "lane-empty", branchRef: "refs/heads/empty-feature" });
    const service = buildGetForLaneService(
      [mappedLane, projectedLane, emptyLane],
      [makePrRow({
        id: "mapped-pr",
        lane_id: mappedLane.id,
        github_pr_number: 501,
        state: "draft",
        head_branch: "mapped-feature",
      })],
      [makeGithubProjectionRow({
        github_pr_number: 502,
        state: "merged",
        head_branch: "projected-feature",
      })],
    );

    const perLane = [mappedLane, projectedLane, emptyLane]
      .map((lane) => service.getForLane(lane.id))
      .filter((pr): pr is NonNullable<typeof pr> => pr != null)
      .map((pr) => ({
        laneId: pr.laneId,
        number: pr.githubPrNumber,
        state: pr.state === "draft" ? "open" : pr.state,
        checksPassed: 0,
        checksTotal: 0,
        stack: pr.stack ?? null,
      }));

    await expect(service.listPrsByLane()).resolves.toEqual(perLane);
  });
});

describe("prService.getGithubSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches live GitHub data before serving cold-cache PR metadata", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async () => ({
        data: [
          makeGitHubPull({
            number: 321,
            title: "Live PR",
            html_url: "https://github.com/test-owner/test-repo/pull/321",
          }),
        ],
      })),
    });
    const db = makeMockDb();
    const cachedRow = makePrRow({
      github_pr_number: 321,
      title: "Local cached PR",
      last_synced_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    });
    db.all.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("from pull_requests")) return [cachedRow];
      return [];
    });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([makeFakeLane()]) });

    const snapshot = await service.getGithubSnapshot();

    expect(snapshot).toMatchObject({
      repo: REPO,
      viewerLogin: "octocat",
      repoPullRequests: [
        expect.objectContaining({
          githubPrNumber: 321,
          title: "Live PR",
          linkedPrId: "pr-row-1",
          linkedLaneId: LANE_ID,
          linkedLaneName: "my-feature",
          adeKind: "single",
        }),
      ],
      externalPullRequests: [],
      syncedAt: expect.any(String),
    });
    expect(githubService.getStatus).toHaveBeenCalledTimes(1);
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: `/repos/${REPO.owner}/${REPO.name}/pulls`,
      query: expect.objectContaining({ state: "open" }),
    }));
  });

  it("fetches all PR state totals in one GraphQL request when mobile asks for counts", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  open: { totalCount: 4 },
                  merged: { totalCount: 834 },
                  closed: { totalCount: 17 },
                },
              },
            },
          };
        }
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          return { data: [makeGitHubPull({ number: 321, title: "Live PR" })] };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const snapshot = await service.getGithubSnapshot({ force: true, includeStateCounts: true });

    expect(snapshot.history?.repoPullRequestCounts).toEqual({
      open: 4,
      merged: 834,
      closed: 17,
    });
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      path: "/graphql",
    }));
  });

  it("retries a projected snapshot invalidated while exact state totals are loading", async () => {
    let resolveStaleCounts!: (value: unknown) => void;
    const staleCounts = new Promise<unknown>((resolve) => {
      resolveStaleCounts = resolve;
    });
    let resolveFreshCounts!: (value: unknown) => void;
    const freshCounts = new Promise<unknown>((resolve) => {
      resolveFreshCounts = resolve;
    });
    let countRequests = 0;
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/graphql") {
          countRequests += 1;
          return countRequests === 1 ? staleCounts : freshCounts;
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) =>
      String(sql).includes("from github_pr_projections") ? [makeGithubProjectionRow()] : []);
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    const staleRequest = service.getGithubSnapshot({ includeStateCounts: true, revalidate: false });
    await flushMicrotasks();
    service.invalidateGithubSnapshot();
    const freshRequest = service.getGithubSnapshot({ includeStateCounts: true, revalidate: false });
    await flushMicrotasks();

    resolveFreshCounts({
      data: { data: { repository: {
        open: { totalCount: 2 }, merged: { totalCount: 20 }, closed: { totalCount: 3 },
      } } },
    });
    await expect(freshRequest).resolves.toMatchObject({
      history: { repoPullRequestCounts: { open: 2, merged: 20, closed: 3 } },
    });

    resolveStaleCounts({
      data: { data: { repository: {
        open: { totalCount: 1 }, merged: { totalCount: 10 }, closed: { totalCount: 1 },
      } } },
    });
    await expect(staleRequest).resolves.toMatchObject({
      history: { repoPullRequestCounts: { open: 2, merged: 20, closed: 3 } },
    });
    await expect(service.getGithubSnapshot({ includeStateCounts: true, revalidate: false })).resolves.toMatchObject({
      history: { repoPullRequestCounts: { open: 2, merged: 20, closed: 3 } },
    });
    expect(countRequests).toBe(2);
  });

  it("serves a webhook projection before live GitHub revalidation", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async () => ({ data: [] })),
    });
    const projectionRow = {
      project_id: "proj-1",
      repo_owner: REPO.owner,
      repo_name: REPO.name,
      github_pr_number: 222,
      github_node_id: "PR_projection_222",
      github_url: "https://github.com/test-owner/test-repo/pull/222",
      title: "Webhook projected PR",
      state: "open",
      is_draft: 0,
      base_branch: "main",
      head_branch: "feature/webhook",
      head_repo_owner: REPO.owner,
      head_repo_name: REPO.name,
      head_sha: "webhook-head",
      base_sha: "base-sha",
      author: "octocat",
      labels_json: JSON.stringify([{ name: "webhook", color: "4f46e5", description: null }]),
      is_bot: 0,
      comment_count: 3,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
      synced_at: "2026-05-02T00:00:01Z",
      last_event_name: "pull_request",
      last_delivery_id: "delivery-projection",
    };
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("from github_pr_projections")) return [projectionRow];
      return [];
    });
    db.get.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("open_count")) {
        return { open_count: 1, closed_count: 2, merged_count: 3 };
      }
      return null;
    });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    const snapshot = await service.getGithubSnapshot();

    expect(snapshot.repoPullRequests).toEqual([
      expect.objectContaining({
        githubPrNumber: 222,
        title: "Webhook projected PR",
        headBranch: "feature/webhook",
        labels: [expect.objectContaining({ name: "webhook" })],
        commentCount: 3,
      }),
    ]);
    expect(snapshot.history?.repoPullRequestCounts).toEqual({
      open: 1,
      closed: 2,
      merged: 3,
    });
    await flushMicrotasks();
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: `/repos/${REPO.owner}/${REPO.name}/pulls`,
    }));
  });

  it("persists live GitHub snapshot rows into the compact projection catalog", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async () => ({
        data: [
          makeGitHubPull({
            number: 333,
            title: "Catalog persisted PR",
            html_url: "https://github.com/test-owner/test-repo/pull/333",
            updated_at: "2026-05-03T00:00:00Z",
          }),
        ],
      })),
    });
    const db = makeMockDb();
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    const snapshot = await service.getGithubSnapshot({ force: true });

    expect(snapshot.repoPullRequests[0]?.title).toBe("Catalog persisted PR");
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_projections"),
      expect.arrayContaining([
        "proj-1",
        REPO.owner,
        REPO.name,
        333,
        "PR_node_1",
        "https://github.com/test-owner/test-repo/pull/333",
        "Catalog persisted PR",
      ]),
    );
  });

  it("caps initial closed-history fetches and reports when more history may exist", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { query?: { page?: number } }) => {
        const page = Number(args.query?.page ?? 1);
        return {
          data: Array.from({ length: 100 }, (_value, index) => makeGitHubPull({
            number: (page - 1) * 100 + index + 1,
            title: `History PR ${(page - 1) * 100 + index + 1}`,
            state: "closed",
            merged_at: index % 2 === 0 ? "2026-05-01T00:00:00Z" : null,
          })),
        };
      }),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const snapshot = await service.getGithubSnapshot({ force: true, includeExternalClosed: true });

    const repoCalls = githubService.apiRequest.mock.calls.filter(([args]: [{ path?: string }]) =>
      args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`,
    );
    expect(repoCalls).toHaveLength(2);
    expect(repoCalls[0]?.[0]).toEqual(expect.objectContaining({
      query: expect.objectContaining({ state: "all", page: 1 }),
    }));
    expect(repoCalls[1]?.[0]).toEqual(expect.objectContaining({
      query: expect.objectContaining({ state: "all", page: 2 }),
    }));
    expect(snapshot.repoPullRequests).toHaveLength(200);
    expect(snapshot.history).toEqual(expect.objectContaining({
      includeExternalClosed: true,
      pageLimit: 2,
      repoPullRequestsLoaded: 200,
      repoPullRequestsMayHaveMore: true,
    }));
  });

  it("does not inspect repository data when the token is missing", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus({
        tokenStored: false,
        connected: false,
        userLogin: null,
      })),
      apiRequest: vi.fn(async () => ({ data: [makeGitHubPull({ title: "Private live PR" })] })),
    });
    const db = makeMockDb();
    db.all.mockImplementation(() => {
      throw new Error("Repository state should not be inspected without usable GitHub auth.");
    });
    const { service } = buildService({ db, githubService });

    await expect(service.getGithubSnapshot()).rejects.toThrow("GitHub auth missing");
    expect(db.all).not.toHaveBeenCalled();
    expect(githubService.apiRequest).not.toHaveBeenCalled();
  });

  it("does not return an in-memory GitHub snapshot when token status is invalid", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn()
        .mockResolvedValueOnce(makeGithubStatus())
        .mockResolvedValueOnce(makeGithubStatus({
          connected: false,
          repoAccessError: "403: Resource not accessible by token",
        })),
      apiRequest: vi.fn(async () => ({ data: [makeGitHubPull({ title: "Private cached PR" })] })),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const cached = await service.getGithubSnapshot({ force: true });
    expect(cached.repoPullRequests[0]?.title).toBe("Private cached PR");
    githubService.apiRequest.mockClear();

    await expect(service.getGithubSnapshot()).rejects.toThrow("GitHub auth cannot access test-owner/test-repo");
    expect(githubService.apiRequest).not.toHaveBeenCalled();
  });

  it("backfills branch PR auto-links during a live snapshot", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string; query?: Record<string, unknown> }) => {
        if (args.path !== `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }
        if (args.query?.head === `${REPO.owner}:feature/missed`) {
          return {
            data: [
              makeGitHubPull({
                number: 654,
                title: "Background linked PR",
                head: {
                  ref: "feature/missed",
                  user: { login: REPO.owner },
                  repo: { owner: { login: REPO.owner }, name: REPO.name },
                },
              }),
            ],
          };
        }
        return { data: [] };
      }),
    });
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("from pull_requests")) return [makePrRow({ title: "Already cached PR" })];
      return [];
    });
    const laneService = makeLaneService([
      makeFakeLane(),
      makeFakeLane({ id: "lane-missed", branchRef: "refs/heads/feature/missed" }),
    ]);
    const { service } = buildService({ db, githubService, laneService });

    const snapshot = await service.getGithubSnapshot();

    expect(snapshot.repoPullRequests[0]?.title).toBe("Background linked PR");

    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ head: `${REPO.owner}:feature/missed` }),
    }));
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.arrayContaining(["lane-missed", REPO.owner, REPO.name, 654, "Background linked PR", "open", "main", "feature/missed"]),
    );
  });

  it("does not auto-link same-owner fork PRs to matching local lanes", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path !== `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }
        return {
          data: [
            makeGitHubPull({
              number: 655,
              title: "Same owner fork PR",
              head: {
                ref: "feature/missed",
                user: { login: REPO.owner },
                repo: { owner: { login: REPO.owner }, name: "fork-repo" },
              },
            }),
          ],
        };
      }),
    });
    const db = makeMockDb();
    const laneService = makeLaneService([
      makeFakeLane({ id: "lane-missed", branchRef: "refs/heads/feature/missed" }),
    ]);
    const { service } = buildService({ db, githubService, laneService });

    const snapshot = await service.getGithubSnapshot({ force: true });

    expect(snapshot.repoPullRequests[0]).toEqual(expect.objectContaining({
      githubPrNumber: 655,
      linkedPrId: null,
      headRepoOwner: REPO.owner,
      headRepoName: "fork-repo",
    }));
    expect(db.run.mock.calls.some(([sql]: [unknown]) => String(sql).includes("insert into pull_requests("))).toBe(false);
  });

  it("does not backfill a PR row when only an archived lane matches the head branch", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path !== `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }
        return {
          data: [
            makeGitHubPull({
              number: 656,
              title: "Archived lane PR",
              head: {
                ref: "feature/archived",
                user: { login: REPO.owner },
                repo: { owner: { login: REPO.owner }, name: REPO.name },
              },
            }),
          ],
        };
      }),
    });
    const db = makeMockDb();
    const laneService = makeLaneService([
      makeFakeLane({
        id: "lane-archived",
        branchRef: "refs/heads/feature/archived",
        archivedAt: "2026-05-01T00:00:00.000Z",
      }),
    ]);
    const { service } = buildService({ db, githubService, laneService });

    const snapshot = await service.getGithubSnapshot({ force: true });

    expect(snapshot.repoPullRequests[0]).toEqual(expect.objectContaining({
      githubPrNumber: 656,
      linkedPrId: null,
    }));
    expect(db.run.mock.calls.some(([sql]: [unknown]) => String(sql).includes("insert into pull_requests("))).toBe(false);
  });

  it("returns stale cached data immediately while revalidating in the background", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    let resolveRevalidation!: (value: unknown) => void;
    const revalidationStarted = new Promise<unknown>((resolve) => {
      resolveRevalidation = resolve;
    });
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn()
        .mockResolvedValueOnce({ data: [makeGitHubPull({ title: "Cached PR" })] })
        .mockImplementationOnce(() => revalidationStarted),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    try {
      const first = await service.getGithubSnapshot();
      expect(first.repoPullRequests[0]?.title).toBe("Cached PR");
      expect(githubService.apiRequest).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(Date.parse("2026-01-01T00:00:00Z") + GITHUB_SNAPSHOT_TTL_MS_FOR_TEST + 1);
      const stale = await service.getGithubSnapshot();
      expect(stale.repoPullRequests[0]?.title).toBe("Cached PR");
      await flushMicrotasks(30);
      expect(githubService.apiRequest).toHaveBeenCalledTimes(2);

      resolveRevalidation({ data: [makeGitHubPull({ title: "Fresh PR", updated_at: "2026-01-01T00:05:00Z" })] });
      await flushMicrotasks();

      const fresh = await service.getGithubSnapshot();
      expect(fresh.repoPullRequests[0]?.title).toBe("Fresh PR");
      expect(githubService.apiRequest).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns stale cached data without starting GitHub work when revalidation is disabled", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async () => ({ data: [makeGitHubPull({ title: "Cached PR" })] })),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    try {
      await service.getGithubSnapshot();
      nowSpy.mockReturnValue(Date.parse("2026-01-01T00:00:00Z") + GITHUB_SNAPSHOT_TTL_MS_FOR_TEST + 1);

      const stale = await service.getGithubSnapshot({ revalidate: false });
      expect(stale.repoPullRequests[0]?.title).toBe("Cached PR");
      await flushMicrotasks(30);
      expect(githubService.apiRequest).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps GitHub tab snapshots scoped to the current repo", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => ({
        data: args.path === "/search/issues" ? { items: [] } : [],
      })),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const defaultSnapshot = await service.getGithubSnapshot({ force: true });
    expect(defaultSnapshot.externalPullRequests).toEqual([]);
    expect(githubService.apiRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/search/issues" }),
    );

    githubService.apiRequest.mockClear();
    const fullHistorySnapshot = await service.getGithubSnapshot({ force: true, includeExternalClosed: true });
    expect(fullHistorySnapshot.externalPullRequests).toEqual([]);
    expect(githubService.apiRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/search/issues" }),
    );
  });

  it("starts a full-history snapshot when an open-only in-flight snapshot cannot satisfy the request", async () => {
    let resolveOpenRepo!: (value: unknown) => void;
    const openRepoRequest = new Promise<unknown>((resolve) => {
      resolveOpenRepo = resolve;
    });
    let repoCalls = 0;
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          repoCalls += 1;
          return openRepoRequest;
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const defaultSnapshot = service.getGithubSnapshot();
    await flushMicrotasks();
    const closedHistorySnapshot = service.getGithubSnapshot({ includeExternalClosed: true });
    await flushMicrotasks();

    resolveOpenRepo({ data: [makeGitHubPull({ number: 2, title: "Repo PR" })] });
    await expect(defaultSnapshot).resolves.toEqual(expect.objectContaining({
      repoPullRequests: [expect.objectContaining({ title: "Repo PR" })],
      externalPullRequests: [],
    }));
    await expect(closedHistorySnapshot).resolves.toEqual(expect.objectContaining({
      repoPullRequests: [expect.objectContaining({ title: "Repo PR" })],
      externalPullRequests: [],
    }));
    expect(repoCalls).toBe(2);
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ state: "open" }),
    }));
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ state: "all" }),
    }));
  });

  it("does not serve closed-history requests from a fresh open-only repo snapshot cache", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          return { data: [makeGitHubPull({ number: 1, title: "Cached repo PR" })] };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const cached = await service.getGithubSnapshot({ force: true });
    expect(cached.repoPullRequests[0]?.title).toBe("Cached repo PR");

    const apiCallsAfterCache = githubService.apiRequest.mock.calls.length;
    const closedHistory = await service.getGithubSnapshot({ includeExternalClosed: true });
    expect(closedHistory.repoPullRequests[0]?.title).toBe("Cached repo PR");
    expect(closedHistory.externalPullRequests).toEqual([]);
    expect(githubService.apiRequest).toHaveBeenCalledTimes(apiCallsAfterCache + 1);
    expect(githubService.apiRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ state: "all" }),
    }));
  });

  it("does not let a superseded open-only snapshot overwrite a fresher cache", async () => {
    let resolveStaleRepo!: (value: unknown) => void;
    const staleRepoRequest = new Promise<unknown>((resolve) => {
      resolveStaleRepo = resolve;
    });
    let resolveFreshRepo!: (value: unknown) => void;
    const freshRepoRequest = new Promise<unknown>((resolve) => {
      resolveFreshRepo = resolve;
    });
    let repoCalls = 0;
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          repoCalls += 1;
          if (repoCalls === 1) return staleRepoRequest;
          return freshRepoRequest;
        }
        return { data: { items: [] } };
      }),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const staleRequest = service.getGithubSnapshot({ force: true });
    await flushMicrotasks();
    const freshRequest = service.getGithubSnapshot({ force: true });
    await flushMicrotasks();

    resolveFreshRepo({ data: [makeGitHubPull({ number: 2, title: "Fresh open-only PR" })] });
    await expect(freshRequest).resolves.toEqual(expect.objectContaining({
      repoPullRequests: [expect.objectContaining({ title: "Fresh open-only PR" })],
    }));

    resolveStaleRepo({ data: [makeGitHubPull({ number: 1, title: "Stale open-only PR" })] });
    await expect(staleRequest).resolves.toEqual(expect.objectContaining({
      repoPullRequests: [expect.objectContaining({ title: "Stale open-only PR" })],
    }));

    const cachedSnapshot = await service.getGithubSnapshot();
    expect(cachedSnapshot.repoPullRequests[0]?.title).toBe("Fresh open-only PR");
    expect(repoCalls).toBe(2);
  });

  it("does not let an invalidated in-flight snapshot repopulate an empty cache", async () => {
    let resolveStaleRepo!: (value: unknown) => void;
    const staleRepoRequest = new Promise<unknown>((resolve) => {
      resolveStaleRepo = resolve;
    });
    let resolveFreshRepo!: (value: unknown) => void;
    const freshRepoRequest = new Promise<unknown>((resolve) => {
      resolveFreshRepo = resolve;
    });
    let repoCalls = 0;
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          repoCalls += 1;
          if (repoCalls === 1) return staleRepoRequest;
          return freshRepoRequest;
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    const staleRequest = service.getGithubSnapshot({ force: true });
    await flushMicrotasks();
    service.invalidateGithubSnapshot();

    resolveStaleRepo({ data: [makeGitHubPull({ number: 1, title: "Invalidated PR" })] });
    await expect(staleRequest).resolves.toEqual(expect.objectContaining({
      repoPullRequests: [expect.objectContaining({ title: "Invalidated PR" })],
    }));

    const freshRequest = service.getGithubSnapshot();
    await flushMicrotasks();
    resolveFreshRepo({ data: [makeGitHubPull({ number: 2, title: "Fresh after invalidation" })] });
    await expect(freshRequest).resolves.toEqual(expect.objectContaining({
      repoPullRequests: [expect.objectContaining({ title: "Fresh after invalidation" })],
    }));
    expect(repoCalls).toBe(2);
  });

  it("bootstraps repository stack state on a forced snapshot when the local store is empty", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          return { data: [] };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
      stackApiRequest: vi.fn(async () => ({
        data: [{
          id: 5017,
          number: 17,
          base: { ref: "main" },
          open: false,
          created_at: "2026-07-30T09:00:00Z",
          pull_requests: [{
            number: 70,
            state: "closed",
            draft: false,
            merged_at: "2026-07-30T10:00:00Z",
            head: { ref: "stack/completed", sha: "sha-completed" },
          }],
        }],
        linkHeader: null,
      })),
    });
    const db = makeMockDb();
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    await service.getGithubSnapshot({ force: true });

    expect(githubService.apiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks`,
      query: { per_page: 100, page: 1 },
    });
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_stacks"),
      expect.arrayContaining(["proj-1", REPO.owner, REPO.name, 17, "5017", null, "main", 0]),
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_stack_entries"),
      expect.arrayContaining(["proj-1", REPO.owner, REPO.name, 17, 70, 1, "closed"]),
    );
  });

  it("preserves repo snapshot cache mode during stale revalidation", async () => {
    const initialNow = Date.parse("2026-01-01T00:00:00Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    let repoCalls = 0;
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string; query?: { q?: string } }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          repoCalls += 1;
          return {
            data: [
              makeGitHubPull({
                number: repoCalls,
                title: repoCalls === 1 ? "Cached full history" : "Fresh full history",
              }),
            ],
          };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ githubService, laneService: makeLaneService([]) });

    try {
      const fullHistory = await service.getGithubSnapshot({ includeExternalClosed: true });
      expect(fullHistory.externalPullRequests).toEqual([]);

      nowSpy.mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
      const staleOpenOnly = await service.getGithubSnapshot();
      expect(staleOpenOnly.repoPullRequests[0]?.title).toBe("Cached full history");

      const staleClosedHistory = await service.getGithubSnapshot({ includeExternalClosed: true });
      expect(staleClosedHistory.repoPullRequests[0]?.title).toBe("Cached full history");
      expect(staleClosedHistory.externalPullRequests).toEqual([]);
      await flushMicrotasks();

      const cachedFullHistory = await service.getGithubSnapshot({ includeExternalClosed: true });
      expect(cachedFullHistory.repoPullRequests[0]?.title).toBe("Fresh full history");
      expect(cachedFullHistory.externalPullRequests).toEqual([]);
      expect(repoCalls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("backfills a lane PR row from GitHub when the head branch matches an active lane", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn()
        .mockResolvedValueOnce({
          data: [
            makeGitHubPull({
              number: 134,
              title: "QA pass",
              state: "closed",
              merged_at: "2026-05-05T20:06:50Z",
              head: {
                ref: "feature/cached",
                user: { login: REPO.owner },
                repo: { owner: { login: REPO.owner }, name: REPO.name },
              },
            }),
          ],
        })
        .mockResolvedValueOnce({ data: { items: [] } }),
    });
    const db = makeMockDb();
    const lane = makeFakeLane({ branchRef: "refs/heads/feature/cached" });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([lane]) });

    await service.getGithubSnapshot({ force: true });

    const insertCall = db.run.mock.calls.find(([sql]: [unknown]) => String(sql).includes("insert into pull_requests("));
    expect(insertCall).toBeTruthy();
    expect(insertCall?.[1]).toEqual(expect.arrayContaining([
      LANE_ID,
      REPO.owner,
      REPO.name,
      134,
      "QA pass",
      "merged",
      "feature/cached",
    ]));
  });

  it("fetches a targeted same-repo lane branch PR when the repo snapshot window misses it", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string; query?: Record<string, unknown> }) => {
        if (args.path !== `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }
        if (args.query?.head === `${REPO.owner}:feature/missed`) {
          return {
            data: [
              makeGitHubPull({
                number: 222,
                title: "Missed branch PR",
                state: "closed",
                merged_at: null,
                head: {
                  ref: "feature/missed",
                  user: { login: REPO.owner },
                  repo: { owner: { login: REPO.owner }, name: REPO.name },
                },
              }),
            ],
          };
        }
        return {
          data: [
            makeGitHubPull({
              number: 111,
              title: "Recent unrelated PR",
              head: {
                ref: "feature/recent",
                user: { login: REPO.owner },
                repo: { owner: { login: REPO.owner }, name: REPO.name },
              },
            }),
          ],
        };
      }),
    });
    const lane = makeFakeLane({ branchRef: "refs/heads/feature/missed" });
    const db = makeMockDb();
    const { service } = buildService({ db, githubService, laneService: makeLaneService([lane]) });

    const snapshot = await service.getGithubSnapshot({ force: true });

    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ head: `${REPO.owner}:feature/missed` }),
    }));
    expect(snapshot.repoPullRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        githubPrNumber: 222,
        title: "Missed branch PR",
        state: "closed",
        headRepoOwner: REPO.owner,
        headRepoName: REPO.name,
      }),
    ]));
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.arrayContaining([LANE_ID, REPO.owner, REPO.name, 222, "Missed branch PR", "closed", "main", "feature/missed"]),
    );
  });

  it("skips targeted same-repo lane branch lookups when a local row already covers the branch", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string; query?: Record<string, unknown> }) => {
        if (args.path !== `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }
        if (args.query?.head) {
          throw new Error(`Unexpected targeted lookup: ${String(args.query.head)}`);
        }
        return { data: [] };
      }),
    });
    const db = makeMockDb();
    installPullRequestRowStore(db, [
      makePrRow({
        lane_id: LANE_ID,
        state: "merged",
        head_branch: "feature/cached",
      }),
    ]);
    const lane = makeFakeLane({ branchRef: "refs/heads/feature/cached" });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([lane]) });

    await service.getGithubSnapshot({ force: true });

    expect(githubService.apiRequest).toHaveBeenCalledTimes(2);
    expect(githubService.apiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks`,
      query: { per_page: 100, page: 1 },
    });
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ state: "open" }),
    }));
  });

  it("keeps targeted local-row branch lookups for full-history snapshots", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string; query?: Record<string, unknown> }) => {
        if (args.path !== `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }
        if (args.query?.head === `${REPO.owner}:feature/cached`) {
          return {
            data: [
              makeGitHubPull({
                number: 90,
                title: "Merged cached branch PR",
                state: "closed",
                merged_at: "2026-05-01T00:00:00Z",
                head: {
                  ref: "feature/cached",
                  user: { login: REPO.owner },
                  repo: { owner: { login: REPO.owner }, name: REPO.name },
                },
              }),
            ],
          };
        }
        return { data: [] };
      }),
    });
    const db = makeMockDb();
    installPullRequestRowStore(db, [
      makePrRow({
        github_pr_number: 90,
        lane_id: LANE_ID,
        state: "merged",
        head_branch: "feature/cached",
      }),
    ]);
    const lane = makeFakeLane({ branchRef: "refs/heads/feature/cached" });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([lane]) });

    const snapshot = await service.getGithubSnapshot({ force: true, includeExternalClosed: true });

    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ state: "all" }),
    }));
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ head: `${REPO.owner}:feature/cached` }),
    }));
    expect(snapshot.repoPullRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        githubPrNumber: 90,
        title: "Merged cached branch PR",
        state: "merged",
      }),
    ]));
  });

  it("continues targeted lane branch PR lookups after one branch lookup fails", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string; query?: Record<string, unknown> }) => {
        if (args.path !== `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }
        if (args.query?.head === `${REPO.owner}:feature/flaky`) {
          throw new Error("temporary GitHub failure");
        }
        if (args.query?.head === `${REPO.owner}:feature/missed`) {
          return {
            data: [
              makeGitHubPull({
                number: 222,
                title: "Missed branch PR",
                state: "closed",
                merged_at: null,
                head: {
                  ref: "feature/missed",
                  user: { login: REPO.owner },
                  repo: { owner: { login: REPO.owner }, name: REPO.name },
                },
              }),
            ],
          };
        }
        return {
          data: [
            makeGitHubPull({
              number: 111,
              title: "Recent unrelated PR",
              head: {
                ref: "feature/recent",
                user: { login: REPO.owner },
                repo: { owner: { login: REPO.owner }, name: REPO.name },
              },
            }),
          ],
        };
      }),
    });
    const db = makeMockDb();
    const laneService = makeLaneService([
      makeFakeLane({ id: "lane-flaky", branchRef: "refs/heads/feature/flaky" }),
      makeFakeLane({ branchRef: "refs/heads/feature/missed" }),
    ]);
    const { service } = buildService({ db, githubService, laneService });

    const snapshot = await service.getGithubSnapshot({ force: true });

    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ head: `${REPO.owner}:feature/flaky` }),
    }));
    expect(githubService.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ head: `${REPO.owner}:feature/missed` }),
    }));
    expect(snapshot.repoPullRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        githubPrNumber: 222,
        title: "Missed branch PR",
      }),
    ]));
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.arrayContaining([LANE_ID, REPO.owner, REPO.name, 222, "Missed branch PR", "closed", "main", "feature/missed"]),
    );
  });

  it("updates an existing repo PR row during lane PR backfill instead of duplicating it", async () => {
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn()
        .mockResolvedValueOnce({
          data: [
            makeGitHubPull({
              number: 134,
              title: "QA pass",
              head: {
                ref: "feature/cached",
                user: { login: REPO.owner },
                repo: { owner: { login: REPO.owner }, name: REPO.name },
              },
            }),
          ],
        })
        .mockResolvedValueOnce({ data: { items: [] } }),
    });
    const db = makeMockDb();
    const existing = makePrRow({
      id: "existing-pr",
      lane_id: LANE_ID,
      github_pr_number: 134,
      head_branch: "old-feature",
    });
    db.get.mockImplementation((sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes("github_pr_number") && params[0] === "proj-1" && params[3] === 134) {
        return existing;
      }
      return null;
    });
    const lane = makeFakeLane({ branchRef: "refs/heads/feature/cached" });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([lane]) });

    await service.getGithubSnapshot({ force: true });

    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("update pull_requests"),
      expect.arrayContaining(["existing-pr", "proj-1"]),
    );
    expect(db.run).not.toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.anything(),
    );
  });
});

describe("prService.ingestGithubWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates GitHub webhook deliveries by delivery id", async () => {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (String(sql).includes("from github_webhook_deliveries")) {
        return { id: "delivery-row-1", status: "processed" };
      }
      return null;
    });
    const { service } = buildService({ db });

    const result = await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-1",
      payload: { pull_request: makeGitHubPull() },
    });

    expect(result).toEqual(expect.objectContaining({
      processed: false,
      duplicate: true,
      reason: "processed",
    }));
    expect(db.run).not.toHaveBeenCalled();
  });

  it("allows errored GitHub webhook deliveries to retry with the same delivery id", async () => {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (String(sql).includes("from github_webhook_deliveries")) {
        return { id: "delivery-row-error", status: "error" };
      }
      return null;
    });
    const { service } = buildService({ db });

    const result = await service.ingestGithubWebhook({
      eventName: "ping",
      deliveryId: "delivery-retry",
      payload: {
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      processed: false,
      duplicate: false,
      repoOwner: REPO.owner,
      repoName: REPO.name,
      reason: "unsupported_event",
    }));
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("update github_webhook_deliveries"),
      expect.arrayContaining(["delivery-retry", "ping", "received", "delivery-row-error", "proj-1"]),
    );
  });

  it("updates the webhook projection, linked PR row, and PR event stream", async () => {
    const db = makeMockDb();
    const rows = installPullRequestRowStore(db, [
      makePrRow({
        github_pr_number: 90,
        title: "Before webhook",
        state: "open",
        head_branch: "my-feature",
      }),
    ]);
    const { service } = buildService({
      db,
      laneService: makeLaneService([makeFakeLane({ branchRef: "refs/heads/my-feature" })]),
    });
    const events: unknown[] = [];
    service.setEventEmitter((event) => events.push(event));

    const result = await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-2",
      payload: {
        action: "synchronize",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        pull_request: makeGitHubPull({
          number: 90,
          node_id: "PR_webhook_90",
          html_url: "https://github.com/test-owner/test-repo/pull/90",
          title: "After webhook",
          draft: true,
          updated_at: "2026-05-03T00:00:00Z",
          base: {
            ref: "main",
            sha: "base-sha",
            repo: { owner: { login: REPO.owner }, name: REPO.name },
          },
          head: {
            ref: "my-feature",
            sha: "head-sha-webhook",
            user: { login: REPO.owner },
            repo: { owner: { login: REPO.owner }, name: REPO.name },
          },
          labels: [{ name: "webhook", color: "10b981" }],
          comments: 5,
        }),
      },
    });

    expect(result).toEqual(expect.objectContaining({
      processed: true,
      duplicate: false,
      repoOwner: REPO.owner,
      repoName: REPO.name,
      githubPrNumber: 90,
      linkedPrIds: ["pr-row-1"],
      reason: null,
    }));
    expect(rows[0]).toEqual(expect.objectContaining({
      title: "After webhook",
      state: "draft",
      github_node_id: "PR_webhook_90",
      head_sha: "head-sha-webhook",
      last_synced_at: expect.any(String),
    }));
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_projections"),
      expect.arrayContaining([REPO.owner, REPO.name, 90, "PR_webhook_90", "After webhook", "draft"]),
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "prs-updated",
      prs: [expect.objectContaining({ title: "After webhook", state: "draft" })],
    }));
  });

  it("reconciles and transactionally replaces the whole GitHub stack after a stacked webhook", async () => {
    const db = makeMockDb();
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        expect(args.path).toBe(`/repos/${REPO.owner}/${REPO.name}/stacks/18`);
        return {
          data: {
            id: 5018,
            number: 18,
            node_id: "STACK_node18",
            base: { ref: "main" },
            open: true,
            created_at: "2026-07-30T10:00:00Z",
            pull_requests: [
              {
                number: 90,
                state: "open",
                draft: false,
                merged_at: null,
                head: { ref: "stack/core", sha: "sha-core" },
              },
              {
                number: 91,
                state: "open",
                draft: true,
                merged_at: null,
                head: { ref: "stack/ui", sha: "sha-ui" },
              },
            ],
          },
        };
      }),
    });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    const result = await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-stacked",
      payload: {
        action: "stacked",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        stack: {
          id: 5018,
          number: 18,
          size: 2,
          position: 1,
          base: { ref: "main", sha: "sha-main" },
        },
        pull_request: makeGitHubPull({
          number: 90,
          stack: {
            id: 5018,
            number: 18,
            size: 2,
            position: 1,
            base: { ref: "main", sha: "sha-main" },
          },
        }),
      },
    });
    await flushMicrotasks();

    expect(result).toEqual(expect.objectContaining({
      processed: true,
      githubPrNumber: 90,
    }));
    expect(githubService.apiRequest).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledWith("begin immediate");
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_stacks"),
      expect.arrayContaining(["proj-1", REPO.owner, REPO.name, 18, "5018", "STACK_node18", "main"]),
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("delete from github_pr_stack_entries"),
      ["proj-1", REPO.owner, REPO.name, 18],
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("github_pr_number = ?"),
      ["proj-1", REPO.owner, REPO.name, 91, 18],
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_stack_entries"),
      expect.arrayContaining(["proj-1", REPO.owner, REPO.name, 18, 91, 2, "open", 1]),
    );
    expect(db.run).toHaveBeenCalledWith("commit");
  });

  it("atomically reconciles the repository when a pull request moves between stacks", async () => {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (String(sql).includes("from github_pr_stack_entries")) {
        return { github_stack_number: 17 };
      }
      return null;
    });
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        throw new Error(`Unexpected item stack read: ${args.path}`);
      }),
      stackApiRequest: vi.fn(async () => ({
        data: [
          {
            id: 5017,
            number: 17,
            base: { ref: "main" },
            open: true,
            created_at: "2026-07-30T09:00:00Z",
            pull_requests: [{
              number: 89,
              state: "open",
              draft: false,
              merged_at: null,
              head: { ref: "stack/remaining", sha: "sha-remaining" },
            }],
          },
          {
            id: 5018,
            number: 18,
            base: { ref: "main" },
            open: true,
            created_at: "2026-07-30T10:00:00Z",
            pull_requests: [{
              number: 90,
              state: "open",
              draft: false,
              merged_at: null,
              head: { ref: "stack/moved", sha: "sha-moved" },
            }],
          },
        ],
        linkHeader: null,
      })),
    });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-restacked",
      payload: {
        action: "stacked",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        pull_request: makeGitHubPull({
          number: 90,
          stack: {
            id: 5018,
            number: 18,
            size: 1,
            position: 1,
            base: { ref: "main", sha: "sha-main" },
          },
        }),
      },
    });

    expect(githubService.apiRequest).not.toHaveBeenCalledWith(expect.objectContaining({
      path: `/repos/${REPO.owner}/${REPO.name}/stacks/18`,
    }));
    expect(githubService.apiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks`,
      query: { per_page: 100, page: 1 },
    });
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("delete from github_pr_stacks"),
      ["proj-1", REPO.owner, REPO.name],
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_stacks"),
      expect.arrayContaining([17, "5017", "main", 1]),
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_stacks"),
      expect.arrayContaining([18, "5018", "main", 1]),
    );
  });

  it("reconciles a previously known stack when a later PR webhook omits stack metadata", async () => {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (String(sql).includes("from github_pr_stack_entries")) {
        return { github_stack_number: 18 };
      }
      return null;
    });
    const githubService = makeGithubService({
      apiRequest: vi.fn(async () => ({
        data: {
          id: 5018,
          number: 18,
          base: { ref: "main" },
          open: false,
          created_at: "2026-07-30T10:00:00Z",
          pull_requests: [
            {
              number: 90,
              state: "closed",
              draft: false,
              merged_at: "2026-07-30T12:00:00Z",
              head: { ref: "stack/core", sha: "sha-core" },
            },
          ],
        },
      })),
    });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-merged",
      payload: {
        action: "closed",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        pull_request: makeGitHubPull({
          number: 90,
          state: "closed",
          merged_at: "2026-07-30T12:00:00Z",
        }),
      },
    });
    await flushMicrotasks();

    expect(githubService.apiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks/18`,
    });
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_stacks"),
      expect.arrayContaining([18, "5018", "main", 0]),
    );
  });

  it("falls back to the repository list when a known stack has dissolved", async () => {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (String(sql).includes("from github_pr_stack_entries")) {
        return { github_stack_number: 18 };
      }
      return null;
    });
    const apiRequest = vi.fn().mockRejectedValueOnce(new Error("Not Found"));
    const stackApiRequest = vi.fn().mockResolvedValueOnce({ data: [], linkHeader: null });
    const githubService = makeGithubService({ apiRequest, stackApiRequest });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    const result = await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-unstacked",
      payload: {
        action: "synchronize",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        pull_request: makeGitHubPull({ number: 90, stack: null }),
      },
    });

    expect(result.processed).toBe(true);
    expect(githubService.apiRequest).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks`,
      query: { per_page: 100, page: 1 },
    });
    expect(stackApiRequest).toHaveBeenCalledWith({
      method: "GET",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks`,
      query: { per_page: 100, page: 1 },
    });
    expect(db.run).toHaveBeenCalledWith("begin immediate");
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("delete from github_pr_stacks"),
      ["proj-1", REPO.owner, REPO.name],
    );
    expect(db.run).toHaveBeenCalledWith("commit");
  });

  it("keeps a webhook processed when both stack reconciliation reads fail", async () => {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (String(sql).includes("from github_pr_stack_entries")) {
        return { github_stack_number: 18 };
      }
      return null;
    });
    const apiRequest = vi.fn().mockRejectedValueOnce(new Error("Stack read timed out"));
    const stackApiRequest = vi.fn().mockRejectedValueOnce(new Error("Repository stack list timed out"));
    const githubService = makeGithubService({ apiRequest, stackApiRequest });
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    const result = await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-stack-read-failed",
      payload: {
        action: "synchronize",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        pull_request: makeGitHubPull({ number: 90, stack: null }),
      },
    });

    expect(result.processed).toBe(true);
    expect(githubService.apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(stackApiRequest).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("raw_payload_json = null"),
      expect.arrayContaining(["processed"]),
    );
  });

  it("creates a GitHub stack from pull requests ordered bottom to top", async () => {
    const db = makeMockDb();
    const githubService = makeGithubService({
      apiRequest: vi.fn(async () => ({
        data: {
          id: 5019,
          number: 19,
          node_id: "STACK_node19",
          base: { ref: "main" },
          open: true,
          created_at: "2026-07-30T13:00:00Z",
          pull_requests: [
            {
              number: 964,
              state: "open",
              draft: false,
              merged_at: null,
              head: { ref: "ade/github-stacked-prs-core", sha: "sha-core" },
            },
            {
              number: 965,
              state: "open",
              draft: false,
              merged_at: null,
              head: { ref: "ade/github-stacked-prs-cli", sha: "sha-cli" },
            },
          ],
        },
      })),
    });
    const { service } = buildService({ db, githubService });

    const stack = await service.createGithubStack({
      repo: REPO,
      pullRequests: [964, 965],
    });

    expect(githubService.apiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks`,
      body: { pull_requests: [964, 965] },
    });
    expect(stack).toEqual(expect.objectContaining({
      number: 19,
      entries: [
        expect.objectContaining({ githubPrNumber: 964, position: 1 }),
        expect.objectContaining({ githubPrNumber: 965, position: 2 }),
      ],
    }));
  });

  it("rejects fractional pull request numbers before calling GitHub", async () => {
    const githubService = makeGithubService();
    const { service } = buildService({ githubService });

    await expect(service.createGithubStack({
      repo: REPO,
      pullRequests: [964, 965.5],
    })).rejects.toThrow("2 to 100 distinct pull request numbers");
    expect(githubService.apiRequest).not.toHaveBeenCalled();
  });

  it("removes a dissolved GitHub stack after unstack returns no content", async () => {
    const db = makeMockDb();
    const githubService = makeGithubService({
      apiRequest: vi.fn(async () => ({
        data: {},
        response: new Response(null, { status: 204 }),
      })),
    });
    const { service } = buildService({ db, githubService });

    await expect(service.unstackGithubStack({
      repo: REPO,
      stackNumber: 19,
    })).resolves.toBeNull();

    expect(githubService.apiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: `/repos/${REPO.owner}/${REPO.name}/stacks/19/unstack`,
    });
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("delete from github_pr_stacks"),
      ["proj-1", REPO.owner, REPO.name, 19],
    );
  });

  it("emits a PR update when an unmapped pull request changes its projection", async () => {
    const db = makeMockDb();
    const { service } = buildService({ db, laneService: makeLaneService([]) });
    const events: unknown[] = [];
    service.setEventEmitter((event) => events.push(event));

    const result = await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-unmapped",
      payload: {
        action: "opened",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        pull_request: makeUnmappedBranchPull(),
      },
    });

    expect(result).toEqual(expect.objectContaining({
      processed: true,
      duplicate: false,
      githubPrNumber: 404,
      linkedPrIds: [],
    }));
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_projections"),
      expect.arrayContaining([REPO.owner, REPO.name, 404]),
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "prs-updated",
      prs: [],
    }));
  });

  it("invalidates exact state totals and refreshes them on the projected webhook read", async () => {
    let countRequests = 0;
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/graphql") {
          countRequests += 1;
          return {
            data: {
              data: {
                repository: {
                  open: { totalCount: 1 },
                  merged: { totalCount: countRequests },
                  closed: { totalCount: 0 },
                },
              },
            },
          };
        }
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          return { data: [makeGitHubPull()] };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const projectionRow = {
      project_id: "proj-1", repo_owner: REPO.owner, repo_name: REPO.name,
      github_pr_number: 404, github_node_id: "PR_projection_404",
      github_url: "https://github.com/test-owner/test-repo/pull/404",
      title: "Projected PR", state: "merged", is_draft: 0,
      base_branch: "main", head_branch: "feature/unmapped",
      head_repo_owner: REPO.owner, head_repo_name: REPO.name,
      head_sha: "head-sha", base_sha: "base-sha", author: "octocat",
      labels_json: "[]", is_bot: 0, comment_count: 0,
      created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z",
      synced_at: "2026-05-02T00:00:01Z", last_event_name: "pull_request",
      last_delivery_id: "delivery-counts",
    };
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) =>
      String(sql).includes("from github_pr_projections") ? [projectionRow] : []);
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });

    const first = await service.getGithubSnapshot({ force: true, includeStateCounts: true });
    expect(first.history?.repoPullRequestCounts?.merged).toBe(1);

    await service.ingestGithubWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-count-refresh",
      payload: {
        action: "closed",
        repository: {
          full_name: `${REPO.owner}/${REPO.name}`,
          owner: { login: REPO.owner },
          name: REPO.name,
        },
        pull_request: makeUnmappedBranchPull({ state: "closed", merged_at: "2026-05-03T00:00:00Z" }),
      },
    });

    const refreshed = await service.getGithubSnapshot({
      includeStateCounts: true,
      revalidate: false,
    });
    expect(refreshed.history?.repoPullRequestCounts?.merged).toBe(2);
    expect(countRequests).toBe(2);
  });
});

describe("prService.listWithConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("batches conflict analysis against all active lanes, including non-PR peers", async () => {
    const prLane = makeFakeLane({ id: "lane-pr", name: "PR lane" });
    const peerLane = makeFakeLane({ id: "lane-peer", name: "Peer lane" });
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) => {
      if (String(sql).includes("from pull_requests")) {
        return [makePrRow({ id: "pr-1", lane_id: "lane-pr" })];
      }
      return [];
    });
    const conflictService = {
      getBatchAssessment: vi.fn(async () => ({
        lanes: [
          { laneId: "lane-pr", status: "conflict-predicted", overlappingFileCount: 1 },
          { laneId: "lane-peer", status: "clean", overlappingFileCount: 1 },
        ],
        matrix: [
          { laneAId: "lane-pr", laneBId: "lane-peer", riskLevel: "high", overlapCount: 1 },
        ],
        overlaps: [
          { laneAId: "lane-pr", laneBId: "lane-peer", files: ["src/shared.ts"] },
        ],
      })),
    };
    const laneService = makeLaneService([prLane, peerLane]);
    const { service } = buildService({ db, laneService, conflictService });

    const rows = await service.listWithConflicts({ includeConflictAnalysis: true });

    expect(laneService.list).toHaveBeenCalledWith({ includeArchived: false, includeStatus: false });
    expect(conflictService.getBatchAssessment).toHaveBeenCalledWith({ lanes: [prLane, peerLane] });
    expect(rows[0]?.conflictAnalysis).toEqual(expect.objectContaining({
      prId: "pr-1",
      laneId: "lane-pr",
      riskLevel: "high",
      overlapCount: 1,
      conflictPredicted: true,
      peerConflicts: [
        {
          peerId: "lane-peer",
          peerName: "Peer lane",
          riskLevel: "high",
          overlapFiles: ["src/shared.ts"],
        },
      ],
    }));
  });

  it("logs when batched conflict analysis falls back to null results", async () => {
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) => {
      if (String(sql).includes("from pull_requests")) {
        return [makePrRow({ id: "pr-1", lane_id: "lane-pr" })];
      }
      return [];
    });
    const conflictService = {
      getBatchAssessment: vi.fn(async () => {
        throw new Error("batch failed");
      }),
    };
    const { service, logger } = buildService({
      db,
      laneService: makeLaneService([makeFakeLane({ id: "lane-pr" })]),
      conflictService,
    });

    const rows = await service.listWithConflicts({ includeConflictAnalysis: true });

    expect(rows[0]?.conflictAnalysis).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("prs.batch_conflict_analysis_failed", { error: "batch failed" });
  });

  it("defaults to listing PRs without conflict analysis", async () => {
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) => {
      if (String(sql).includes("from pull_requests")) {
        return [makePrRow({ id: "pr-1", lane_id: "lane-pr" })];
      }
      return [];
    });
    const conflictService = {
      getBatchAssessment: vi.fn(async () => ({ lanes: [], matrix: [], overlaps: [] })),
    };
    const { service } = buildService({
      db,
      laneService: makeLaneService([makeFakeLane({ id: "lane-pr" })]),
      conflictService,
    });

    const rows = await service.listWithConflicts();

    expect(rows[0]?.conflictAnalysis).toBeNull();
    expect(conflictService.getBatchAssessment).not.toHaveBeenCalled();
  });

  it("includes cached GitHub mergeability fields in list rows", async () => {
    const db = makeMockDb();
    db.all.mockImplementation((sql: string) => {
      if (String(sql).includes("from pull_requests")) {
        return [makePrRow({ id: "pr-1", lane_id: "lane-pr", merge_conflicts: 1, behind_base_by: 3 })];
      }
      return [];
    });
    const { service } = buildService({ db });

    const rows = await service.listWithConflicts();

    expect(rows[0]).toEqual(expect.objectContaining({
      mergeConflicts: true,
      behindBaseBy: 3,
      conflictAnalysis: null,
    }));
  });
});

describe("prService.getStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns promptly without polling when GitHub mergeability is unknown", async () => {
    // getStatus must stay cheap so the renderer can re-poll: it does NOT block on
    // the long mergeability wait. When mergeability is still unknown it flags
    // `mergeabilityComputing` and returns after a single fetch.
    const row = makePrRow({ id: "pr-status", github_pr_number: 90 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    let pullFetches = 0;
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { method?: string; path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/90") {
          pullFetches += 1;
          return {
            data: makeGitHubPull({
              number: 90,
              html_url: row.github_url,
              title: row.title,
              mergeable: null,
              mergeable_state: "unknown",
              head: { ref: "my-feature", sha: "head-sha" },
              base: { ref: "main", sha: "base-sha" },
            }),
          };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha/status") {
          return { data: { state: "success", statuses: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/pulls/90/reviews") {
          return { data: [] };
        }
        if (args.path === "/repos/test-owner/test-repo/compare/base-sha...head-sha") {
          return { data: { behind_by: 2 } };
        }
        // Authoritative merge box still computing.
        if (args.method === "POST" && args.path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  viewerPermission: "WRITE",
                  pullRequest: {
                    mergeable: "UNKNOWN",
                    mergeStateStatus: "UNKNOWN",
                    reviewDecision: null,
                    headRefOid: "head-sha",
                    baseRef: { branchProtectionRule: null },
                    latestOpinionatedReviews: { nodes: [] },
                  },
                },
              },
            },
          };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const status = await service.getStatus("pr-status");

    expect(pullFetches).toBe(1);
    expect(status).toEqual(expect.objectContaining({
      behindBaseBy: 2,
      mergeStateStatus: "unknown",
      mergeabilityComputing: true,
      isMergeable: false,
    }));
  });

  it("maps the authoritative GraphQL merge box into status", async () => {
    const row = makePrRow({ id: "pr-mergebox", github_pr_number: 95 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { method?: string; path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/95") {
          return {
            data: makeGitHubPull({
              number: 95,
              html_url: row.github_url,
              title: row.title,
              // REST mergeable disagrees; GraphQL merge box should win.
              mergeable: false,
              mergeable_state: "blocked",
              head: { ref: "my-feature", sha: "head-95" },
              base: { ref: "main", sha: "base-95" },
            }),
          };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-95/status") {
          return { data: { state: "success", statuses: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-95/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/pulls/95/reviews") {
          return { data: [] };
        }
        if (args.path === "/repos/test-owner/test-repo/compare/base-95...head-95") {
          return { data: { behind_by: 0 } };
        }
        if (args.method === "POST" && args.path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  viewerPermission: "ADMIN",
                  pullRequest: {
                    mergeable: "MERGEABLE",
                    mergeStateStatus: "UNSTABLE",
                    reviewDecision: "APPROVED",
                    headRefOid: "head-95",
                    baseRef: { branchProtectionRule: { requiredApprovingReviewCount: 1 } },
                    latestOpinionatedReviews: {
                      nodes: [{ state: "APPROVED" }, { state: "COMMENTED" }],
                    },
                  },
                },
              },
            },
          };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const status = await service.getStatus("pr-mergebox");

    expect(status).toEqual(expect.objectContaining({
      mergeStateStatus: "unstable",
      reviewDecision: "approved",
      approvalsCount: 1,
      requiredApprovals: 1,
      canBypass: true,
      headSha: "head-95",
      mergeabilityComputing: false,
      // `unstable` is mergeable even though REST said blocked/false.
      isMergeable: true,
    }));
  });

  it("retries merge-state GraphQL without stack fields when the schema is unavailable", async () => {
    const row = makePrRow({ id: "pr-mergebox-fallback", github_pr_number: 97 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const graphqlQueries: string[] = [];
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { method?: string; path: string; body?: unknown }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/97") {
          return {
            data: makeGitHubPull({
              number: 97,
              html_url: row.github_url,
              title: row.title,
              mergeable: false,
              mergeable_state: "blocked",
              head: { ref: "my-feature", sha: "head-97" },
              base: { ref: "main", sha: "base-97" },
            }),
          };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-97/status") {
          return { data: { state: "success", statuses: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-97/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/pulls/97/reviews") {
          return { data: [] };
        }
        if (args.path === "/repos/test-owner/test-repo/compare/base-97...head-97") {
          return { data: { behind_by: 0 } };
        }
        if (args.method === "POST" && args.path === "/graphql") {
          const query = String((args.body as { query?: unknown } | undefined)?.query ?? "");
          graphqlQueries.push(query);
          if (query.includes("stack { baseRefName }")) {
            throw new Error("Field 'stack' doesn't exist on type 'PullRequest'");
          }
          return {
            data: {
              data: {
                repository: {
                  viewerPermission: "WRITE",
                  pullRequest: {
                    mergeable: "MERGEABLE",
                    mergeStateStatus: "CLEAN",
                    reviewDecision: null,
                    headRefOid: "head-97",
                    baseRefName: "main",
                    baseRef: { branchProtectionRule: null },
                    latestOpinionatedReviews: { nodes: [] },
                  },
                },
              },
            },
          };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const status = await service.getStatus("pr-mergebox-fallback");

    expect(graphqlQueries).toHaveLength(2);
    expect(graphqlQueries[0]).toContain("stack { baseRefName }");
    expect(graphqlQueries[1]).not.toContain("stack { baseRefName }");
    expect(status).toEqual(expect.objectContaining({
      mergeStateStatus: "clean",
      isMergeable: true,
      headSha: "head-97",
    }));
  });

  it("uses the ultimate stack base for required approvals", async () => {
    const row = makePrRow({ id: "pr-stacked-mergebox", github_pr_number: 96 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    let graphqlCalls = 0;
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { method?: string; path: string; body?: unknown }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/96") {
          return {
            data: makeGitHubPull({
              number: 96,
              html_url: row.github_url,
              title: row.title,
              mergeable: true,
              mergeable_state: "clean",
              head: { ref: "stack/ui", sha: "head-96" },
              base: { ref: "stack/core", sha: "base-96" },
            }),
          };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-96/status") {
          return { data: { state: "success", statuses: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-96/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/pulls/96/reviews") {
          return { data: [] };
        }
        if (args.path === "/repos/test-owner/test-repo/compare/base-96...head-96") {
          return { data: { behind_by: 0 } };
        }
        if (args.method === "POST" && args.path === "/graphql") {
          graphqlCalls += 1;
          if (graphqlCalls === 1) {
            return {
              data: {
                data: {
                  repository: {
                    viewerPermission: "WRITE",
                    pullRequest: {
                      mergeable: "MERGEABLE",
                      mergeStateStatus: "CLEAN",
                      reviewDecision: null,
                      headRefOid: "head-96",
                      baseRefName: "stack/core",
                      baseRef: { branchProtectionRule: { requiredApprovingReviewCount: 0 } },
                      stack: { baseRefName: "main" },
                      latestOpinionatedReviews: { nodes: [] },
                    },
                  },
                },
              },
            };
          }
          expect(args.body).toEqual(expect.objectContaining({
            variables: expect.objectContaining({
              qualifiedName: "refs/heads/main",
            }),
          }));
          return {
            data: {
              data: {
                repository: {
                  ref: {
                    branchProtectionRule: { requiredApprovingReviewCount: 2 },
                  },
                },
              },
            },
          };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const status = await service.getStatus("pr-stacked-mergebox");

    expect(graphqlCalls).toBe(2);
    expect(status.requiredApprovals).toBe(2);
  });

  it("keeps behindBaseBy unknown when GitHub compare fails", async () => {
    const row = makePrRow({ id: "pr-status-compare-failed", github_pr_number: 91 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/91") {
          return {
            data: makeGitHubPull({
              number: 91,
              html_url: row.github_url,
              title: row.title,
              mergeable: true,
              mergeable_state: "clean",
              head: { ref: "my-feature", sha: "head-sha" },
              base: { ref: "main", sha: "base-sha" },
            }),
          };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha/status") {
          return { data: { state: "success", statuses: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/pulls/91/reviews") {
          return { data: [] };
        }
        if (args.path === "/repos/test-owner/test-repo/compare/base-sha...head-sha") {
          throw new Error("compare unavailable");
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const status = await service.getStatus("pr-status-compare-failed");

    expect(status.behindBaseBy).toBeNull();
    const updateCall = db.run.mock.calls.find(([sql]: [unknown]) =>
      String(sql).includes("update pull_requests")
      && String(sql).includes("behind_base_by")
    );
    const updateParams = updateCall?.[1] as unknown[] | undefined;
    expect(updateParams?.slice(-4, -2)).toEqual([1, null]);
  });
});

describe("prService.refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRefreshDb(rows: ReturnType<typeof makePrRow>[]) {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes("from pull_requests") && text.includes("where id = ?")) {
        return rows.find((row) => row.id === params[0]) ?? null;
      }
      if (text.includes("from pull_requests") && text.includes("where lane_id = ?")) {
        return rows.find((row) =>
          row.lane_id === params[0]
          && row.project_id === params[1]
          && row.head_branch === params[2]
        ) ?? null;
      }
      return null;
    });
    db.all.mockImplementation((sql: string, params: unknown[]) => {
      if (String(sql).includes("from pull_requests") && String(sql).includes("where project_id = ?")) {
        return rows.filter((row) => row.project_id === params[0]);
      }
      return [];
    });
    return db;
  }

  function makeRefreshGithubService(failingPrNumbers = new Set<number>()) {
    return makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        const path = args.path;
        const prMatch = path.match(/\/pulls\/(\d+)$/);
        if (prMatch) {
          const prNumber = Number(prMatch[1]);
          if (failingPrNumbers.has(prNumber)) {
            throw new Error(`refresh failed for #${prNumber}`);
          }
          return {
            data: makeGitHubPull({
              number: prNumber,
              title: `Fresh #${prNumber}`,
              head: { ref: `feature/pr-${prNumber}`, sha: `sha-${prNumber}` },
              additions: 10,
              deletions: 2,
            }),
          };
        }
        if (/\/commits\/sha-\d+\/status$/.test(path)) {
          return { data: { state: "success", statuses: [] } };
        }
        if (/\/commits\/sha-\d+\/check-runs$/.test(path)) {
          return { data: { check_runs: [] } };
        }
        if (/\/pulls\/\d+\/reviews$/.test(path)) {
          return { data: [] };
        }
        throw new Error(`Unexpected GitHub API path: ${path}`);
      }),
    });
  }

  it("emits and syncs the existing projection only after a material change", async () => {
    const row = makePrRow({
      id: "pr-material",
      github_pr_number: 90,
      created_at: "2026-06-01T00:00:00Z",
    });
    const db = makeRefreshDb([row]);
    let merged = false;
    const githubCreatedAt = "2025-01-02T03:04:05Z";
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/90") {
          return {
            data: makeGitHubPull({
              number: 90,
              node_id: row.github_node_id,
              html_url: row.github_url,
              title: row.title,
              state: merged ? "closed" : "open",
              merged_at: merged ? "2026-07-15T00:00:00Z" : null,
              head: { ref: row.head_branch, sha: "head-sha-material" },
              base: { ref: row.base_branch },
              additions: row.additions,
              deletions: row.deletions,
              created_at: githubCreatedAt,
              updated_at: row.updated_at,
            }),
          };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha-material/status") {
          return { data: { state: "", statuses: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha-material/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/pulls/90/reviews") {
          return { data: [] };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });
    const events: unknown[] = [];
    service.setEventEmitter((event) => events.push(event));

    await service.refresh({ prId: row.id });

    expect(events.filter((event: any) => event.type === "prs-updated")).toHaveLength(0);
    expect(db.run).not.toHaveBeenCalledWith(
      expect.stringContaining("update github_pr_projections"),
      expect.anything(),
    );
    const initialUpsert = db.run.mock.calls.find(([sql]: [unknown]) =>
      String(sql).includes("update pull_requests") && String(sql).includes("created_at = ?")
    );
    expect(initialUpsert?.[1]?.[15]).toBe(githubCreatedAt);

    db.run.mockClear();
    merged = true;
    await service.refresh({ prId: row.id });

    expect(events.filter((event: any) => event.type === "prs-updated")).toHaveLength(1);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("update github_pr_projections"),
      [
        "merged",
        0,
        row.title,
        row.updated_at,
        expect.any(String),
        "proj-1",
        REPO.owner,
        REPO.name,
        90,
      ],
    );
    expect(db.run).not.toHaveBeenCalledWith(
      expect.stringContaining("insert into github_pr_projections"),
      expect.anything(),
    );
  });

  it("logs and caches pending mergeability when retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const row = makePrRow({ id: "pr-stale", github_pr_number: 90, merge_conflicts: 0 });
      const db = makeMockDb();
      installPullRequestRowStore(db, [row]);
      const githubService = makeGithubService({
        apiRequest: vi.fn(async (args: { path: string }) => {
          if (args.path === "/repos/test-owner/test-repo/pulls/90") {
            return {
              data: makeGitHubPull({
                number: 90,
                html_url: row.github_url,
                title: row.title,
                mergeable: null,
                mergeable_state: "unknown",
                head: { ref: "my-feature", sha: "head-sha" },
              }),
            };
          }
          if (args.path === "/repos/test-owner/test-repo/commits/head-sha/status") {
            return { data: { state: "success", statuses: [] } };
          }
          if (args.path === "/repos/test-owner/test-repo/commits/head-sha/check-runs") {
            return { data: { check_runs: [] } };
          }
          if (args.path === "/repos/test-owner/test-repo/pulls/90/reviews") {
            return { data: [] };
          }
          throw new Error(`Unexpected GitHub API path: ${args.path}`);
        }),
      });
      const { service, logger } = buildService({ db, githubService });

      const refreshPromise = service.refresh({ prId: "pr-stale" });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(3_500);
      await refreshPromise;

      expect(logger.warn).toHaveBeenCalledWith("prs.mergeability_poll_exhausted", {
        repo: "test-owner/test-repo",
        prNumber: 90,
        attempts: 4,
        mergeableState: "unknown",
      });
      const updateCall = db.run.mock.calls.find(([sql]: [unknown]) =>
        String(sql).includes("update pull_requests")
        && String(sql).includes("merge_conflicts")
        && String(sql).includes("behind_base_by")
      );
      const updateParams = updateCall?.[1] as unknown[] | undefined;
      expect(updateParams?.slice(-6)).toEqual([1, null, 0, null, "pr-stale", "proj-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for mergeability on terminal PR refreshes", async () => {
    const row = makePrRow({ id: "pr-merged", github_pr_number: 90, merge_conflicts: 0 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    let pullFetches = 0;
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/90") {
          pullFetches += 1;
          return {
            data: makeGitHubPull({
              number: 90,
              html_url: row.github_url,
              title: row.title,
              state: "closed",
              merged_at: "2026-01-03T00:00:00Z",
              mergeable: null,
              mergeable_state: "unknown",
              head: { ref: "my-feature", sha: "head-sha" },
            }),
          };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha/status") {
          return { data: { state: "success", statuses: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/commits/head-sha/check-runs") {
          return { data: { check_runs: [] } };
        }
        if (args.path === "/repos/test-owner/test-repo/pulls/90/reviews") {
          return { data: [] };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service, logger } = buildService({ db, githubService });

    const refreshed = await service.refresh({ prId: "pr-merged" });

    expect(pullFetches).toBe(1);
    expect(githubService.apiRequest).toHaveBeenCalledTimes(1);
    expect(refreshed[0]).toEqual(expect.objectContaining({ id: "pr-merged", state: "merged" }));
    expect(logger.warn).not.toHaveBeenCalledWith("prs.mergeability_poll_exhausted", expect.anything());
  });

  it("keeps successful explicit PR refreshes when a sibling fails", async () => {
    const okRow = makePrRow({ id: "pr-ok", github_pr_number: 90 });
    const failingRow = makePrRow({ id: "pr-bad", github_pr_number: 91 });
    const { service, logger } = buildService({
      db: makeRefreshDb([okRow, failingRow]),
      githubService: makeRefreshGithubService(new Set([91])),
    });

    const refreshed = await service.refresh({ prIds: ["pr-ok", "pr-bad"] });

    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toEqual(expect.objectContaining({
      id: "pr-ok",
      githubPrNumber: 90,
      title: "Fresh #90",
    }));
    expect(logger.warn).toHaveBeenCalledWith("prs.refresh_failed", {
      prId: "pr-bad",
      error: "refresh failed for #91",
    });
  });

  it("rejects explicit multi-PR refreshes when every PR fails", async () => {
    const firstRow = makePrRow({ id: "pr-bad-1", github_pr_number: 91 });
    const secondRow = makePrRow({ id: "pr-bad-2", github_pr_number: 92 });
    const { service, logger } = buildService({
      db: makeRefreshDb([firstRow, secondRow]),
      githubService: makeRefreshGithubService(new Set([91, 92])),
    });

    await expect(service.refresh({ prIds: ["pr-bad-1", "pr-bad-2"] })).rejects.toThrow("refresh failed for #91");
    expect(logger.warn).toHaveBeenCalledWith("prs.refresh_failed", {
      prId: "pr-bad-1",
      error: "refresh failed for #91",
    });
    expect(logger.warn).toHaveBeenCalledWith("prs.refresh_failed", {
      prId: "pr-bad-2",
      error: "refresh failed for #92",
    });
  });

  it("still rejects explicit single-PR refresh failures", async () => {
    const failingRow = makePrRow({ id: "pr-bad", github_pr_number: 91 });
    const { service, logger } = buildService({
      db: makeRefreshDb([failingRow]),
      githubService: makeRefreshGithubService(new Set([91])),
    });

    await expect(service.refresh({ prId: "pr-bad" })).rejects.toThrow("refresh failed for #91");
    expect(logger.warn).toHaveBeenCalledWith("prs.refresh_failed", {
      prId: "pr-bad",
      error: "refresh failed for #91",
    });
  });
});

describe("prService.linkToLane", () => {
  it("stores GitHub creation time while preserving link-time update semantics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    try {
      const db = makeMockDb();
      installPullRequestRowStore(db);
      const githubCreatedAt = "2024-03-04T05:06:07Z";
      const pull = makeGitHubPull({
        number: 90,
        node_id: "PR_linked_90",
        html_url: "https://github.com/test-owner/test-repo/pull/90",
        title: "Adopted PR",
        body: "",
        created_at: githubCreatedAt,
        updated_at: "2026-07-15T00:00:00Z",
        base: {
          ref: "main",
          repo: { owner: { login: REPO.owner }, name: REPO.name },
        },
        head: { ref: "my-feature" },
      });
      const githubService = makeGithubService({
        apiRequest: vi.fn(async (args: { method: string; path: string }) => {
          if (args.method === "GET" && args.path === "/repos/test-owner/test-repo/pulls/90") {
            return { data: { ...pull } };
          }
          if (args.method === "PATCH" && args.path === "/repos/test-owner/test-repo/pulls/90") {
            return { data: { ...pull } };
          }
          if (args.method === "GET" && args.path === "/repos/test-owner/test-repo/pulls/90/reviews") {
            return { data: [] };
          }
          throw new Error(`Unexpected GitHub API request: ${args.method} ${args.path}`);
        }),
      });
      const { service } = buildService({ db, githubService });

      await service.linkToLane({ laneId: LANE_ID, prUrlOrNumber: "90" });

      const insertCall = db.run.mock.calls.find(([sql]: [unknown]) =>
        String(sql).includes("insert into pull_requests(")
      );
      expect(insertCall?.[1]?.[17]).toBe(githubCreatedAt);
      expect(insertCall?.[1]?.[18]).toBe("2026-07-16T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("prService.getActionRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bounds action run history and only hydrates jobs for the newest runs", async () => {
    const row = makePrRow({ id: "pr-actions", github_pr_number: 90 });
    const db = makeMockDb();
    db.get.mockImplementation((sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes("from pull_requests") && text.includes("where id = ?")) {
        return params[0] === row.id ? row : null;
      }
      return null;
    });
    const workflowRuns = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `run-${index + 1}`,
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/test-owner/test-repo/actions/runs/${index + 1}`,
      created_at: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
      updated_at: `2026-01-01T00:${String(index).padStart(2, "0")}:30Z`,
    })).reverse();
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/90") {
          return { data: makeGitHubPull({ number: 90, head: { ref: "my-feature", sha: "head-sha" } }) };
        }
        if (args.path === "/repos/test-owner/test-repo/actions/runs") {
          return { data: { workflow_runs: workflowRuns } };
        }
        const jobMatch = args.path.match(/\/actions\/runs\/(\d+)\/jobs$/);
        if (jobMatch) {
          const runId = Number(jobMatch[1]);
          return {
            data: {
              jobs: [{
                id: runId * 100,
                name: `job-${runId}`,
                status: "completed",
                conclusion: "success",
                steps: [],
              }],
            },
          };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const runs = await service.getActionRuns("pr-actions");

    expect(runs).toHaveLength(12);
    expect(runs[0]?.jobs).toHaveLength(1);
    expect(runs[5]?.jobs).toHaveLength(1);
    expect(runs[6]?.jobs).toHaveLength(0);
    const calls: Array<{ path: string; query?: Record<string, unknown> }> =
      (githubService.apiRequest as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) =>
        call[0] as { path: string; query?: Record<string, unknown> }
      );
    expect(calls.find((call) => call.path === "/repos/test-owner/test-repo/actions/runs")?.query).toEqual({
      head_sha: "head-sha",
      per_page: 12,
    });
    expect(calls.filter((call) => /\/actions\/runs\/\d+\/jobs$/.test(call.path)).map((call) => call.path)).toEqual([
      "/repos/test-owner/test-repo/actions/runs/20/jobs",
      "/repos/test-owner/test-repo/actions/runs/19/jobs",
      "/repos/test-owner/test-repo/actions/runs/18/jobs",
      "/repos/test-owner/test-repo/actions/runs/17/jobs",
      "/repos/test-owner/test-repo/actions/runs/16/jobs",
      "/repos/test-owner/test-repo/actions/runs/15/jobs",
    ]);
  });
});

describe("prService.getCheckLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to download a job log that does not belong to the requested PR", async () => {
    const row = makePrRow({ id: "pr-actions", github_pr_number: 90 });
    const db = makeMockDb();
    db.get.mockImplementation((sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes("from pull_requests") && text.includes("where id = ?")) {
        return params[0] === row.id ? row : null;
      }
      return null;
    });
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/90") {
          return { data: makeGitHubPull({ number: 90, head: { ref: "my-feature", sha: "head-sha" } }) };
        }
        if (args.path === "/repos/test-owner/test-repo/actions/runs") {
          return {
            data: {
              workflow_runs: [{
                id: 7,
                name: "CI",
                status: "completed",
                conclusion: "failure",
                head_sha: "head-sha",
                html_url: "https://github.com/test-owner/test-repo/actions/runs/7",
                created_at: "2026-07-27T11:55:00.000Z",
                updated_at: "2026-07-27T11:59:00.000Z",
              }],
            },
          };
        }
        if (args.path === "/repos/test-owner/test-repo/actions/runs/7/jobs") {
          return {
            data: {
              jobs: [{
                id: 111,
                name: "build",
                status: "completed",
                conclusion: "failure",
                steps: [],
              }],
            },
          };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { service, logger } = buildService({ db, githubService });

      const excerpt = await service.getCheckLog({ prId: "pr-actions", jobId: 999 });

      expect(excerpt).toMatchObject({ jobId: 999, jobName: "", lines: [], htmlUrl: null });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith("prs.check_log_job_outside_pr", {
        prId: "pr-actions",
        jobId: 999,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("prService.rerunChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Actions job endpoint for jobs and the Checks endpoint for check runs", async () => {
    const row = makePrRow({ id: "pr-actions", github_pr_number: 90 });
    const db = makeMockDb();
    db.get.mockImplementation((sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes("from pull_requests") && text.includes("where id = ?")) {
        return params[0] === row.id ? row : null;
      }
      return null;
    });
    const githubService = makeGithubService({
      apiRequest: vi.fn(async () => ({ data: {} })),
    });
    const { service } = buildService({ db, githubService });

    await service.rerunChecks({ prId: "pr-actions", actionJobIds: [77] });
    await service.rerunChecks({ prId: "pr-actions", checkRunIds: [88] });

    const rerunCalls = githubService.apiRequest.mock.calls
      .map(([request]: [{ method?: string; path?: string; body?: unknown }]) => request)
      .filter((request: { method?: string; path?: string }) =>
        request.method === "POST" && (request.path?.includes("/rerun") || request.path?.includes("/rerequest"))
      );
    expect(rerunCalls).toEqual([
      {
        method: "POST",
        path: "/repos/test-owner/test-repo/actions/jobs/77/rerun",
        body: {},
      },
      {
        method: "POST",
        path: "/repos/test-owner/test-repo/check-runs/88/rerequest",
        body: {},
      },
    ]);
    expect(rerunCalls.some((request: { path?: string }) => request.path?.includes("check-runs/77"))).toBe(false);
    expect(rerunCalls.some((request: { path?: string }) => request.path?.includes("actions/jobs/88"))).toBe(false);
  });
});

describe("prService coordinate-based detail (unmapped PRs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches detail / files / commits / action runs purely from GitHub without a DB row", async () => {
    // No row exists for these coordinates — db.get always returns null so any
    // accidental requireRow() call would throw "PR not found".
    const db = makeMockDb();
    db.get.mockImplementation(() => null);
    db.all.mockImplementation(() => []);

    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/repos/up-owner/up-repo/pulls/77") {
          return {
            data: makeGitHubPull({
              number: 77,
              body: "Unmapped body",
              head: { ref: "fork-feature", sha: "head-sha" },
            }),
          };
        }
        if (args.path === "/repos/up-owner/up-repo/pulls/77/files") {
          return { data: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }] };
        }
        if (args.path === "/repos/up-owner/up-repo/pulls/77/commits") {
          // No top-level `author` (email not linked to a GitHub account) → the
          // commit avatar must fall back to a Gravatar identicon from the email.
          return { data: [{ sha: "abcdef1", commit: { message: "fix", author: { email: "Dev@Example.com", date: "2026-01-01T00:00:00Z" } } }] };
        }
        if (args.path === "/repos/up-owner/up-repo/actions/runs") {
          return { data: { workflow_runs: [] } };
        }
        if (/\/commits\/.+\/check-runs/.test(args.path)) {
          return { data: { check_runs: [] } };
        }
        throw new Error(`Unexpected GitHub API path: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });
    const coords = { repoOwner: "up-owner", repoName: "up-repo", githubPrNumber: 77 };

    const detail = await service.getDetailByGithub(coords);
    expect(detail.body).toBe("Unmapped body");
    // Synthetic stable id derived from coordinates.
    expect(detail.prId).toBe("gh:up-owner/up-repo#77");

    const files = await service.getFilesByGithub(coords);
    expect(files).toEqual([
      { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: null, previousFilename: null },
    ]);

    const commits = await service.getCommitsByGithub(coords);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.shortSha).toBe("abcdef1");
    // Gravatar identicon fallback, keyed on the lowercased+trimmed email.
    const gravatarHash = createHash("md5").update("dev@example.com").digest("hex");
    expect(commits[0]?.author.avatarUrl).toBe(`https://www.gravatar.com/avatar/${gravatarHash}?d=identicon&s=80`);

    const runs = await service.getActionRunsByGithub(coords);
    expect(runs).toEqual([]);

    // requireRow would have thrown; reaching here proves the row was never required.
  });

  it("returns a complete unmapped header and marks failed sidecars as unavailable", async () => {
    const db = makeMockDb();
    db.get.mockImplementation(() => null);
    db.all.mockImplementation(() => []);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === "/repos/up-owner/up-repo/pulls/77") {
          return {
            data: makeGitHubPull({
              number: 77,
              title: "Unmapped header",
              body: "Unmapped body",
              html_url: "https://github.com/up-owner/up-repo/pull/77",
              base: { ref: "main" },
              head: { ref: "fork-feature", sha: "head-sha" },
            }),
          };
        }
        throw new Error(`Unavailable test sidecar: ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const result = await service.getMobileGithubDetail({
      repoOwner: "up-owner",
      repoName: "up-repo",
      githubPrNumber: 77,
    });

    expect(result.item).toEqual(expect.objectContaining({
      title: "Unmapped header",
      githubPrNumber: 77,
      githubUrl: "https://github.com/up-owner/up-repo/pull/77",
      baseBranch: "main",
      headBranch: "fork-feature",
    }));
    expect(result.snapshot.detail?.body).toBe("Unmapped body");
    expect(result.unavailableParts).toEqual(expect.arrayContaining([
      "action_runs",
      "comments",
      "commits",
      "files",
      "review_threads",
      "timeline",
    ]));
  });
});

describe("prService merge contexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves target lanes by branch name when lane refs include refs/heads prefixes", async () => {
    const sourceLane = makeFakeLane({ id: "lane-feature", branchRef: "refs/heads/feature/pr" });
    const targetLane = makeFakeLane({ id: "lane-main", branchRef: "refs/heads/main", name: "Main" });
    const row = makePrRow({ id: "pr-1", lane_id: sourceLane.id, base_branch: "main", head_branch: "feature/pr" });
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("from pull_requests")) return row;
      if (text.includes("from pr_group_members")) return null;
      return null;
    });
    db.all.mockImplementation((sql: string) => {
      if (String(sql).includes("from pull_requests")) return [row];
      return [];
    });
    const { service } = buildService({ db, laneService: makeLaneService([sourceLane, targetLane]) });

    await expect(service.getMergeContext("pr-1")).resolves.toEqual(expect.objectContaining({
      targetLaneId: "lane-main",
    }));
    await expect(service.getMergeContexts(["pr-1"])).resolves.toEqual({
      "pr-1": expect.objectContaining({ targetLaneId: "lane-main" }),
    });
  });

  it("uses the same group assembly for single and bulk merge-context reads", async () => {
    const sourceLane = makeFakeLane({ id: "lane-source", branchRef: "refs/heads/feature/pr", name: "Feature" });
    const integrationLane = makeFakeLane({ id: "lane-integration", branchRef: "refs/heads/integration/pr", name: "Integration" });
    const targetLane = makeFakeLane({ id: "lane-main", branchRef: "refs/heads/main", name: "Main" });
    const row = makePrRow({ id: "pr-1", lane_id: sourceLane.id, base_branch: "main", head_branch: "feature/pr" });
    const group = { group_id: "group-1", group_type: "integration" as const };
    const memberRows = [
      {
        group_id: group.group_id,
        pr_id: "pr-1",
        lane_id: sourceLane.id,
        position: 0,
        role: "source",
        lane_name: sourceLane.name,
        pr_number: 90,
      },
      {
        group_id: group.group_id,
        pr_id: "pr-integration",
        lane_id: integrationLane.id,
        position: 1,
        role: "integration",
        lane_name: integrationLane.name,
        pr_number: 91,
      },
    ];
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("from pull_requests")) return row;
      if (text.includes("from pr_group_members")) return group;
      return null;
    });
    db.all.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("from pull_requests")) return [row];
      if (text.includes("from pr_group_members") && text.includes("join pr_groups")) {
        return [{ ...group, pr_id: row.id }];
      }
      if (text.includes("from pr_group_members")) return memberRows;
      return [];
    });
    const { service } = buildService({
      db,
      laneService: makeLaneService([sourceLane, integrationLane, targetLane]),
    });

    const single = await service.getMergeContext("pr-1");
    const bulk = await service.getMergeContexts(["pr-1"]);

    expect(bulk["pr-1"]).toEqual(single);
    const allDbCalls = db.all.mock.calls as Array<[unknown, ...unknown[]]>;
    expect(allDbCalls.some(([sql]) => String(sql).includes("row_number() over"))).toBe(true);
    expect(single).toEqual(expect.objectContaining({
      groupId: group.group_id,
      groupType: "integration",
      sourceLaneIds: [sourceLane.id],
      targetLaneId: targetLane.id,
      integrationLaneId: integrationLane.id,
    }));
  });

  it("returns empty merge contexts for requested PR ids missing from storage", async () => {
    const db = makeMockDb();
    db.get.mockReturnValue(null);
    db.all.mockImplementation((sql: string) => {
      if (String(sql).includes("from pull_requests")) return [];
      return [];
    });
    const { service } = buildService({ db, laneService: makeLaneService([]) });

    await expect(service.getMergeContext("external-pr")).resolves.toEqual({
      prId: "external-pr",
      groupId: null,
      groupType: null,
      sourceLaneIds: [],
      targetLaneId: null,
      integrationLaneId: null,
      members: [],
    });
    await expect(service.getMergeContexts(["external-pr"])).resolves.toEqual({
      "external-pr": {
        prId: "external-pr",
        groupId: null,
        groupType: null,
        sourceLaneIds: [],
        targetLaneId: null,
        integrationLaneId: null,
        members: [],
      },
    });
  });

  it("chunks bulk merge-context lookups below SQLite's bind parameter limit", async () => {
    const prIds = Array.from({ length: 1_005 }, (_value, index) => `pr-${index}`);
    const rowsById = new Map(prIds.map((id, index) => [
      id,
      makePrRow({
        id,
        lane_id: `lane-${index}`,
        github_pr_number: index + 1,
        head_branch: `feature/${index}`,
      }),
    ] as const));
    const paramCounts = {
      pullRequests: [] as number[],
      groupLookups: [] as number[],
      memberLookups: [] as number[],
    };
    const db = makeMockDb();
    db.all.mockImplementation((sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes("from pull_requests")) {
        paramCounts.pullRequests.push(params.length);
        return params.slice(1).map((id) => rowsById.get(String(id))).filter(Boolean);
      }
      if (text.includes("from pr_group_members") && text.includes("join pr_groups")) {
        paramCounts.groupLookups.push(params.length);
        return params.slice(1).map((id) => ({
          pr_id: String(id),
          group_id: `group-${String(id)}`,
          group_type: "queue" as const,
        }));
      }
      if (text.includes("from pr_group_members")) {
        paramCounts.memberLookups.push(params.length);
        return [];
      }
      return [];
    });
    const { service } = buildService({ db, laneService: makeLaneService([]) });

    const contexts = await service.getMergeContexts(prIds);

    expect(Object.keys(contexts)).toHaveLength(prIds.length);
    expect(paramCounts.pullRequests).toHaveLength(2);
    expect(paramCounts.groupLookups).toHaveLength(2);
    expect(paramCounts.memberLookups).toHaveLength(2);
    for (const count of [
      ...paramCounts.pullRequests,
      ...paramCounts.groupLookups,
      ...paramCounts.memberLookups,
    ]) {
      expect(count).toBeLessThanOrEqual(902);
    }
  });
});

describe("prService.createLaneFromPrBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const prUrl = "https://github.com/test-owner/test-repo/pull/404";
  const primaryLane = makeFakeLane({
    id: "lane-primary",
    name: "main",
    laneType: "primary",
    branchRef: "refs/heads/main",
    baseRef: "refs/heads/main",
    worktreePath: "/tmp/test-project",
    parentLaneId: null,
  });

  function makeBranchPrGithubService(overrides?: Record<string, unknown>) {
    return makeGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls/404`) {
          return {
            data: makeUnmappedBranchPull(),
            response: { status: 200, headers: new Headers() },
          };
        }
        return { data: [], response: { status: 200, headers: new Headers() } };
      }),
      ...overrides,
    });
  }

  it("preflights an unmapped PR branch without creating a lane or PR row", async () => {
    const githubService = makeBranchPrGithubService();
    const laneService = {
      ...makeLaneService([primaryLane]),
      importBranch: vi.fn(),
    } as any;
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });

    const result = await serviceWithPrBranchActions(service).preflightCreateLaneFromPrBranch({
      prUrlOrNumber: prUrl,
    });

    expect(result).toEqual(expect.objectContaining({
      preflight: expect.objectContaining({
        githubPrNumber: 404,
        headBranch: "feature/unmapped",
        baseBranch: "main",
      }),
      lane: null,
    }));
    expect(preflightDisposition(result.preflight)).toBe("ready");
    expect(preflightConflicts(result.preflight)).toEqual([]);
    expect(laneService.importBranch).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.anything(),
    );
  });

  it("preflights fork PR branches by fetching the GitHub PR head ref", async () => {
    const githubService = makeBranchPrGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls/404`) {
          return {
            data: makeUnmappedBranchPull({
              head: {
                ref: "feature/unmapped",
                sha: "head-sha-unmapped",
                user: { login: "fork-owner" },
                repo: {
                  owner: { login: "fork-owner" },
                  name: "fork-repo",
                },
              },
            }),
            response: { status: 200, headers: new Headers() },
          };
        }
        return { data: [], response: { status: 200, headers: new Headers() } };
      }),
    });
    const laneService = {
      ...makeLaneService([primaryLane]),
      importBranch: vi.fn(),
    } as any;
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });
    mockGit.runGit.mockImplementation(async (args: unknown[]) => {
      const command = Array.isArray(args) ? args[0] : null;
      if (command === "fetch" && Array.isArray(args) && args[2] === "+refs/pull/404/head:refs/remotes/ade-pr-404/feature/unmapped") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "--verify" && args[2] === "refs/remotes/ade-pr-404/feature/unmapped") {
        return { exitCode: 0, stdout: "head-sha-unmapped\n", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "--verify" && args[2] === "refs/heads/feature/unmapped") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (command === "worktree") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "origin/my-feature", stderr: "" };
    });

    const result = await serviceWithPrBranchActions(service).preflightCreateLaneFromPrBranch({
      prUrlOrNumber: prUrl,
    });

    expect(preflightDisposition(result.preflight)).toBe("ready");
    expect(preflightConflicts(result.preflight)).toEqual([]);
    expect(result.preflight).toEqual(expect.objectContaining({
      headRepoOwner: "fork-owner",
      headRepoName: "fork-repo",
      importBranchRef: "ade-pr-404/feature/unmapped",
      remoteBranch: "refs/pull/404/head (fork-owner/fork-repo:feature/unmapped)",
    }));
    expect(result.lane ?? null).toBeNull();
    expect(laneService.importBranch).not.toHaveBeenCalled();
    expect(mockGit.runGit.mock.calls).toContainEqual([
      ["fetch", "origin", "+refs/pull/404/head:refs/remotes/ade-pr-404/feature/unmapped"],
      expect.objectContaining({ cwd: "/tmp/test-project", timeoutMs: 60_000 }),
    ]);
    expect(mockGit.runGit.mock.calls.some(([args]) => Array.isArray(args) && args[0] === "ls-remote")).toBe(false);
  });

  it("blocks PR branches when GitHub omits the head repository", async () => {
    const githubService = makeBranchPrGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls/404`) {
          return {
            data: makeUnmappedBranchPull({
              head: {
                ref: "feature/unmapped",
                sha: "head-sha-unmapped",
                user: { login: REPO.owner },
                repo: null,
              },
            }),
            response: { status: 200, headers: new Headers() },
          };
        }
        return { data: [], response: { status: 200, headers: new Headers() } };
      }),
    });
    const laneService = {
      ...makeLaneService([primaryLane]),
      importBranch: vi.fn(),
    } as any;
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });

    const result = await serviceWithPrBranchActions(service).preflightCreateLaneFromPrBranch({
      prUrlOrNumber: prUrl,
    });

    expect(preflightDisposition(result.preflight)).toBe("blocked");
    expect(preflightConflicts(result.preflight)).toEqual([
      expect.objectContaining({ code: "fork_unavailable" }),
    ]);
    expect(JSON.stringify(preflightConflicts(result.preflight))).toMatch(/fork|head repository/i);
    expect(result.lane ?? null).toBeNull();
    expect(laneService.importBranch).not.toHaveBeenCalled();
    expect(mockGit.runGit.mock.calls.some(([args]) => Array.isArray(args) && args[0] === "fetch")).toBe(false);
  });

  it("creates a lane from a fork PR head ref and maps the PR", async () => {
    const importedLane = makeFakeLane({
      id: "lane-fork-imported",
      name: "Fork branch PR",
      branchRef: "refs/heads/feature/unmapped",
      baseRef: "refs/heads/main",
      worktreePath: "/tmp/test-project/.ade/worktrees/fork-branch",
      parentLaneId: null,
    });
    let branchImported = false;
    const laneService = {
      ...makeLaneService(),
      list: vi.fn(async () => branchImported ? [primaryLane, importedLane] : [primaryLane]),
      importBranch: vi.fn(async () => {
        branchImported = true;
        return importedLane;
      }),
    } as any;
    const githubService = makeBranchPrGithubService({
      apiRequest: vi.fn(async (args: { path: string }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls/404`) {
          return {
            data: makeUnmappedBranchPull({
              title: "Fork branch PR",
              head: {
                ref: "feature/unmapped",
                sha: "head-sha-unmapped",
                user: { login: "fork-owner" },
                repo: {
                  owner: { login: "fork-owner" },
                  name: "fork-repo",
                },
              },
            }),
            response: { status: 200, headers: new Headers() },
          };
        }
        return { data: [], response: { status: 200, headers: new Headers() } };
      }),
    });
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });
    mockGit.runGit.mockImplementation(async (args: unknown[]) => {
      const command = Array.isArray(args) ? args[0] : null;
      if (command === "fetch" && Array.isArray(args) && args[2] === "+refs/pull/404/head:refs/remotes/ade-pr-404/feature/unmapped") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "--verify" && args[2] === "refs/remotes/ade-pr-404/feature/unmapped") {
        return { exitCode: 0, stdout: "head-sha-unmapped\n", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "--verify" && args[2] === "refs/heads/feature/unmapped") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "HEAD") {
        return { exitCode: 0, stdout: "head-sha-unmapped\n", stderr: "" };
      }
      if (command === "worktree") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "origin/my-feature", stderr: "" };
    });

    const result = await serviceWithPrBranchActions(service).createLaneFromPrBranch({
      prUrlOrNumber: prUrl,
      laneName: "Fork branch PR",
    });

    expect(laneService.importBranch).toHaveBeenCalledWith(expect.objectContaining({
      branchRef: "ade-pr-404/feature/unmapped",
      name: "Fork branch PR",
      baseBranch: "main",
    }));
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.arrayContaining(["lane-fork-imported", REPO.owner, REPO.name, 404, "Fork branch PR", "open", "main", "feature/unmapped"]),
    );
    expect(result.preflight).toEqual(expect.objectContaining({
      importBranchRef: "ade-pr-404/feature/unmapped",
      headRepoOwner: "fork-owner",
      headRepoName: "fork-repo",
    }));
    expect(result.lane.id).toBe("lane-fork-imported");
  });

  it("creates a lane from the PR branch, maps the PR to that lane, and returns lane/pr summaries", async () => {
    const importedLane = makeFakeLane({
      id: "lane-imported",
      name: "Unmapped branch PR",
      branchRef: "refs/heads/feature/unmapped",
      baseRef: "refs/heads/main",
      worktreePath: "/tmp/test-project/.ade/worktrees/feature-unmapped",
      parentLaneId: null,
    });
    let branchImported = false;
    const laneService = {
      ...makeLaneService(),
      list: vi.fn(async () => branchImported ? [primaryLane, importedLane] : [primaryLane]),
      importBranch: vi.fn(async () => {
        branchImported = true;
        return importedLane;
      }),
    } as any;
    const githubService = makeBranchPrGithubService();
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });

    const result = await serviceWithPrBranchActions(service).createLaneFromPrBranch({
      prUrlOrNumber: prUrl,
      laneName: "Unmapped branch PR",
    });

    expect(laneService.importBranch).toHaveBeenCalledWith(expect.objectContaining({
      name: "Unmapped branch PR",
      baseBranch: "main",
    }));
    expect(laneService.importBranch.mock.calls[0]?.[0]?.branchRef).toMatch(/feature\/unmapped$/);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.arrayContaining(["lane-imported", REPO.owner, REPO.name, 404, "Unmapped branch PR", "open", "main", "feature/unmapped"]),
    );
    expect(result).toEqual(expect.objectContaining({
      preflight: expect.objectContaining({
        githubPrNumber: 404,
        headBranch: "feature/unmapped",
        baseBranch: "main",
      }),
      lane: expect.objectContaining({
        id: "lane-imported",
        branchRef: "refs/heads/feature/unmapped",
      }),
      pr: expect.objectContaining({
        laneId: "lane-imported",
        githubPrNumber: 404,
        headBranch: "feature/unmapped",
        baseBranch: "main",
      }),
    }));
    expect(preflightDisposition(result.preflight)).toBe("ready");
  });

  it("blocks create when the remote branch moves after preflight", async () => {
    const laneService = {
      ...makeLaneService([primaryLane]),
      importBranch: vi.fn(),
    } as any;
    const githubService = makeBranchPrGithubService();
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });
    let lsRemoteCalls = 0;
    mockGit.runGit.mockImplementation(async (args: unknown[]) => {
      const command = Array.isArray(args) ? args[0] : null;
      if (command === "ls-remote") {
        lsRemoteCalls += 1;
        const sha = lsRemoteCalls === 1 ? "head-sha-unmapped" : "moved-sha";
        return { exitCode: 0, stdout: `${sha}\trefs/heads/feature/unmapped\n`, stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "--verify") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (command === "worktree") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "fetch" || command === "push") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "origin/my-feature", stderr: "" };
    });

    await expect(serviceWithPrBranchActions(service).createLaneFromPrBranch({
      prUrlOrNumber: prUrl,
      laneName: "Unmapped branch PR",
    })).rejects.toThrow(/does not match the current PR head/i);

    expect(lsRemoteCalls).toBe(2);
    expect(laneService.importBranch).not.toHaveBeenCalled();
  });

  it("blocks before importing when a stale local branch would shadow the PR head", async () => {
    const laneService = {
      ...makeLaneService([primaryLane]),
      importBranch: vi.fn(),
      delete: vi.fn(async () => undefined),
    } as any;
    const githubService = makeBranchPrGithubService();
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });
    mockGit.runGit.mockImplementation(async (args: unknown[]) => {
      const command = Array.isArray(args) ? args[0] : null;
      if (command === "ls-remote") {
        return { exitCode: 0, stdout: "head-sha-unmapped\trefs/heads/feature/unmapped\n", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "--verify") {
        return { exitCode: 0, stdout: "stale-sha\n", stderr: "" };
      }
      if (command === "worktree") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "fetch" || command === "push") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "origin/my-feature", stderr: "" };
    });

    await expect(serviceWithPrBranchActions(service).createLaneFromPrBranch({
      prUrlOrNumber: prUrl,
      laneName: "Unmapped branch PR",
    })).rejects.toThrow(/Local branch 'feature\/unmapped' is at stale-sha, but PR #404 is at head-sha-unmapped/i);

    expect(laneService.importBranch).not.toHaveBeenCalled();
    expect(laneService.delete).not.toHaveBeenCalled();
  });

  it("cleans up the imported lane when the imported checkout is not at the PR head", async () => {
    const importedLane = makeFakeLane({
      id: "lane-imported",
      name: "Unmapped branch PR",
      branchRef: "refs/heads/feature/unmapped",
      baseRef: "refs/heads/main",
      worktreePath: "/tmp/test-project/.ade/worktrees/feature-unmapped",
      parentLaneId: null,
    });
    let branchImported = false;
    const laneService = {
      ...makeLaneService(),
      list: vi.fn(async () => branchImported ? [primaryLane, importedLane] : [primaryLane]),
      importBranch: vi.fn(async () => {
        branchImported = true;
        return importedLane;
      }),
      delete: vi.fn(async () => undefined),
    } as any;
    const githubService = makeBranchPrGithubService();
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });
    mockGit.runGit.mockImplementation(async (args: unknown[]) => {
      const command = Array.isArray(args) ? args[0] : null;
      if (command === "ls-remote") {
        return { exitCode: 0, stdout: "head-sha-unmapped\trefs/heads/feature/unmapped\n", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "--verify") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (command === "rev-parse" && Array.isArray(args) && args[1] === "HEAD") {
        return { exitCode: 0, stdout: "stale-sha\n", stderr: "" };
      }
      if (command === "worktree") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "fetch" || command === "push") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "origin/my-feature", stderr: "" };
    });

    await expect(serviceWithPrBranchActions(service).createLaneFromPrBranch({
      prUrlOrNumber: prUrl,
      laneName: "Unmapped branch PR",
    })).rejects.toThrow(/is at stale-sha, but PR #404 is at head-sha-unmapped/i);

    expect(laneService.importBranch).toHaveBeenCalled();
    expect(laneService.delete).toHaveBeenCalledWith({
      laneId: "lane-imported",
      deleteBranch: false,
      deleteRemoteBranch: false,
      force: true,
    });
    expect(db.run).not.toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.anything(),
    );
  });

  it("cleans up the imported lane when PR linking fails", async () => {
    const importedLane = makeFakeLane({
      id: "lane-imported",
      name: "Unmapped branch PR",
      branchRef: "refs/heads/feature/unmapped",
      baseRef: "refs/heads/main",
      worktreePath: "/tmp/test-project/.ade/worktrees/feature-unmapped",
      parentLaneId: null,
    });
    const existingLane = makeFakeLane({
      id: "lane-raced",
      name: "Raced lane",
      branchRef: "refs/heads/feature/raced",
    });
    let branchImported = false;
    const laneService = {
      ...makeLaneService(),
      list: vi.fn(async () => branchImported ? [primaryLane, importedLane, existingLane] : [primaryLane]),
      importBranch: vi.fn(async () => {
        branchImported = true;
        rows.push(makePrRow({
          id: "pr-raced",
          lane_id: "lane-raced",
          github_pr_number: 404,
          head_branch: "feature/unmapped",
        }));
        return importedLane;
      }),
      delete: vi.fn(async () => undefined),
    } as any;
    const githubService = makeBranchPrGithubService();
    const db = makeMockDb();
    const rows = installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });

    await expect(serviceWithPrBranchActions(service).createLaneFromPrBranch({
      prUrlOrNumber: prUrl,
      laneName: "Unmapped branch PR",
    })).rejects.toThrow(/already mapped to lane/i);

    expect(laneService.importBranch).toHaveBeenCalled();
    expect(laneService.delete).toHaveBeenCalledWith({
      laneId: "lane-imported",
      deleteBranch: false,
      deleteRemoteBranch: false,
      force: true,
    });
  });

  it("blocks when the GitHub PR is already mapped to an ADE lane", async () => {
    const existingPr = makePrRow({
      id: "pr-existing",
      lane_id: "lane-existing",
      github_pr_number: 404,
      head_branch: "feature/unmapped",
    });
    const existingLane = makeFakeLane({
      id: "lane-existing",
      name: "Existing lane",
      branchRef: "refs/heads/feature/other",
    });
    const laneService = {
      ...makeLaneService([primaryLane, existingLane]),
      importBranch: vi.fn(),
    } as any;
    const db = makeMockDb();
    installPullRequestRowStore(db, [existingPr]);
    const { service } = buildService({
      db,
      githubService: makeBranchPrGithubService(),
      laneService,
    });

    const result = await serviceWithPrBranchActions(service).preflightCreateLaneFromPrBranch({
      prUrlOrNumber: prUrl,
    });

    expect(preflightDisposition(result.preflight)).toBe("blocked");
    expect(JSON.stringify(preflightConflicts(result.preflight))).toMatch(/already|mapped|linked|existing/i);
    expect(result.lane ?? null).toBeNull();
    expect(laneService.importBranch).not.toHaveBeenCalled();
  });

  it("blocks when the deeplink repo does not match the active project origin", async () => {
    const githubService = makeBranchPrGithubService({
      getRepoOrThrow: vi.fn(async () => REPO),
      apiRequest: vi.fn(),
    });
    const laneService = {
      ...makeLaneService([primaryLane]),
      importBranch: vi.fn(),
    } as any;
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({ db, githubService, laneService });

    const result = await serviceWithPrBranchActions(service).preflightCreateLaneFromPrBranch({
      repoOwner: "other-owner",
      repoName: "other-repo",
      githubPrNumber: 404,
    });

    expect(preflightDisposition(result.preflight)).toBe("blocked");
    expect(result.preflight.blockingConflict?.code).toBe("project_repo_mismatch");
    expect(githubService.apiRequest).not.toHaveBeenCalled();
    expect(laneService.importBranch).not.toHaveBeenCalled();
  });

  it("blocks when another ADE lane already owns the PR head branch", async () => {
    const branchOwner = makeFakeLane({
      id: "lane-branch-owner",
      name: "Branch owner",
      branchRef: "refs/heads/feature/unmapped",
    });
    const laneService = {
      ...makeLaneService([primaryLane, branchOwner]),
      importBranch: vi.fn(),
    } as any;
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const { service } = buildService({
      db,
      githubService: makeBranchPrGithubService(),
      laneService,
    });

    const result = await serviceWithPrBranchActions(service).preflightCreateLaneFromPrBranch({
      prUrlOrNumber: prUrl,
    });

    expect(preflightDisposition(result.preflight)).toBe("blocked");
    expect(JSON.stringify(preflightConflicts(result.preflight))).toMatch(/branch owner|feature\/unmapped|owned|already/i);
    expect(result.lane ?? null).toBeNull();
    expect(laneService.importBranch).not.toHaveBeenCalled();
  });
});

describe("prService.requestReviewers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests user reviewers and team reviewers in one GitHub request", async () => {
    const apiRequest = vi.fn(async (args: { method?: string; path: string }) => {
      if (args.method === "POST" && args.path.endsWith("/requested_reviewers")) {
        return { data: {}, response: { status: 201, headers: new Headers() } };
      }
      if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls/90`) {
        return {
          data: makeGitHubPull({
            number: 90,
            html_url: "https://github.com/test-owner/test-repo/pull/90",
            title: "Linked PR",
            base: { ref: "main" },
            head: { ref: "my-feature" },
          }),
          response: { status: 200, headers: new Headers() },
        };
      }
      return { data: [], response: { status: 200, headers: new Headers() } };
    });
    const githubService = makeGithubService({ apiRequest });
    const db = makeMockDb();
    installPullRequestRowStore(db, [makePrRow()]);
    const { service } = buildService({ db, githubService });

    await service.requestReviewers({
      prId: "pr-row-1",
      reviewers: ["@alice", "alice"],
      teamReviewers: ["team:platform", "acme/qa"],
    });

    const reviewerPosts = apiRequest.mock.calls
      .map(([call]) => call)
      .filter((call) =>
        call.method === "POST"
        && call.path === `/repos/${REPO.owner}/${REPO.name}/pulls/90/requested_reviewers`
      );

    expect(reviewerPosts).toHaveLength(1);
    expect(reviewerPosts[0]).toEqual(expect.objectContaining({
      body: {
        reviewers: ["alice"],
        team_reviewers: ["platform", "qa"],
      },
    }));
  });
});

describe("prService.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes cached PR children before deleting the PR row", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, [makePrRow()]);
    const { service } = buildService({ db });

    await service.delete({ prId: "pr-row-1", closeOnGitHub: false, archiveLane: false });

    const runSql: string[] = db.run.mock.calls.map((call: unknown[]) => String(call[0]));
    const summaryDeleteIndex = runSql.findIndex((sql: string) => sql.includes("delete from pull_request_ai_summaries"));
    const snapshotDeleteIndex = runSql.findIndex((sql: string) => sql.includes("delete from pull_request_snapshots"));
    const prDeleteIndex = runSql.findIndex((sql: string) => sql.includes("delete from pull_requests"));

    expect(summaryDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(prDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(summaryDeleteIndex).toBeLessThan(prDeleteIndex);
    expect(snapshotDeleteIndex).toBeLessThan(prDeleteIndex);
  });
});

describe("prService.land", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("directs GitHub stack merges to GitHub before starting a merge request", async () => {
    const row = makePrRow({ id: "pr-stacked", github_pr_number: 91 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const getPullRequestRow = db.get.getMockImplementation();
    db.get.mockImplementation((sql: string, params: unknown[] = []) => {
      if (String(sql).includes("from github_pr_stack_entries")) {
        return { github_stack_number: 19 };
      }
      return getPullRequestRow?.(sql, params) ?? null;
    });
    const githubService = makeGithubService();
    const { service } = buildService({ db, githubService });

    const result = await service.land({ prId: "pr-stacked", method: "squash" });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: "PR #91 is in GitHub Stack #19. Review and merge the stack on GitHub.",
    }));
    expect(githubService.apiRequest).not.toHaveBeenCalled();
  });

  it("does not send a merge request for draft PRs", async () => {
    const row = makePrRow({ id: "pr-draft", github_pr_number: 92, state: "draft" });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { method: string; path: string }) => {
        if (args.method === "GET" && args.path === "/repos/test-owner/test-repo/pulls/92") {
          return {
            data: makeGitHubPull({
              number: 92,
              draft: true,
              state: "open",
              mergeable: true,
              mergeable_state: "clean",
            }),
          };
        }
        throw new Error(`Unexpected GitHub API call: ${args.method} ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const result = await service.land({ prId: "pr-draft", method: "squash" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/draft/i);
    expect(githubService.apiRequest).not.toHaveBeenCalledWith(expect.objectContaining({ method: "PUT" }));
  });

  it("short-circuits dirty mergeability before calling GitHub merge", async () => {
    const row = makePrRow({ id: "pr-conflict", github_pr_number: 93 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { method: string; path: string }) => {
        if (args.method === "GET" && args.path === "/repos/test-owner/test-repo/pulls/93") {
          return {
            data: makeGitHubPull({
              number: 93,
              draft: false,
              state: "open",
              mergeable: false,
              mergeable_state: "dirty",
            }),
          };
        }
        throw new Error(`Unexpected GitHub API call: ${args.method} ${args.path}`);
      }),
    });
    const { service } = buildService({ db, githubService });

    const result = await service.land({ prId: "pr-conflict", method: "merge" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/merge conflicts/i);
    expect(githubService.apiRequest).not.toHaveBeenCalledWith(expect.objectContaining({ method: "PUT" }));
  });

  // Helper: a minimal stand-in for a child_process.ChildProcess that the runGh
  // promise consumes (stdout/stderr `.on`, top-level `.on`, `.kill`).
  function makeFakeGhChild() {
    const stream = { on: vi.fn() };
    const handlers: Record<string, (arg: unknown) => void> = {};
    return {
      stdout: stream,
      stderr: stream,
      kill: vi.fn(),
      on(event: string, cb: (arg: unknown) => void) {
        handlers[event] = cb;
        // Resolve runGh immediately with a successful admin merge exit.
        if (event === "close") cb(0);
        return this;
      },
    };
  }

  // The admin-merge bypass shells out to `gh pr merge --admin`. For PAT-only /
  // packaged users (no `gh auth login`), the spawned gh must inherit the
  // resolved ADE token via GH_TOKEN/GITHUB_TOKEN, otherwise the merge fails.
  function buildAdminMergeScenario(githubServiceOverrides?: Record<string, unknown>) {
    const row = makePrRow({ id: "pr-admin", github_pr_number: 94 });
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (args: { method: string; path: string }) => {
        if (args.method === "GET" && args.path === "/repos/test-owner/test-repo/pulls/94") {
          return {
            data: makeGitHubPull({
              number: 94,
              draft: false,
              state: "open",
              mergeable: true,
              mergeable_state: "clean",
            }),
          };
        }
        if (args.method === "PUT") {
          // Branch-protection rejection that triggers the admin bypass.
          throw new Error("405 At least 1 approving review is required by reviewers with write access. (branch protection)");
        }
        throw new Error(`Unexpected GitHub API call: ${args.method} ${args.path}`);
      }),
      ...githubServiceOverrides,
    });
    const laneService = makeLaneService();
    laneService.getLaneBaseAndBranch.mockReturnValue({ worktreePath: "/tmp/lane-wt" });
    const { service } = buildService({ db, githubService, laneService });
    return { service };
  }

  it("injects the resolved PAT into the gh admin-merge child env", async () => {
    mockChildProcess.spawn.mockImplementation(() => makeFakeGhChild());
    const { service } = buildAdminMergeScenario({ getTokenOrThrow: vi.fn(() => "ghp_test") });

    const result = await service.land({ prId: "pr-admin", method: "squash", bypassRules: true });

    expect(result.success).toBe(true);
    expect(mockChildProcess.spawn).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "--admin"]),
      expect.objectContaining({
        env: expect.objectContaining({ GH_TOKEN: "ghp_test", GITHUB_TOKEN: "ghp_test" }),
      }),
    );
  });

  it("falls back to process.env when no token is resolvable (no crash)", async () => {
    mockChildProcess.spawn.mockImplementation(() => makeFakeGhChild());
    const { service } = buildAdminMergeScenario({
      getTokenOrThrow: vi.fn(() => {
        throw new Error("no token");
      }),
    });

    const result = await service.land({ prId: "pr-admin", method: "squash", bypassRules: true });

    expect(result.success).toBe(true);
    const spawnEnv = mockChildProcess.spawn.mock.calls[0]?.[2]?.env;
    expect(spawnEnv).toBe(process.env);
  });
});

describe("prService.draftDescription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeAi = (impl?: () => unknown) =>
    ({ draftPrDescription: vi.fn(impl ?? (() => undefined)) }) as any;

  // Regression: explicit AI draft requests (requireAi) must run the real AI
  // path using the requested model even though the stored providerMode is the
  // default "guest" — providerMode is NOT derived from live CLI auth, so a
  // connected runtime would otherwise be wrongly refused.
  it("runs the AI path on the requested model when requireAi is set, even in guest providerMode", async () => {
    // NB: this file mocks extractFirstJsonObject → null, so parsePrDraftJson
    // always falls back to using the raw model text as the body. We assert the
    // call shape (the regression) and that the AI output reaches the draft.
    const aiIntegrationService = makeAi(async () => ({ text: "Drafted by the chat model." }));
    const { service } = buildService({ aiIntegrationService });

    const draft = await (service as any).draftDescription({
      laneId: LANE_ID,
      requireAi: true,
      model: "openai/gpt-5.5",
    });

    expect(aiIntegrationService.draftPrDescription).toHaveBeenCalledTimes(1);
    expect(aiIntegrationService.draftPrDescription.mock.calls[0][0]).toMatchObject({
      laneId: LANE_ID,
      model: "openai/gpt-5.5",
    });
    expect(draft.body).toContain("Drafted by the chat model.");
  });

  it("surfaces a precise error (not the misleading provider message) when no AI service exists", async () => {
    const { service } = buildService();

    await expect(
      (service as any).draftDescription({ laneId: LANE_ID, requireAi: true }),
    ).rejects.toThrow(/open this lane in the desktop app to draft with AI/);
  });

  it("returns the deterministic template (no AI call) when requireAi is not set in guest mode", async () => {
    const aiIntegrationService = makeAi();
    const { service } = buildService({ aiIntegrationService });

    const draft = await (service as any).draftDescription({ laneId: LANE_ID });

    expect(aiIntegrationService.draftPrDescription).not.toHaveBeenCalled();
    expect(draft.body).toContain("## Summary");
  });

  it("treats an empty (non-throwing) model response as a failure when requireAi is set", async () => {
    const aiIntegrationService = makeAi(async () => ({ text: "   " }));
    const { service } = buildService({ aiIntegrationService });

    await expect(
      (service as any).draftDescription({ laneId: LANE_ID, requireAi: true }),
    ).rejects.toThrow(/AI draft failed: the model returned an empty response\./);
  });

  it("rethrows AI failures as an explicit draft error when requireAi is set", async () => {
    const aiIntegrationService = makeAi(async () => {
      throw new Error("No AI provider is available.");
    });
    const { service } = buildService({ aiIntegrationService });

    await expect(
      (service as any).draftDescription({ laneId: LANE_ID, requireAi: true }),
    ).rejects.toThrow(/AI draft failed: No AI provider is available\./);
  });
});

describe("prService.createFromLane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults omitted PR titles to source lane and target lane names", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("stop after payload capture")),
    });
    const laneService = makeLaneService([
      makeFakeLane(),
      makeFakeLane({
        id: "lane-primary",
        name: "Primary",
        laneType: "primary",
        baseRef: "refs/heads/main",
        branchRef: "refs/heads/main",
        parentLaneId: null,
      }),
    ]);

    const { service } = buildService({ githubService: ghService, laneService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        body: "description",
        draft: false,
        allowDirtyWorktree: true,
      } as any),
    ).rejects.toThrow('Failed to create pull request for "my-feature" → "main": stop after payload capture');

    expect(ghService.apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          title: "my-feature -> Primary",
        }),
      }),
    );
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

  it("creates secret chat transcript gists and patches PR body when enabled", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const createSecretGist = vi.fn(async () => ({
      id: "gist-1",
      htmlUrl: "https://gist.github.com/octocat/gist-1",
    }));
    const apiRequest = vi.fn(async (args: any) => {
      if (args.method === "POST" && args.path.endsWith("/pulls")) {
        return {
          data: {
            number: 99,
            html_url: "https://github.com/test-owner/test-repo/pull/99",
            node_id: "PR_node1",
            title: "My PR",
            state: "open",
            draft: false,
            merged_at: null,
            body: args.body.body,
            head: { ref: "my-feature" },
            base: { ref: "main" },
            additions: 10,
            deletions: 2,
          },
          response: { status: 201, headers: new Headers() },
        };
      }
      if (args.method === "PATCH" && args.path.endsWith("/pulls/99")) {
        return { data: {}, response: { status: 200, headers: new Headers() } };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/99")) {
        return {
          data: {
            number: 99,
            html_url: "https://github.com/test-owner/test-repo/pull/99",
            title: "My PR",
            state: "open",
            draft: false,
            merged_at: null,
            head: { ref: "my-feature", sha: "abc123" },
            base: { ref: "main", sha: "base123" },
            additions: 10,
            deletions: 2,
          },
          response: { status: 200, headers: new Headers() },
        };
      }
      if (args.path.endsWith("/commits/abc123/status")) {
        return { data: { state: "success", statuses: [] }, response: { status: 200, headers: new Headers() } };
      }
      if (args.path.endsWith("/commits/abc123/check-runs")) {
        return { data: { check_runs: [] }, response: { status: 200, headers: new Headers() } };
      }
      if (args.path.endsWith("/pulls/99/reviews")) {
        return { data: [], response: { status: 200, headers: new Headers() } };
      }
      if (args.path.includes("/compare/")) {
        return { data: { behind_by: 0 }, response: { status: 200, headers: new Headers() } };
      }
      return { data: [], response: { status: 200, headers: new Headers() } };
    });
    const ghService = makeGithubService({ apiRequest, createSecretGist });
    const { service } = buildService({
      db,
      githubService: ghService,
      projectConfigService: {
        get: vi.fn(() => ({ effective: { github: { prTranscriptGists: { enabled: true } } } })),
      },
    });
    service.setAgentChatService({
      listSessions: vi.fn(async () => [{
        sessionId: "chat-1",
        laneId: LANE_ID,
        provider: "codex",
        model: "gpt-5-codex",
        title: "Ship transcript links",
        startedAt: "2026-06-01T10:00:00.000Z",
        lastActivityAt: "2026-06-01T11:00:00.000Z",
      }]),
      readTranscript: vi.fn(async () => [
        { role: "user", text: "Please implement transcript gists.", timestamp: "2026-06-01T10:00:00.000Z" },
        { role: "assistant", text: "Done.", timestamp: "2026-06-01T10:01:00.000Z" },
      ]),
    } as any);

    await service.createFromLane({
      laneId: LANE_ID,
      title: "My PR",
      body: "description",
      draft: false,
      allowDirtyWorktree: true,
    });

    expect(createSecretGist).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("test-owner/test-repo#99"),
      files: {
        "README.md": {
          content: expect.stringContaining("# Ship transcript links"),
        },
      },
    }));
    const patchedBodies = apiRequest.mock.calls
      .map(([call]) => call)
      .filter((call) => call.method === "PATCH" && call.path.endsWith("/pulls/99"))
      .map((call) => call.body.body);
    expect(patchedBodies).toEqual(expect.arrayContaining([
      expect.stringContaining("https://gist.github.com/octocat/gist-1"),
    ]));
    expect(patchedBodies.at(-1)).toContain("ADE chat transcripts");
  });

  it("does not recreate transcript gists when the PR body already has transcript links", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db);
    const createSecretGist = vi.fn(async () => ({
      id: "gist-1",
      htmlUrl: "https://gist.github.com/octocat/gist-1",
    }));
    const apiRequest = vi.fn(async (args: any) => {
      if (args.method === "POST" && args.path.endsWith("/pulls")) {
        return {
          data: {
            number: 99,
            html_url: "https://github.com/test-owner/test-repo/pull/99",
            node_id: "PR_node1",
            title: "My PR",
            state: "open",
            draft: false,
            merged_at: null,
            body: args.body.body,
            head: { ref: "my-feature" },
            base: { ref: "main" },
            additions: 10,
            deletions: 2,
          },
          response: { status: 201, headers: new Headers() },
        };
      }
      if (args.method === "GET" && args.path.endsWith("/pulls/99")) {
        return {
          data: {
            number: 99,
            html_url: "https://github.com/test-owner/test-repo/pull/99",
            title: "My PR",
            state: "open",
            draft: false,
            merged_at: null,
            head: { ref: "my-feature", sha: "abc123" },
            base: { ref: "main", sha: "base123" },
            additions: 10,
            deletions: 2,
          },
          response: { status: 200, headers: new Headers() },
        };
      }
      if (args.path.endsWith("/commits/abc123/status")) {
        return { data: { state: "success", statuses: [] }, response: { status: 200, headers: new Headers() } };
      }
      if (args.path.endsWith("/commits/abc123/check-runs")) {
        return { data: { check_runs: [] }, response: { status: 200, headers: new Headers() } };
      }
      if (args.path.endsWith("/pulls/99/reviews")) {
        return { data: [], response: { status: 200, headers: new Headers() } };
      }
      if (args.path.includes("/compare/")) {
        return { data: { behind_by: 0 }, response: { status: 200, headers: new Headers() } };
      }
      return { data: [], response: { status: 200, headers: new Headers() } };
    });
    const ghService = makeGithubService({ apiRequest, createSecretGist });
    const { service } = buildService({
      db,
      githubService: ghService,
      projectConfigService: {
        get: vi.fn(() => ({ effective: { github: { prTranscriptGists: { enabled: true } } } })),
      },
    });
    service.setAgentChatService({
      listSessions: vi.fn(async () => [{
        sessionId: "chat-1",
        laneId: LANE_ID,
        provider: "codex",
        model: "gpt-5-codex",
        title: "Ship transcript links",
        startedAt: "2026-06-01T10:00:00.000Z",
        lastActivityAt: "2026-06-01T11:00:00.000Z",
      }]),
      readTranscript: vi.fn(async () => [
        { role: "user", text: "Please implement transcript gists.", timestamp: "2026-06-01T10:00:00.000Z" },
      ]),
    } as any);

    await service.createFromLane({
      laneId: LANE_ID,
      title: "My PR",
      body: [
        "description",
        "",
        "<!-- ade:transcript-gists v=1 count=1 -->",
        "## ADE chat transcripts",
        "",
        "- [Existing](https://gist.github.com/octocat/existing)",
        "<!-- /ade:transcript-gists -->",
      ].join("\n"),
      draft: false,
      allowDirtyWorktree: true,
    });

    expect(createSecretGist).not.toHaveBeenCalled();
    const patchedBodies = apiRequest.mock.calls
      .map(([call]) => call)
      .filter((call) => call.method === "PATCH" && call.path.endsWith("/pulls/99"))
      .map((call) => call.body.body);
    expect(patchedBodies.some((body) => body.includes("https://gist.github.com/octocat/gist-1"))).toBe(false);
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

  it("uses the merged parent PR base when creating a child PR", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("stop after payload capture")),
    });
    const db = makeMockDb();
    db.all.mockImplementation((sql: string, params: unknown[]) => {
      if (String(sql).includes("from pull_requests") && params[0] === "lane-parent") {
        return [
          makePrRow({
            id: "pr-parent",
            lane_id: "lane-parent",
            state: "merged",
            base_branch: "main",
            head_branch: "parent-feature",
          }),
        ];
      }
      return [];
    });
    db.get.mockImplementation((sql: string, params: unknown[]) => {
      if (String(sql).includes("from lanes") && params[0] === "lane-parent") {
        return {
          lane_type: "worktree",
          branch_ref: "refs/heads/parent-feature",
          base_ref: "refs/heads/main",
          archived_at: null,
        };
      }
      return null;
    });
    const laneService = makeLaneService([
      makeFakeLane({
        parentLaneId: "lane-parent",
        baseRef: "refs/heads/parent-feature",
      }),
      makeFakeLane({
        id: "lane-parent",
        name: "Parent",
        branchRef: "refs/heads/parent-feature",
        baseRef: "refs/heads/main",
        parentLaneId: null,
      }),
      makeFakeLane({
        id: "lane-primary",
        name: "Primary",
        laneType: "primary",
        baseRef: "refs/heads/main",
        branchRef: "refs/heads/main",
        parentLaneId: null,
      }),
    ]);

    const { service } = buildService({ githubService: ghService, laneService, db });

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

  it("adds a closing Linear reference (Fixes) by default when creating a PR from a linked lane", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("stop after payload capture")),
    });
    const laneService = makeLaneService([
      makeFakeLane({
        linearIssue: {
          id: "issue-1",
          identifier: "ADE-123",
          title: "Connect Linear PR linking",
          description: null,
          url: "https://linear.app/ade/issue/ADE-123/connect-linear-pr-linking",
          projectId: "project-1",
          projectSlug: "ade",
          teamId: "team-1",
          teamKey: "ADE",
          stateId: "state-1",
          stateName: "In Progress",
          stateType: "started",
          priority: 0,
          priorityLabel: "none",
          labels: [],
          assigneeId: null,
          assigneeName: null,
          createdAt: "2026-05-08T00:00:00.000Z",
          updatedAt: "2026-05-08T00:00:00.000Z",
        },
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
          title: "My PR",
          // Body starts with the Linear ref + description, then the auto-appended
          // "Open in ADE" deeplink footer block (idempotent marker).
          body: expect.stringMatching(/^Fixes ADE-123\n\ndescription/),
        }),
      }),
    );
    expect(ghService.apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          body: expect.stringContaining("<!-- ade:link v=1"),
        }),
      }),
    );
  });

  it("blocks PR creation when the remote branch has newer commits", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("should not create")),
    });
    mockGit.runGit
      .mockResolvedValueOnce({ exitCode: 0, stdout: "origin/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1\t0\n", stderr: "" });

    const { service } = buildService({ githubService: ghService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow('The remote branch "my-feature" has 1 newer commit');

    expect(ghService.apiRequest).not.toHaveBeenCalled();
    expect(mockGit.runGit).toHaveBeenNthCalledWith(
      2,
      ["fetch", "--prune", "origin", "+refs/heads/my-feature:refs/remotes/origin/my-feature"],
      expect.objectContaining({ cwd: "/tmp/lane-wt" }),
    );
    expect(mockGit.runGit).not.toHaveBeenCalledWith(["push"], expect.anything());
    expect(mockGit.runGitOrThrow).not.toHaveBeenCalledWith(["push", "--force-with-lease"], expect.anything());
  });

  it("blocks PR creation when remote status cannot be parsed", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("should not create")),
    });
    mockGit.runGit
      .mockResolvedValueOnce({ exitCode: 0, stdout: "origin/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "not-a-count\n", stderr: "" });

    const { service } = buildService({ githubService: ghService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("Could not read the remote status");

    expect(ghService.apiRequest).not.toHaveBeenCalled();
    expect(mockGit.runGit).not.toHaveBeenCalledWith(["push"], expect.anything());
  });

  it("does not force-push when a create-PR push is rejected", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("should not create")),
    });
    mockGit.runGit
      .mockResolvedValueOnce({ exitCode: 0, stdout: "origin/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "0\t1\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "! [rejected] my-feature -> my-feature (non-fast-forward)" });

    const { service } = buildService({ githubService: ghService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("ADE did not force-push");

    expect(ghService.apiRequest).not.toHaveBeenCalled();
    expect(mockGit.runGitOrThrow).not.toHaveBeenCalledWith(["push", "--force-with-lease"], expect.anything());
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

  it("throws before git or GitHub work when the lane has no branch", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("should not create")),
      getRepoOrThrow: vi.fn(async () => REPO),
    });
    const laneService = makeLaneService([
      makeFakeLane({
        branchRef: "",
      }),
    ]);
    const { service } = buildService({ githubService: ghService, laneService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "",
        draft: false,
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow('Lane "my-feature" has no branch checked out');

    expect(mockGit.runGit).not.toHaveBeenCalled();
    expect(ghService.getRepoOrThrow).not.toHaveBeenCalled();
    expect(ghService.apiRequest).not.toHaveBeenCalled();
  });

  it("throws before git or GitHub work when the target branch is empty", async () => {
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("should not create")),
      getRepoOrThrow: vi.fn(async () => REPO),
    });
    const { service } = buildService({ githubService: ghService });

    await expect(
      service.createFromLane({
        laneId: LANE_ID,
        title: "My PR",
        body: "",
        draft: false,
        baseBranch: "   ",
        allowDirtyWorktree: true,
      }),
    ).rejects.toThrow("Choose a target branch before creating the PR");

    expect(mockGit.runGit).not.toHaveBeenCalled();
    expect(ghService.getRepoOrThrow).not.toHaveBeenCalled();
    expect(ghService.apiRequest).not.toHaveBeenCalled();
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

describe("prService.updateComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PATCHes the issue comment by id and maps the response", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, [makePrRow()]);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async (request: { method?: string }) => {
        // The ownership pre-check GETs the comment to confirm it belongs to the
        // target PR; the PATCH then performs the edit.
        if (request.method === "GET") {
          return {
            data: {
              id: 555,
              issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/90",
            },
          };
        }
        return {
          data: {
            id: 555,
            user: { login: "ade[bot]", avatar_url: "https://avatars/ade" },
            body: "Edited body",
            html_url: "https://github.com/test-owner/test-repo/pull/90#issuecomment-555",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          },
        };
      }),
    });
    const { service } = buildService({ db, githubService });

    const result = await service.updateComment({ prId: "pr-row-1", commentId: "555", body: "Edited body" });

    expect(githubService.apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        path: "/repos/test-owner/test-repo/issues/comments/555",
        body: { body: "Edited body" },
      }),
    );
    expect(result.id).toBe("555");
    expect(result.body).toBe("Edited body");
    expect(result.source).toBe("issue");
    expect(result.url).toBe("https://github.com/test-owner/test-repo/pull/90#issuecomment-555");
  });

  it("rejects a comment that belongs to a different PR without PATCHing", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, [makePrRow()]);
    const githubService = makeGithubService({
      apiRequest: vi.fn(async () => ({
        data: {
          id: 555,
          issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/91",
        },
      })),
    });
    const { service } = buildService({ db, githubService });

    await expect(
      service.updateComment({ prId: "pr-row-1", commentId: "555", body: "Edited body" }),
    ).rejects.toThrow("Comment does not belong to the target PR.");
    expect(githubService.apiRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("rejects an invalid comment id without calling GitHub", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, [makePrRow()]);
    const githubService = makeGithubService({ apiRequest: vi.fn() });
    const { service } = buildService({ db, githubService });

    await expect(
      service.updateComment({ prId: "pr-row-1", commentId: "not-a-number", body: "x" }),
    ).rejects.toThrow("Invalid comment id.");
    expect(githubService.apiRequest).not.toHaveBeenCalled();
  });

  it("throws when the PR row is unknown without calling GitHub", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, []);
    const githubService = makeGithubService({ apiRequest: vi.fn() });
    const { service } = buildService({ db, githubService });

    await expect(
      service.updateComment({ prId: "missing", commentId: "1", body: "x" }),
    ).rejects.toThrow();
    expect(githubService.apiRequest).not.toHaveBeenCalled();
  });
});

describe("prService auto-map by branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const AUTO_BRANCH = "my-feature";

  // Same-repo open PR whose head branch matches makeFakeLane()'s branch.
  function makeAutoMapPull(overrides?: Partial<Record<string, unknown>>) {
    return makeGitHubPull({
      number: 777,
      title: "Auto-map candidate",
      html_url: "https://github.com/test-owner/test-repo/pull/777",
      head: {
        ref: AUTO_BRANCH,
        user: { login: REPO.owner },
        repo: { owner: { login: REPO.owner }, name: REPO.name },
      },
      ...overrides,
    });
  }

  // GitHub mock that serves the branch lookup (list) and the per-PR fetch +
  // body PATCH that linkToLane performs. `ignoreInserts` controls whether a row
  // already exists for the PR.
  function makeAutoMapGithub(pulls: any[]) {
    return makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { method?: string; path: string }) => {
        const method = args.method ?? "GET";
        if (method === "GET" && /\/pulls\/\d+$/.test(args.path)) {
          const num = Number(args.path.split("/").pop());
          return { data: pulls.find((p) => Number(p.number) === num) ?? makeAutoMapPull() };
        }
        if (method === "GET" && args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          return { data: pulls };
        }
        if (method === "PATCH") {
          return { data: {} };
        }
        return { data: {} };
      }),
    });
  }

  function autoMapService(service: ReturnType<typeof buildService>["service"]) {
    return service as typeof service & {
      tryAutoMapLaneByBranch: (laneId: string) => Promise<void>;
      setEventEmitter: (emit: (event: unknown) => void) => void;
    };
  }

  it("links on an exact single same-repo branch match and emits an auto-link event", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, []);
    const githubService = makeAutoMapGithub([makeAutoMapPull()]);
    const laneService = makeLaneService([makeFakeLane()]);
    const { service } = buildService({ db, githubService, laneService });
    const events: any[] = [];
    autoMapService(service).setEventEmitter((e) => events.push(e));

    await autoMapService(service).tryAutoMapLaneByBranch(LANE_ID);

    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into pull_requests("),
      expect.arrayContaining([LANE_ID, REPO.owner, REPO.name, 777]),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "pr-auto-linked",
        prNumber: 777,
        laneId: LANE_ID,
        laneName: "my-feature",
      }),
    ]);
    // The toast's Undo path keys off prId; it must be the real linked row id,
    // never an empty string (otherwise Undo silently no-ops).
    expect(typeof events[0].prId).toBe("string");
    expect(events[0].prId.length).toBeGreaterThan(0);
  });

  it("skips a fork PR (different head repo)", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, []);
    const forkPull = makeAutoMapPull({
      head: {
        ref: AUTO_BRANCH,
        user: { login: "fork-owner" },
        repo: { owner: { login: "fork-owner" }, name: "fork-repo" },
      },
    });
    const githubService = makeAutoMapGithub([forkPull]);
    const laneService = makeLaneService([makeFakeLane()]);
    const { service } = buildService({ db, githubService, laneService });

    await autoMapService(service).tryAutoMapLaneByBranch(LANE_ID);

    expect(db.run.mock.calls.some(([sql]: [unknown]) =>
      String(sql).includes("insert into pull_requests("))).toBe(false);
  });

  it("skips when two lanes match the head branch", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, []);
    const githubService = makeAutoMapGithub([makeAutoMapPull()]);
    const laneService = makeLaneService([
      makeFakeLane(),
      makeFakeLane({ id: "lane-dup", name: "dup", branchRef: "refs/heads/my-feature" }),
    ]);
    const { service } = buildService({ db, githubService, laneService });

    await autoMapService(service).tryAutoMapLaneByBranch(LANE_ID);

    expect(db.run.mock.calls.some(([sql]: [unknown]) =>
      String(sql).includes("insert into pull_requests("))).toBe(false);
  });

  it("skips the primary lane", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, []);
    const githubService = makeAutoMapGithub([makeAutoMapPull()]);
    const laneService = makeLaneService([
      makeFakeLane({ id: "lane-primary", laneType: "primary" }),
    ]);
    const { service } = buildService({ db, githubService, laneService });

    await autoMapService(service).tryAutoMapLaneByBranch("lane-primary");

    expect(db.run.mock.calls.some(([sql]: [unknown]) =>
      String(sql).includes("insert into pull_requests("))).toBe(false);
  });

  it("skips a lane already mapped to a PR", async () => {
    const db = makeMockDb();
    // Existing row on the same lane + branch => lane is already mapped.
    installPullRequestRowStore(db, [
      makePrRow({ id: "pr-existing", github_pr_number: 12, head_branch: AUTO_BRANCH }),
    ]);
    const githubService = makeAutoMapGithub([makeAutoMapPull()]);
    const laneService = makeLaneService([makeFakeLane()]);
    const { service } = buildService({ db, githubService, laneService });

    await autoMapService(service).tryAutoMapLaneByBranch(LANE_ID);

    expect(db.run.mock.calls.some(([sql]: [unknown]) =>
      String(sql).includes("insert into pull_requests("))).toBe(false);
  });

  it("skips a PR already mapped to any lane", async () => {
    const db = makeMockDb();
    // Existing row for PR #777 on a *different* lane => PR already mapped.
    installPullRequestRowStore(db, [
      makePrRow({ id: "pr-777", lane_id: "other-lane", github_pr_number: 777, head_branch: "other" }),
    ]);
    const githubService = makeAutoMapGithub([makeAutoMapPull()]);
    const laneService = makeLaneService([makeFakeLane()]);
    const { service } = buildService({ db, githubService, laneService });

    await autoMapService(service).tryAutoMapLaneByBranch(LANE_ID);

    expect(db.run.mock.calls.some(([sql]: [unknown]) =>
      String(sql).includes("insert into pull_requests("))).toBe(false);
  });

  it("skips a suppressed (previously-unmapped) pair", async () => {
    const db = makeMockDb();
    const rows: any[] = [];
    // Custom store: pull_requests empty; pr_auto_link_ignores has (777, LANE_ID).
    db.get.mockImplementation((sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes("from pull_requests")) {
        if (text.includes("lower(repo_owner)") && text.includes("github_pr_number")) {
          const [, owner, name, prNumber] = params;
          return rows.find((r) =>
            String(r.repo_owner).toLowerCase() === String(owner).toLowerCase()
            && String(r.repo_name).toLowerCase() === String(name).toLowerCase()
            && Number(r.github_pr_number) === Number(prNumber)) ?? null;
        }
        return null;
      }
      return null;
    });
    db.all.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("from pr_auto_link_ignores")) {
        return [{
          project_id: "proj-1",
          repo_owner: REPO.owner,
          repo_name: REPO.name,
          github_pr_number: 777,
          lane_id: LANE_ID,
          head_branch: AUTO_BRANCH,
          created_at: "2026-01-01T00:00:00Z",
        }];
      }
      if (text.includes("from pull_requests")) return rows;
      return [];
    });
    db.run.mockImplementation((sql: string) => {
      if (String(sql).includes("insert into pull_requests(")) rows.push({});
      return undefined;
    });
    const githubService = makeAutoMapGithub([makeAutoMapPull()]);
    const laneService = makeLaneService([makeFakeLane()]);
    const { service } = buildService({ db, githubService, laneService });

    await autoMapService(service).tryAutoMapLaneByBranch(LANE_ID);

    expect(rows.length).toBe(0);
  });

  it("records suppression on local unmap so auto-map will not re-bind", async () => {
    const db = makeMockDb();
    installPullRequestRowStore(db, [
      makePrRow({ id: "pr-row-1", github_pr_number: 777, head_branch: AUTO_BRANCH }),
    ]);
    const { service } = buildService({ db });

    await service.delete({ prId: "pr-row-1", closeOnGitHub: false, archiveLane: false });

    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert or replace into pr_auto_link_ignores("),
      expect.arrayContaining([REPO.owner, REPO.name, 777, LANE_ID, AUTO_BRANCH]),
    );
  });
});

describe("prService hot refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-arm an existing hot-refresh window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const onHotRefreshChanged = vi.fn();
    const { service } = buildService({ onHotRefreshChanged });

    service.markHotRefresh(["pr-1"]);
    expect(service.getHotRefreshDelayMs()).toBe(5_000);

    vi.setSystemTime(new Date("2026-01-01T00:00:59.000Z"));
    service.markHotRefresh(["pr-1"]);
    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));

    expect(service.getHotRefreshDelayMs()).toBe(15_000);

    vi.setSystemTime(new Date("2026-01-01T00:03:01.000Z"));
    expect(service.getHotRefreshPrIds()).toEqual([]);
    expect(onHotRefreshChanged).toHaveBeenCalledTimes(2);
  });
});

describe("prService.reconcileOnFocus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Builds a service whose GitHub snapshot succeeds and records the `state`
  // query value of every `/pulls` request, so tests can distinguish the open
  // sweep (state:"open") from the slower closed sweep (state:"all").
  function buildReconcileService() {
    const pullStates: string[] = [];
    const githubService = makeGithubService({
      getStatus: vi.fn(async () => makeGithubStatus()),
      apiRequest: vi.fn(async (args: { path: string; query?: { state?: string } }) => {
        if (args.path === `/repos/${REPO.owner}/${REPO.name}/pulls`) {
          pullStates.push(String(args.query?.state ?? ""));
          return { data: [] };
        }
        return { data: [] };
      }),
    });
    // Empty db + no lanes → phases 1/3 fetch but phase 2 (merged-heal) is a
    // no-op, keeping the test focused on throttle/single-flight/cadence.
    const db = makeMockDb();
    const { service } = buildService({ db, githubService, laneService: makeLaneService([]) });
    return { service, githubService, pullStates };
  }

  it("runs the open sweep + closed sweep on a forced reconcile", async () => {
    const { service, pullStates } = buildReconcileService();

    const result = await service.reconcileOnFocus({ force: true });

    expect(pullStates).toContain("open");
    expect(pullStates).toContain("all");
    expect(result.closedSwept).toBe(true);
  });

  it("skips (returns zeros) when called again within the min-interval without force", async () => {
    const { service, pullStates } = buildReconcileService();

    await service.reconcileOnFocus({ force: true });
    pullStates.length = 0;

    // Immediately (well within RECONCILE_MIN_INTERVAL_MS) — should short-circuit.
    const result = await service.reconcileOnFocus();

    expect(result).toEqual({ open: 0, healed: 0, closedSwept: false });
    expect(pullStates).toEqual([]);
  });

  it("bypasses the min-interval throttle when force is set", async () => {
    const { service, pullStates } = buildReconcileService();

    await service.reconcileOnFocus({ force: true });
    pullStates.length = 0;

    const result = await service.reconcileOnFocus({ force: true });

    // Forced reconcile fetches again despite the recent run.
    expect(pullStates).toContain("open");
    expect(result.closedSwept).toBe(true);
  });

  it("single-flights concurrent reconciles (second call returns zeros)", async () => {
    const { service } = buildReconcileService();

    const [first, second] = await Promise.all([
      service.reconcileOnFocus({ force: true }),
      service.reconcileOnFocus({ force: true }),
    ]);

    // Exactly one of the two ran; the other was single-flighted to zeros.
    const ranClosedSweep = [first, second].filter((r) => r.closedSwept === true);
    const returnedZeros = [first, second].filter(
      (r) => r.open === 0 && r.healed === 0 && r.closedSwept === false,
    );
    expect(ranClosedSweep).toHaveLength(1);
    expect(returnedZeros).toHaveLength(1);
  });

  it("honors the closed-sweep cadence: open sweep runs but closed sweep is skipped within the interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { service, pullStates } = buildReconcileService();

    // First (unforced) reconcile: lastClosedSweepAtMs starts at 0, so the closed
    // sweep runs on the very first focus after open.
    const first = await service.reconcileOnFocus();
    expect(first.closedSwept).toBe(true);
    pullStates.length = 0;

    // Advance 2 minutes: past the 90s min-interval, but well inside the 30-min
    // closed-sweep interval.
    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const second = await service.reconcileOnFocus();

    expect(pullStates).toContain("open"); // open sweep still runs
    expect(pullStates).not.toContain("all"); // closed sweep is throttled
    expect(second.closedSwept).toBe(false);
  });

  it("emits pr-reconcile running/idle events around a reconcile", async () => {
    const { service } = buildReconcileService();
    const events: Array<{ type: string; state?: string }> = [];
    service.setEventEmitter((event) => {
      events.push(event as { type: string; state?: string });
    });

    await service.reconcileOnFocus({ force: true });

    const reconcileEvents = events.filter((e) => e.type === "pr-reconcile");
    expect(reconcileEvents.map((e) => e.state)).toEqual(["running", "idle"]);
  });
});

describe("prService detached PR rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A PR outlives its lane: deleting the lane detaches the row rather than deleting
   * it, so merged history keeps its ADE identity. These tests pin the three ways that
   * previously went wrong.
   */
  function detachedRow(overrides?: Record<string, unknown>) {
    return makePrRow({
      id: "pr-detached",
      github_pr_number: 90,
      detached_at: "2026-07-30T00:00:00Z",
      detached_lane_name: "auto-naming",
      detached_lane_color: "#4ADE80",
      detached_provenance: JSON.stringify({ chats: 3, artifacts: 2, checkpoints: 5 }),
      ...overrides,
    });
  }

  function githubServiceForPr90(row: { github_url: string; title: string }) {
    return makeGithubService({
      apiRequest: vi.fn(async (args: { method?: string; path: string }) => {
        if (args.path === "/repos/test-owner/test-repo/pulls/90") {
          return {
            data: makeGitHubPull({
              number: 90,
              html_url: row.github_url,
              title: row.title,
              state: "closed",
              merged: true,
              merged_at: "2026-07-29T00:00:00Z",
              head: { ref: "my-feature", sha: "head-sha" },
              base: { ref: "main", sha: "base-sha" },
            }),
          };
        }
        if (args.path.includes("/status")) return { data: { state: "success", statuses: [] } };
        if (args.path.includes("/check-runs")) return { data: { check_runs: [] } };
        if (args.path.includes("/reviews")) return { data: [] };
        if (args.path.includes("/compare/")) return { data: { behind_by: 0 } };
        return { data: {} };
      }),
    });
  }

  it("updates a detached row instead of re-inserting its primary key", async () => {
    // The lane-branch lookup is live-only, so it cannot see a detached row. Resolving
    // by identity first is what keeps this an UPDATE — otherwise every merged PR whose
    // lane was deleted would hit a duplicate-primary-key insert on open.
    const row = detachedRow();
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const { service } = buildService({ db, githubService: githubServiceForPr90(row) });

    await service.getStatus("pr-detached");

    const sqlRun: string[] = db.run.mock.calls.map(([sql]: [unknown]) => String(sql));
    expect(sqlRun.some((sql: string) => sql.includes("update pull_requests"))).toBe(true);
    expect(sqlRun.some((sql: string) => sql.includes("insert into pull_requests"))).toBe(false);
  });

  it("keeps a detached row detached when its lane no longer exists", async () => {
    // A background refresh must never resurrect history. The lane is gone, so nothing
    // can reclaim the row.
    const row = detachedRow();
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const { service } = buildService({
      db,
      githubService: githubServiceForPr90(row),
      laneService: makeLaneService([]),
    });

    await service.getStatus("pr-detached");

    const clearedDetach = db.run.mock.calls.some(([sql]: [unknown]) =>
      String(sql).includes("set detached_at = null"),
    );
    expect(clearedDetach).toBe(false);
  });

  it("keeps a detached row detached when its lane moved to another branch", async () => {
    // switchBranch/rename detach while the lane lives on. Lane existence alone is not
    // enough to reclaim — the lane must still track this PR's head branch, or a poll
    // would reattach a PR to a lane that has moved on.
    const row = detachedRow();
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    db.get.mockImplementation((sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes("from lanes")) return { branch_ref: "refs/heads/some-other-branch" };
      if (!text.includes("from pull_requests")) return null;
      if (text.includes("where id = ?")) {
        return params[0] === row.id ? row : null;
      }
      return null;
    });
    const { service } = buildService({ db, githubService: githubServiceForPr90(row) });

    await service.getStatus("pr-detached");

    const clearedDetach = db.run.mock.calls.some(([sql]: [unknown]) =>
      String(sql).includes("set detached_at = null"),
    );
    expect(clearedDetach).toBe(false);
  });

  it("reclaims a detached row when a lane on the same branch takes it back", async () => {
    const row = detachedRow();
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    db.get.mockImplementation((sql: string, params: unknown[] = []) => {
      const text = String(sql);
      if (text.includes("from lanes")) return { branch_ref: "refs/heads/my-feature" };
      if (!text.includes("from pull_requests")) return null;
      if (text.includes("where id = ?")) {
        return params[0] === row.id ? row : null;
      }
      return null;
    });
    const { service } = buildService({ db, githubService: githubServiceForPr90(row) });

    await service.getStatus("pr-detached");

    const clearCall = db.run.mock.calls.find(([sql]: [unknown]) =>
      String(sql).includes("set detached_at = null"),
    );
    expect(clearCall).toBeTruthy();
    // The dead lane's provenance goes with the marker — it describes a lane this PR
    // no longer belongs to.
    expect(String(clearCall?.[0])).toContain("detached_lane_name = null");
    expect(String(clearCall?.[0])).toContain("detached_provenance = null");
  });

  it("exposes frozen lane provenance on the summary of a detached row", async () => {
    const row = detachedRow();
    const db = makeMockDb();
    installPullRequestRowStore(db, [row]);
    const { service } = buildService({ db });

    const detached = service.listAll().find((entry: { id: string }) => entry.id === "pr-detached");

    expect(detached?.detached).toMatchObject({
      laneName: "auto-naming",
      laneColor: "#4ADE80",
      chats: 3,
      artifacts: 2,
    });
    expect(detached?.laneId).toBe(LANE_ID);
  });
});
