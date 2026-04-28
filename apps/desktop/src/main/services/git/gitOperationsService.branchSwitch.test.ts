import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGit = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("./git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
  runGitOrThrow: (...args: unknown[]) => mockGit.runGitOrThrow(...args),
  getHeadSha: (...args: unknown[]) => mockGit.getHeadSha(...args),
}));

import { createGitOperationsService } from "./gitOperationsService";

function makeStubLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeServiceWithLanes(opts: {
  branchProfiles?: Array<{ branchRef: string }>;
  lanes?: Array<{ id: string; name: string; branchRef: string; laneType: string }>;
  switchBranch?: ReturnType<typeof vi.fn>;
  listBranchProfilesThrows?: boolean;
  listThrows?: boolean;
}) {
  const switchBranchMock = opts.switchBranch ?? vi.fn().mockResolvedValue({ lane: { id: "lane-1" }, previousBranchRef: "feature/old", activeWork: [] });

  const listBranchProfiles = opts.listBranchProfilesThrows
    ? vi.fn(() => { throw new Error("profile lookup failed"); })
    : vi.fn().mockReturnValue(opts.branchProfiles ?? []);

  const lanes = opts.lanes ?? [];
  const listBranchOwners = opts.listThrows
    ? vi.fn(() => { throw new Error("owner lookup failed"); })
    : vi.fn(({ excludeLaneId }: { excludeLaneId?: string } = {}) =>
        lanes
          .filter((l) => l.laneType !== "primary" && l.id !== excludeLaneId)
          .map((l) => ({ id: l.id, name: l.name, branchRef: l.branchRef })),
      );

  const service = createGitOperationsService({
    laneService: {
      getLaneBaseAndBranch: vi.fn().mockReturnValue({
        baseRef: "main",
        branchRef: "feature/source",
        worktreePath: "/tmp/ade-lane",
        laneType: "worktree",
      }),
      listBranchProfiles,
      listBranchOwners,
      switchBranch: switchBranchMock,
    } as any,
    operationService: {
      start: vi.fn().mockReturnValue({ operationId: "op-1" }),
      finish: vi.fn(),
    } as any,
    projectConfigService: {
      get: () => ({ effective: { ai: {} } }),
    } as any,
    aiIntegrationService: {
      getFeatureFlag: () => false,
      getStatus: vi.fn(async () => ({ availableModelIds: [] })),
      generateCommitMessage: vi.fn(),
    } as any,
    logger: makeStubLogger(),
  });

  return { service, switchBranchMock, listBranchProfiles, listBranchOwners };
}

describe("gitOperationsService.listBranches annotations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("annotates branches with profile-in-lane and active owner metadata", async () => {
    mockGit.runGitOrThrow.mockResolvedValue(
      [
        "refs/heads/main\tmain\t \torigin/main",
        "refs/heads/feature/source\tfeature/source\t*\t",
        "refs/heads/feature/owned\tfeature/owned\t \t",
        "refs/remotes/origin/feature/remote-only\torigin/feature/remote-only\t \t",
        "refs/remotes/origin/main\torigin/main\t \t",
      ].join("\n"),
    );

    const { service, listBranchProfiles, listBranchOwners } = makeServiceWithLanes({
      branchProfiles: [
        { branchRef: "feature/source" },
        { branchRef: "feature/profiled-but-no-local" },
      ],
      lanes: [
        { id: "lane-1", name: "Source", branchRef: "feature/source", laneType: "worktree" },
        { id: "lane-2", name: "Owner Lane", branchRef: "feature/owned", laneType: "worktree" },
        { id: "lane-primary", name: "Primary", branchRef: "main", laneType: "primary" },
      ],
    });

    const branches = await service.listBranches({ laneId: "lane-1" });
    expect(listBranchProfiles).toHaveBeenCalledWith("lane-1");
    expect(listBranchOwners).toHaveBeenCalledWith({ excludeLaneId: "lane-1" });

    const byName = new Map(branches.map((b) => [b.name, b]));

    // current branch (lane-1's own branch) is profiled in lane-1, owner skipped
    // because it equals the calling lane's id.
    const source = byName.get("feature/source");
    expect(source).toBeDefined();
    expect(source!.profiledInCurrentLane).toBe(true);
    expect(source!.ownedByLaneId).toBeNull();
    expect(source!.ownedByLaneName).toBeNull();
    expect(source!.isCurrent).toBe(true);

    // lane-2 owns "feature/owned"
    const owned = byName.get("feature/owned");
    expect(owned).toBeDefined();
    expect(owned!.ownedByLaneId).toBe("lane-2");
    expect(owned!.ownedByLaneName).toBe("Owner Lane");
    expect(owned!.profiledInCurrentLane).toBe(false);

    // primary lane branches are excluded from the active-owner map (so main is not "owned")
    const main = byName.get("main");
    expect(main).toBeDefined();
    expect(main!.ownedByLaneId).toBeNull();
    expect(main!.profiledInCurrentLane).toBe(false);

    // remote-only branch is preserved and annotated; localBranchNameFromRemoteRef
    // strips the remote name ("origin/feature/remote-only" → "feature/remote-only").
    const remoteOnly = byName.get("origin/feature/remote-only");
    expect(remoteOnly).toBeDefined();
    expect(remoteOnly!.isRemote).toBe(true);
    expect(remoteOnly!.profiledInCurrentLane).toBe(false);
  });

  it("still returns branches when listing lanes throws (best-effort owner lookup)", async () => {
    mockGit.runGitOrThrow.mockResolvedValue(
      "refs/heads/main\tmain\t*\t\nrefs/heads/feature/x\tfeature/x\t \t",
    );
    const { service } = makeServiceWithLanes({ listThrows: true });

    const branches = await service.listBranches({ laneId: "lane-1" });
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(branch.ownedByLaneId).toBeNull();
    }
  });

  it("dedupes a remote ref when its local counterpart already exists", async () => {
    mockGit.runGitOrThrow.mockResolvedValue(
      [
        "refs/heads/feature/dup\tfeature/dup\t*\t",
        "refs/remotes/origin/feature/dup\torigin/feature/dup\t \t",
      ].join("\n"),
    );
    const { service } = makeServiceWithLanes({});

    const branches = await service.listBranches({ laneId: "lane-1" });
    // Only the local copy should appear; the remote duplicate is filtered out.
    expect(branches.filter((b) => b.name === "feature/dup")).toHaveLength(1);
    expect(branches.find((b) => b.name === "origin/feature/dup")).toBeUndefined();
  });

  it("filters refs/remotes/.../HEAD entries out of the result", async () => {
    mockGit.runGitOrThrow.mockResolvedValue(
      [
        "refs/heads/main\tmain\t*\t",
        "refs/remotes/origin/HEAD\torigin/HEAD\t \t",
      ].join("\n"),
    );
    const { service } = makeServiceWithLanes({});

    const branches = await service.listBranches({ laneId: "lane-1" });
    expect(branches.find((b) => b.name === "origin/HEAD")).toBeUndefined();
  });
});

