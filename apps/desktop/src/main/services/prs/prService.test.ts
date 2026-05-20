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
    last_synced_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    creation_strategy: "pr_target",
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

function makeGithubStatus(overrides?: Record<string, unknown>) {
  return {
    tokenStored: true,
    connected: true,
    repo: REPO,
    userLogin: "octocat",
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
    projectConfigService: makeProjectConfigService(),
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
      ) ?? null;
    }
    if (text.includes("where lane_id = ?")) {
      return rows.find((row) => row.lane_id === params[0] && row.project_id === params[1]) ?? null;
    }
    return null;
  });

  db.all.mockImplementation((sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (!text.includes("from pull_requests")) return [];
    if (text.includes("where lane_id = ?")) {
      return rows.filter((row) => row.lane_id === params[0] && row.project_id === params[1]);
    }
    if (text.includes("where project_id = ?")) {
      return rows.filter((row) => row.project_id === params[0]);
    }
    return rows;
  });

  db.run.mockImplementation((sql: string, params: unknown[] = []) => {
    const text = String(sql);
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
      creation_strategy: params[19] ?? null,
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

  function buildGetForLaneService(lane: ReturnType<typeof makeFakeLane>, rows: unknown[]) {
    const db = makeMockDb();
    db.get.mockImplementation((sql: string) => {
      if (String(sql).includes("from lanes")) {
        return {
          lane_type: lane.laneType,
          branch_ref: lane.branchRef,
          base_ref: lane.baseRef,
          archived_at: lane.archivedAt ?? null,
        };
      }
      return null;
    });
    db.all.mockReturnValue(rows);
    return buildService({ db, laneService: makeLaneService([lane]) }).service;
  }

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
      throw new Error("Repository state should not be inspected without a usable GitHub token.");
    });
    const { service } = buildService({ db, githubService });

    await expect(service.getGithubSnapshot()).rejects.toThrow("GitHub token missing");
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

    await expect(service.getGithubSnapshot()).rejects.toThrow("GitHub token cannot access test-owner/test-repo");
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

  it("reuses an in-flight repo snapshot when closed-history is requested", async () => {
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
    expect(repoCalls).toBe(1);
  });

  it("serves closed-history requests from a fresh repo snapshot cache", async () => {
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
    expect(githubService.apiRequest).toHaveBeenCalledTimes(apiCallsAfterCache);
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
      return null;
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

  it("adds a non-closing Linear reference when creating a PR from a linked lane", async () => {
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
          body: "Refs ADE-123\n\ndescription",
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

describe("prService.createQueuePrs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops before database writes or GitHub PR creation when a queued lane cannot push", async () => {
    const laneA = makeFakeLane({
      id: "lane-a",
      name: "feature-a",
      branchRef: "refs/heads/feature-a",
      worktreePath: "/tmp/lane-a-wt",
    });
    const laneB = makeFakeLane({
      id: "lane-b",
      name: "feature-b",
      branchRef: "refs/heads/feature-b",
      worktreePath: "/tmp/lane-b-wt",
    });
    const ghService = makeGithubService({
      apiRequest: vi.fn().mockRejectedValue(new Error("should not create")),
    });
    const db = makeMockDb();
    mockGit.runGit
      .mockResolvedValueOnce({ exitCode: 0, stdout: "origin/feature-a\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "0\t1\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "origin/feature-b\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1\t0\n", stderr: "" });

    const { service } = buildService({
      githubService: ghService,
      laneService: makeLaneService([laneA, laneB]),
      db,
    });

    const result = await service.createQueuePrs({
      laneIds: ["lane-a", "lane-b"],
      targetBranch: "main",
      draft: false,
    });

    expect(result.prs).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        laneId: "lane-b",
        error: expect.stringContaining('The remote branch "feature-b" has 1 newer commit'),
      }),
    ]);
    expect(ghService.apiRequest).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
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
