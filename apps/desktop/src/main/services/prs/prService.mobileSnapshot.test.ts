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

function makeLane(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "lane-default",
    name: "lane-default",
    description: null,
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef: "refs/heads/lane-default",
    worktreePath: "/tmp/lane-default",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function makePrRow(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "pr-1",
    lane_id: "lane-1",
    project_id: "proj-1",
    repo_owner: "owner",
    repo_name: "repo",
    github_pr_number: 42,
    github_url: "https://github.com/owner/repo/pull/42",
    github_node_id: "PR_node1",
    title: "Feature A",
    state: "open",
    base_branch: "main",
    head_branch: "feat-a",
    checks_status: "passing",
    review_status: "approved",
    additions: 10,
    deletions: 2,
    last_synced_at: "2026-04-01T00:00:00Z",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function buildService(opts: {
  prRows?: ReturnType<typeof makePrRow>[];
  lanes?: ReturnType<typeof makeLane>[];
  queueRows?: unknown[];
  rebaseSuggestions?: unknown[];
}) {
  const prRows = opts.prRows ?? [];
  const lanes = opts.lanes ?? [];
  const queueRows = opts.queueRows ?? [];
  const rebaseSuggestions = opts.rebaseSuggestions ?? [];

  const db = {
    get: vi.fn((sql: string, params?: unknown[]) => {
      const sqlLower = sql.toLowerCase();
      if (sqlLower.includes("from lanes where id =")) {
        const laneId = (params?.[0] ?? "") as string;
        const lane = lanes.find((l) => l.id === laneId);
        return lane ? { name: lane.name } : null;
      }
      if (sqlLower.includes("from pull_requests where lane_id =")) {
        const laneId = (params?.[0] ?? "") as string;
        const row = prRows.find((r) => r.lane_id === laneId);
        return row ?? null;
      }
      if (sqlLower.includes("from pull_requests where id =")) {
        const prId = (params?.[0] ?? "") as string;
        const row = prRows.find((r) => r.id === prId);
        return row ?? null;
      }
      return null;
    }),
    all: vi.fn((sql: string) => {
      const sqlLower = sql.toLowerCase();
      if (sqlLower.includes("from pull_requests")) return prRows;
      if (sqlLower.includes("from queue_landing_state")) return queueRows;
      if (sqlLower.includes("from integration_proposals")) return [];
      return [];
    }),
    run: vi.fn(),
    getJson: vi.fn(() => null),
    setJson: vi.fn(),
    sync: { getSiteId: vi.fn(), getDbVersion: vi.fn(), exportChangesSince: vi.fn(), applyChanges: vi.fn() },
    flushNow: vi.fn(),
    close: vi.fn(),
  } as any;

  const laneService = {
    list: vi.fn(async () => lanes),
    getLaneBaseAndBranch: vi.fn(),
    getStackChain: vi.fn(),
  } as any;

  const rebaseSuggestionService = {
    listSuggestions: vi.fn(async () => rebaseSuggestions),
  } as any;

  const service = createPrService({
    db,
    logger: makeLogger(),
    projectId: "proj-1",
    projectRoot: "/tmp/test",
    laneService,
    operationService: { start: vi.fn(() => ({ operationId: "op-1" })), finish: vi.fn() } as any,
    githubService: {
      getRepoOrThrow: vi.fn(async () => ({ owner: "owner", name: "repo" })),
      apiRequest: vi.fn(),
      getStatus: vi.fn(),
      setToken: vi.fn(),
      clearToken: vi.fn(),
      getTokenOrThrow: vi.fn(() => "ghp_mock"),
    } as any,
    projectConfigService: { get: vi.fn(() => ({ effective: { ai: {} } })) } as any,
    rebaseSuggestionService,
    openExternal: vi.fn(async () => {}),
  });

  return { service, db, laneService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prService.getMobileSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty snapshot when there are no PRs or lanes", async () => {
    const { service } = buildService({});
    const snapshot = await service.getMobileSnapshot();

    expect(snapshot.prs).toEqual([]);
    expect(snapshot.stacks).toEqual([]);
    expect(snapshot.workflowCards).toEqual([]);
    expect(snapshot.createCapabilities.canCreateAny).toBe(false);
    expect(snapshot.createCapabilities.lanes).toEqual([]);
    expect(snapshot.live).toBe(true);
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("emits ordered stack members with role and PR metadata", async () => {
    const rootLane = makeLane({ id: "lane-root", name: "root", parentLaneId: null });
    const childLane = makeLane({
      id: "lane-child",
      name: "child",
      parentLaneId: "lane-root",
      status: { dirty: true, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    });
    const rootPr = makePrRow({ id: "pr-root", lane_id: "lane-root", github_pr_number: 1, title: "root pr" });
    const childPr = makePrRow({
      id: "pr-child",
      lane_id: "lane-child",
      github_pr_number: 2,
      title: "child pr",
      state: "draft",
      checks_status: "failing",
    });

    const { service } = buildService({
      lanes: [rootLane, childLane],
      prRows: [rootPr, childPr],
    });

    const snapshot = await service.getMobileSnapshot();

    expect(snapshot.stacks).toHaveLength(1);
    const stack = snapshot.stacks[0];
    expect(stack.rootLaneId).toBe("lane-root");
    expect(stack.prCount).toBe(2);
    expect(stack.size).toBe(2);
    expect(stack.members.map((m) => m.laneId)).toEqual(["lane-root", "lane-child"]);
    expect(stack.members[0].role).toBe("root");
    expect(stack.members[0].depth).toBe(0);
    expect(stack.members[0].prNumber).toBe(1);
    expect(stack.members[0].dirty).toBe(false);
    expect(stack.members[1].role).toBe("leaf");
    expect(stack.members[1].depth).toBe(1);
    expect(stack.members[1].dirty).toBe(true);
    expect(stack.members[1].checksStatus).toBe("failing");
    expect(stack.members[1].prState).toBe("draft");
  });

  it("computes per-PR action capability gates with block reasons", async () => {
    const lane = makeLane({ id: "lane-1" });
    const openPr = makePrRow({ id: "pr-open", lane_id: "lane-1", state: "open", checks_status: "passing" });
    const draftPr = makePrRow({ id: "pr-draft", lane_id: "lane-2", state: "draft" });
    const failingPr = makePrRow({ id: "pr-fail", lane_id: "lane-3", state: "open", checks_status: "failing" });
    const mergedPr = makePrRow({ id: "pr-merged", lane_id: "lane-4", state: "merged" });

    const { service } = buildService({
      lanes: [lane],
      prRows: [openPr, draftPr, failingPr, mergedPr],
    });

    const snapshot = await service.getMobileSnapshot();

    expect(snapshot.capabilities["pr-open"].canMerge).toBe(true);
    expect(snapshot.capabilities["pr-open"].mergeBlockedReason).toBeNull();

    expect(snapshot.capabilities["pr-draft"].canMerge).toBe(false);
    expect(snapshot.capabilities["pr-draft"].mergeBlockedReason).toMatch(/Draft/);

    expect(snapshot.capabilities["pr-fail"].canMerge).toBe(false);
    expect(snapshot.capabilities["pr-fail"].mergeBlockedReason).toMatch(/failing/);

    expect(snapshot.capabilities["pr-merged"].canMerge).toBe(false);
    expect(snapshot.capabilities["pr-merged"].mergeBlockedReason).toMatch(/merged/);
    expect(snapshot.capabilities["pr-merged"].canReopen).toBe(false);

    for (const cap of Object.values(snapshot.capabilities)) {
      expect(cap.requiresLive).toBe(true);
    }
  });

  it("surfaces create-PR eligibility and flags lanes that already have a PR", async () => {
    const primary = makeLane({
      id: "lane-primary",
      name: "main",
      laneType: "primary",
      baseRef: "refs/heads/main",
      branchRef: "refs/heads/main",
    });
    const eligible = makeLane({ id: "lane-feat", name: "feat", parentLaneId: null });
    const blocked = makeLane({ id: "lane-blocked", name: "blocked", parentLaneId: null });
    const existingPr = makePrRow({ id: "pr-b", lane_id: "lane-blocked", state: "open", github_pr_number: 99 });

    const { service } = buildService({
      lanes: [primary, eligible, blocked],
      prRows: [existingPr],
    });

    const snapshot = await service.getMobileSnapshot();

    expect(snapshot.createCapabilities.canCreateAny).toBe(true);
    expect(snapshot.createCapabilities.defaultBaseBranch).toBe("main");
    const laneIds = snapshot.createCapabilities.lanes.map((lane) => lane.laneId).sort();
    expect(laneIds).toEqual(["lane-blocked", "lane-feat"]);

    const blockedEntry = snapshot.createCapabilities.lanes.find((lane) => lane.laneId === "lane-blocked")!;
    expect(blockedEntry.canCreate).toBe(false);
    expect(blockedEntry.hasExistingPr).toBe(true);
    expect(blockedEntry.blockedReason).toMatch(/#99/);

    const eligibleEntry = snapshot.createCapabilities.lanes.find((lane) => lane.laneId === "lane-feat")!;
    expect(eligibleEntry.canCreate).toBe(true);
    expect(eligibleEntry.blockedReason).toBeNull();
  });

  it("includes queue and rebase workflow cards and skips completed queues", async () => {
    const lane = makeLane({ id: "lane-1", name: "my-feature" });
    const parent = makeLane({ id: "lane-parent", name: "release", laneType: "primary" });
    const queueActive = {
      id: "queue-1",
      group_id: "group-1",
      state: "landing",
      entries_json: JSON.stringify([{ prId: "a" }, { prId: "b" }]),
      current_position: 0,
      started_at: "2026-04-01T00:00:00Z",
      completed_at: null,
      active_pr_id: "pr-a",
      wait_reason: null,
      last_error: null,
      updated_at: "2026-04-01T00:05:00Z",
    };
    const queueCompleted = {
      id: "queue-2",
      group_id: "group-2",
      state: "completed",
      entries_json: "[]",
      current_position: 0,
      started_at: "2026-04-01T00:00:00Z",
      completed_at: "2026-04-01T01:00:00Z",
      active_pr_id: null,
      wait_reason: null,
      last_error: null,
      updated_at: null,
    };

    const rebaseSuggestion = {
      laneId: "lane-1",
      parentLaneId: "lane-parent",
      parentHeadSha: "abc",
      behindCount: 3,
      baseLabel: "release",
      lastSuggestedAt: "2026-04-01T00:00:00Z",
      deferredUntil: null,
      dismissedAt: null,
      hasPr: false,
    };

    const { service } = buildService({
      lanes: [lane, parent],
      queueRows: [queueActive, queueCompleted],
      rebaseSuggestions: [rebaseSuggestion],
    });

    const snapshot = await service.getMobileSnapshot();

    const queueCards = snapshot.workflowCards.filter((card) => card.kind === "queue");
    expect(queueCards).toHaveLength(1);
    expect(queueCards[0]).toMatchObject({
      kind: "queue",
      groupId: "group-1",
      state: "landing",
      totalEntries: 2,
      activePrId: "pr-a",
    });

    const rebaseCards = snapshot.workflowCards.filter((card) => card.kind === "rebase");
    expect(rebaseCards).toHaveLength(1);
    expect(rebaseCards[0]).toMatchObject({
      kind: "rebase",
      laneId: "lane-1",
      laneName: "my-feature",
      behindBy: 3,
      baseBranch: "release",
    });
  });

  it("skips dismissed rebase suggestions", async () => {
    const lane = makeLane({ id: "lane-1", name: "my-feature" });
    const parent = makeLane({ id: "lane-parent", name: "release", laneType: "primary" });
    const dismissed = {
      laneId: "lane-1",
      parentLaneId: "lane-parent",
      parentHeadSha: "abc",
      behindCount: 3,
      baseLabel: "release",
      lastSuggestedAt: "2026-04-01T00:00:00Z",
      deferredUntil: null,
      dismissedAt: "2026-04-02T00:00:00Z",
      hasPr: false,
    };

    const { service } = buildService({
      lanes: [lane, parent],
      rebaseSuggestions: [dismissed],
    });

    const snapshot = await service.getMobileSnapshot();
    expect(snapshot.workflowCards.filter((card) => card.kind === "rebase")).toHaveLength(0);
  });
});