describe("gitOperationsService.checkoutBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects empty branch names", async () => {
    const { service } = makeServiceWithLanes({});
    await expect(service.checkoutBranch({ laneId: "lane-1", branchName: "  " }))
      .rejects.toThrow(/Branch name is required/);
  });

  it("delegates to laneService.switchBranch and forwards mode/startPoint/baseRef in op metadata", async () => {
    mockGit.getHeadSha.mockResolvedValue("sha-pre");
    const operationStart = vi.fn().mockReturnValue({ operationId: "op-99" });
    const operationFinish = vi.fn();
    const switchBranch = vi.fn().mockResolvedValue({ lane: { id: "lane-1" }, previousBranchRef: "feature/old", activeWork: [] });

    const service = createGitOperationsService({
      laneService: {
        getLaneBaseAndBranch: vi.fn().mockReturnValue({
          baseRef: "main",
          branchRef: "feature/old",
          worktreePath: "/tmp/ade-lane",
          laneType: "worktree",
        }),
        listBranchProfiles: vi.fn().mockReturnValue([]),
        listBranchOwners: vi.fn().mockReturnValue([]),
        switchBranch,
      } as any,
      operationService: { start: operationStart, finish: operationFinish } as any,
      projectConfigService: { get: () => ({ effective: { ai: {} } }) } as any,
      aiIntegrationService: {
        getFeatureFlag: () => false,
        getStatus: vi.fn(async () => ({ availableModelIds: [] })),
        generateCommitMessage: vi.fn(),
      } as any,
      logger: makeStubLogger(),
    });

    await service.checkoutBranch({
      laneId: "lane-1",
      branchName: "feature/new",
      mode: "create",
      startPoint: "main",
      baseRef: "main",
      acknowledgeActiveWork: true,
    });

    expect(switchBranch).toHaveBeenCalledWith({
      laneId: "lane-1",
      branchName: "feature/new",
      mode: "create",
      startPoint: "main",
      baseRef: "main",
      acknowledgeActiveWork: true,
    });

    expect(operationStart).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        kind: "git_checkout_branch",
        metadata: expect.objectContaining({
          reason: "checkout_branch",
          branchName: "feature/new",
          mode: "create",
          startPoint: "main",
          baseRef: "main",
        }),
      }),
    );
    expect(operationFinish).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-99", status: "succeeded" }),
    );
  });

  it("defaults mode to 'existing' and nulls metadata for omitted optional args", async () => {
    mockGit.getHeadSha.mockResolvedValue("sha-pre");
    const operationStart = vi.fn().mockReturnValue({ operationId: "op-1" });
    const switchBranch = vi.fn().mockResolvedValue({ lane: { id: "lane-1" }, previousBranchRef: "main", activeWork: [] });

    const service = createGitOperationsService({
      laneService: {
        getLaneBaseAndBranch: vi.fn().mockReturnValue({
          baseRef: "main", branchRef: "main", worktreePath: "/tmp/ade-lane", laneType: "worktree",
        }),
        listBranchProfiles: vi.fn().mockReturnValue([]),
        listBranchOwners: vi.fn().mockReturnValue([]),
        switchBranch,
      } as any,
      operationService: { start: operationStart, finish: vi.fn() } as any,
      projectConfigService: { get: () => ({ effective: { ai: {} } }) } as any,
      aiIntegrationService: {
        getFeatureFlag: () => false,
        getStatus: vi.fn(async () => ({ availableModelIds: [] })),
        generateCommitMessage: vi.fn(),
      } as any,
      logger: makeStubLogger(),
    });

    await service.checkoutBranch({ laneId: "lane-1", branchName: "feature/foo" });

    expect(operationStart).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          mode: "existing",
          startPoint: null,
          baseRef: null,
        }),
      }),
    );
    // switchBranch still receives the raw args (no defaults injected upstream).
    expect(switchBranch).toHaveBeenCalledWith({ laneId: "lane-1", branchName: "feature/foo" });
  });
});
