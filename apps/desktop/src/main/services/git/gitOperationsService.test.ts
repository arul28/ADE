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

const STASH_LIST_FORMAT = "--format=%H%x1f%gd%x1f%cI%x1f%gs";

function createTestGitOperationsService(
  branchRef = "feature/stash-test",
  overrides: { worktreePath?: string } = {},
) {
  const mockStart = vi.fn().mockReturnValue({ operationId: "op-1" });
  const mockFinish = vi.fn();
  const mockList = vi.fn().mockReturnValue([]);
  const mockListHeadChanges = vi.fn().mockReturnValue([]);
  const mockInvalidateListCache = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const service = createGitOperationsService({
    laneService: {
      getLaneBaseAndBranch: vi.fn().mockReturnValue({
        baseRef: "main",
        branchRef,
        worktreePath: overrides.worktreePath ?? "/tmp/ade-lane",
        laneType: "worktree",
      }),
      invalidateListCache: mockInvalidateListCache,
    } as any,
    operationService: {
      start: mockStart,
      finish: mockFinish,
      list: mockList,
      listHeadChanges: mockListHeadChanges,
    } as any,
    projectConfigService: {
      get: () => ({ effective: { ai: {} } }),
    } as any,
    aiIntegrationService: {
      getFeatureFlag: () => false,
      getStatus: vi.fn(async () => ({ availableModelIds: [] })),
      generateCommitMessage: vi.fn(),
    } as any,
    logger: mockLogger as any,
  });

  return {
    service,
    mockStart,
    mockFinish,
    mockList,
    mockListHeadChanges,
    mockInvalidateListCache,
    mockLogger,
  };
}

describe("gitOperationsService.stashClear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops only stashes saved for the lane branch", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "stash" && args[1] === "list") {
        return [
          "oid-0\u001fstash@{0}\u001f2026-05-12T02:09:32-04:00\u001fOn feature/stash-test: keep for this lane",
          "oid-other\u001fstash@{1}\u001f2026-05-12T02:08:32-04:00\u001fOn other-branch: leave alone",
          "oid-2\u001fstash@{2}\u001f2026-05-12T02:07:32-04:00\u001fWIP on feature/stash-test: abc123 work",
        ].join("\n");
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (args[2] === "stash@{2}") return "oid-2\n";
        if (args[2] === "stash@{0}") return "oid-0\n";
      }
      return undefined;
    });
    const { service, mockStart, mockFinish, mockInvalidateListCache } = createTestGitOperationsService();

    const result = await service.stashClear({ laneId: "lane-1" });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      1,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      2,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--verify", "stash@{2}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      4,
      ["stash", "drop", "stash@{2}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      5,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      6,
      ["rev-parse", "--verify", "stash@{0}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      7,
      ["stash", "drop", "stash@{0}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(result).toEqual({
      operationId: "op-1",
      preHeadSha: "abc123",
      postHeadSha: "abc123",
    });
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        kind: "git_stash_clear",
      }),
    );
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        status: "succeeded",
      }),
    );
    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
  });

  it("re-resolves stash refs by oid before each clear drop when ordinals shift", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    const initial = "oid-lane\u001fstash@{2}\u001f2026-05-12T02:07:32-04:00\u001fOn feature/stash-test: shifted";
    const shifted = "oid-lane\u001fstash@{1}\u001f2026-05-12T02:07:32-04:00\u001fOn feature/stash-test: shifted";
    let listCalls = 0;
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "stash" && args[1] === "list") {
        listCalls += 1;
        return listCalls === 1 ? initial : shifted;
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return "oid-lane\n";
      return undefined;
    });
    const { service } = createTestGitOperationsService();

    await service.stashClear({ laneId: "lane-1" });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--verify", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      4,
      ["stash", "drop", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
  });
});

describe("gitOperationsService.getSyncStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a configured upstream as missing when the remote branch was deleted", async () => {
    mockGit.runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { exitCode: 128, stdout: "", stderr: "upstream gone" };
      }
      if (args[0] === "config" && args[2] === "branch.feature/stash-test.remote") {
        return { exitCode: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "config" && args[2] === "branch.feature/stash-test.merge") {
        return { exitCode: 0, stdout: "refs/heads/feature/stash-test\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
    });

    const { service } = createTestGitOperationsService("feature/stash-test");

    await expect(service.getSyncStatus({ laneId: "lane-1" })).resolves.toEqual({
      hasUpstream: false,
      upstreamState: "missing",
      upstreamRef: "origin/feature/stash-test",
      ahead: 0,
      behind: 0,
      diverged: false,
      recommendedAction: "push",
    });
  });
});

describe("gitOperationsService.pull", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the requested pull mode and records it in operation metadata", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockStart } = createTestGitOperationsService();

    await service.pull({ laneId: "lane-1" });
    await service.pull({ laneId: "lane-1", mode: "rebase" });
    await service.pull({ laneId: "lane-1", mode: "merge" });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      1,
      ["pull", "--ff-only"],
      { cwd: "/tmp/ade-lane", timeoutMs: 60_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      2,
      ["pull", "--rebase"],
      { cwd: "/tmp/ade-lane", timeoutMs: 60_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      3,
      ["pull", "--no-rebase", "--no-edit"],
      { cwd: "/tmp/ade-lane", timeoutMs: 60_000 },
    );
    expect(mockStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        laneId: "lane-1",
        kind: "git_pull",
        metadata: expect.objectContaining({ reason: "pull_ff_only", mode: "ff-only" }),
      }),
    );
    expect(mockStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "pull_rebase", mode: "rebase" }),
      }),
    );
    expect(mockStart).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "pull_merge", mode: "merge" }),
      }),
    );
  });

  it("rejects unknown pull modes before running git", async () => {
    const { service } = createTestGitOperationsService();

    await expect(service.pull({ laneId: "lane-1", mode: "squash" } as any))
      .rejects.toThrow("git.pull mode must be ff-only, rebase, or merge.");
    expect(mockGit.runGitOrThrow).not.toHaveBeenCalled();
  });
});

describe("gitOperationsService undo and redo head changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("undoes the latest recorded head-changing operation with a guarded hard reset", async () => {
    mockGit.getHeadSha
      .mockResolvedValueOnce("after")
      .mockResolvedValueOnce("after")
      .mockResolvedValueOnce("before");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockStart, mockList, mockListHeadChanges } = createTestGitOperationsService();
    mockListHeadChanges.mockReturnValue([
      {
        id: "op-pick",
        laneId: "lane-1",
        laneName: "Lane",
        kind: "git_cherry_pick",
        startedAt: "2026-05-22T00:00:00.000Z",
        endedAt: "2026-05-22T00:00:01.000Z",
        status: "succeeded",
        preHeadSha: "before",
        postHeadSha: "after",
        metadataJson: JSON.stringify({ branchRef: "feature/stash-test" }),
      },
    ]);

    await service.undoLastHeadChange({ laneId: "lane-1" });

    expect(mockListHeadChanges).toHaveBeenCalledWith({ laneId: "lane-1", limit: 100 });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["reset", "--hard", "before"],
      { cwd: "/tmp/ade-lane", timeoutMs: 60_000 },
    );
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "git_undo_head_change",
        metadata: expect.objectContaining({
          undoneOperationId: "op-pick",
          redoHeadSha: "after",
          targetHeadSha: "before",
        }),
      }),
    );
  });

  it("redoes the latest undo operation only when it is still the latest head change", async () => {
    mockGit.getHeadSha
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockListHeadChanges } = createTestGitOperationsService();
    mockListHeadChanges.mockReturnValue([
      {
        id: "op-undo",
        laneId: "lane-1",
        laneName: "Lane",
        kind: "git_undo_head_change",
        startedAt: "2026-05-22T00:00:00.000Z",
        endedAt: "2026-05-22T00:00:01.000Z",
        status: "succeeded",
        preHeadSha: "after",
        postHeadSha: "before",
        metadataJson: JSON.stringify({ redoHeadSha: "after" }),
      },
    ]);

    await service.redoLastHeadChange({ laneId: "lane-1" });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["reset", "--hard", "after"],
      { cwd: "/tmp/ade-lane", timeoutMs: 60_000 },
    );
  });

  it("does not undo an already-undone head change through the undo command", async () => {
    const { service, mockListHeadChanges } = createTestGitOperationsService();
    mockListHeadChanges.mockReturnValue([
      {
        id: "op-undo",
        laneId: "lane-1",
        laneName: "Lane",
        kind: "git_undo_head_change",
        startedAt: "2026-05-22T00:00:00.000Z",
        endedAt: "2026-05-22T00:00:01.000Z",
        status: "succeeded",
        preHeadSha: "after",
        postHeadSha: "before",
        metadataJson: JSON.stringify({ redoHeadSha: "after" }),
      },
    ]);

    await expect(service.undoLastHeadChange({ laneId: "lane-1" }))
      .rejects.toThrow("No undoable head-changing git operation found for this branch.");
    expect(mockGit.runGitOrThrow).not.toHaveBeenCalled();
  });

  it("does not look past branch checkout into another branch when undoing", async () => {
    const { service, mockListHeadChanges } = createTestGitOperationsService();
    mockListHeadChanges.mockReturnValue([
      {
        id: "op-checkout",
        laneId: "lane-1",
        laneName: "Lane",
        kind: "git_checkout_branch",
        startedAt: "2026-05-22T00:00:02.000Z",
        endedAt: "2026-05-22T00:00:03.000Z",
        status: "succeeded",
        preHeadSha: "before",
        postHeadSha: "after",
        metadataJson: JSON.stringify({ branchRef: "feature/old" }),
      },
      {
        id: "op-pick",
        laneId: "lane-1",
        laneName: "Lane",
        kind: "git_cherry_pick",
        startedAt: "2026-05-22T00:00:00.000Z",
        endedAt: "2026-05-22T00:00:01.000Z",
        status: "succeeded",
        preHeadSha: "before",
        postHeadSha: "after",
        metadataJson: JSON.stringify({ branchRef: "feature/old" }),
      },
    ]);

    await expect(service.undoLastHeadChange({ laneId: "lane-1" }))
      .rejects.toThrow("No undoable head-changing git operation found for this branch.");

    expect(mockGit.runGitOrThrow).not.toHaveBeenCalled();
    expect(mockListHeadChanges).toHaveBeenCalledWith({ laneId: "lane-1", limit: 100 });
  });
});

describe("gitOperationsService stash item commands", () => {
  const branchStashList = [
    "oid-0\u001fstash@{0}\u001f2026-05-12T02:09:32-04:00\u001fOn feature/stash-test: first",
    "oid-1\u001fstash@{1}\u001f2026-05-12T02:08:32-04:00\u001fWIP on feature/stash-test: abc123 work",
    "oid-2\u001fstash@{2}\u001f2026-05-12T02:07:32-04:00\u001fOn other-branch: hidden",
  ].join("\n");
  const resolveStashOid = (stashRef: string | undefined): string | undefined => {
    if (stashRef === "stash@{0}") return "oid-0\n";
    if (stashRef === "stash@{1}") return "oid-1\n";
    if (stashRef === "stash@{2}") return "oid-2\n";
    return undefined;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists stashes with ordinal refs and ISO timestamps", async () => {
    mockGit.runGitOrThrow.mockResolvedValue([
      "oid-0\u001fstash@{0}\u001f2026-05-12T02:09:32-04:00\u001fOn feature/stash-test: test",
      "oid-1\u001fstash@{1}\u001f2026-05-12T02:08:32-04:00\u001fWIP on feature/stash-test: abc123 work",
      "oid-2\u001fstash@{2}\u001f2026-05-12T02:07:32-04:00\u001fOn other-branch: hidden",
    ].join("\n"));
    const { service } = createTestGitOperationsService();

    await expect(service.listStashes({ laneId: "lane-1" })).resolves.toEqual([
      {
        oid: "oid-0",
        ref: "stash@{0}",
        createdAt: "2026-05-12T02:09:32-04:00",
        subject: "On feature/stash-test: test",
      },
      {
        oid: "oid-1",
        ref: "stash@{1}",
        createdAt: "2026-05-12T02:08:32-04:00",
        subject: "WIP on feature/stash-test: abc123 work",
      },
    ]);
    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
  });

  it("applies then drops a stash when restoring it", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "stash" && args[1] === "list") return branchStashList;
      if (args[0] === "rev-parse" && args[1] === "--verify") return resolveStashOid(args[2]);
      return undefined;
    });
    const { service, mockStart, mockFinish } = createTestGitOperationsService();

    const result = await service.stashPop({ laneId: "lane-1", stashRef: "stash@{1}", stashOid: "oid-1" });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      1,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      2,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--verify", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      4,
      ["stash", "apply", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      5,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      6,
      ["rev-parse", "--verify", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      7,
      ["stash", "drop", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(7);
    expect(result).toEqual({
      operationId: "op-1",
      preHeadSha: "abc123",
      postHeadSha: "abc123",
    });
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        kind: "git_stash_pop",
        metadata: expect.objectContaining({ stashRef: "stash@{1}", stashOid: "oid-1" }),
      }),
    );
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        status: "succeeded",
      }),
    );
  });

  it("keeps the stash when restore apply fails", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "stash" && args[1] === "list") return branchStashList;
      if (args[0] === "rev-parse" && args[1] === "--verify") return resolveStashOid(args[2]);
      if (args[0] === "stash" && args[1] === "apply") throw new Error("apply failed");
      return undefined;
    });
    const { service } = createTestGitOperationsService();

    await expect(service.stashPop({ laneId: "lane-1", stashRef: "stash@{1}", stashOid: "oid-1" })).rejects.toThrow("apply failed");

    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(4);
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      4,
      ["stash", "apply", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
  });

  it("succeeds restore when drop fails after apply", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "stash" && args[1] === "list") return branchStashList;
      if (args[0] === "rev-parse" && args[1] === "--verify") return resolveStashOid(args[2]);
      if (args[0] === "stash" && args[1] === "drop") throw new Error("drop failed");
      return undefined;
    });
    const { service, mockFinish, mockLogger } = createTestGitOperationsService();

    const result = await service.stashPop({ laneId: "lane-1", stashRef: "stash@{1}", stashOid: "oid-1" });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      1,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      2,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--verify", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      4,
      ["stash", "apply", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      5,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      6,
      ["rev-parse", "--verify", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      7,
      ["stash", "drop", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        status: "succeeded",
      }),
    );
    expect(result).toEqual({
      operationId: "op-1",
      preHeadSha: "abc123",
      postHeadSha: "abc123",
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "git.stash_pop_drop_failed",
      expect.objectContaining({
        laneId: "lane-1",
        stashRef: "stash@{1}",
        error: "drop failed",
      }),
    );
  });

  it("calls git stash drop with the lane worktree path and stash ref", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "stash" && args[1] === "list") return branchStashList;
      if (args[0] === "rev-parse" && args[1] === "--verify") return resolveStashOid(args[2]);
      return undefined;
    });
    const { service, mockStart, mockFinish } = createTestGitOperationsService();

    const result = await service.stashDrop({ laneId: "lane-1", stashRef: "stash@{0}", stashOid: "oid-0" });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      1,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      2,
      ["stash", "list", STASH_LIST_FORMAT],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--verify", "stash@{0}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      4,
      ["stash", "drop", "stash@{0}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(result).toEqual({
      operationId: "op-1",
      preHeadSha: "abc123",
      postHeadSha: "abc123",
    });
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        kind: "git_stash_drop",
        metadata: expect.objectContaining({ stashRef: "stash@{0}", stashOid: "oid-0" }),
      }),
    );
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        status: "succeeded",
      }),
    );
  });

  it("uses stash oid when the selected ordinal shifted before dropping it", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) => {
      if (args[0] === "stash" && args[1] === "list") {
        return [
          "oid-new\u001fstash@{0}\u001f2026-05-12T02:10:32-04:00\u001fOn feature/stash-test: newer",
          "oid-0\u001fstash@{1}\u001f2026-05-12T02:09:32-04:00\u001fOn feature/stash-test: shifted",
        ].join("\n");
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (args[2] === "stash@{0}") return "oid-new\n";
        if (args[2] === "stash@{1}") return "oid-0\n";
      }
      return undefined;
    });
    const { service, mockStart } = createTestGitOperationsService();

    await service.stashDrop({ laneId: "lane-1", stashRef: "stash@{0}", stashOid: "oid-0" });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--verify", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 8_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      4,
      ["stash", "drop", "stash@{1}"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        kind: "git_stash_drop",
        metadata: expect.objectContaining({ stashRef: "stash@{0}", stashOid: "oid-0" }),
      }),
    );
  });

  it("requires a stash oid before destructive stash actions", async () => {
    const { service } = createTestGitOperationsService();

    await expect(service.stashPop({ laneId: "lane-1", stashRef: "stash@{0}" }))
      .rejects.toThrow("stashOid is required to pop a saved stash");
    await expect(service.stashDrop({ laneId: "lane-1", stashRef: "stash@{0}" }))
      .rejects.toThrow("stashOid is required to drop a saved stash");
    expect(mockGit.runGitOrThrow).not.toHaveBeenCalled();
  });

  it("does not apply a stash from another branch", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockImplementation(async (args: string[]) =>
      args[0] === "stash" && args[1] === "list" ? branchStashList : undefined
    );
    const { service } = createTestGitOperationsService();

    await expect(service.stashApply({ laneId: "lane-1", stashRef: "stash@{2}" }))
      .rejects.toThrow("Stash stash@{2} is not saved for branch feature/stash-test.");
    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe("gitOperationsService.commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefixes commits from linked Linear lanes with a non-closing reference", async () => {
    mockGit.getHeadSha.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const mockStart = vi.fn().mockReturnValue({ operationId: "op-1" });
    const service = createGitOperationsService({
      laneService: {
        getLaneBaseAndBranch: vi.fn().mockReturnValue({
          baseRef: "main",
          branchRef: "ade-123-linked-commit",
          worktreePath: "/tmp/ade-lane",
          laneType: "worktree",
          linearIssue: {
            id: "issue-1",
            identifier: "ADE-123",
            title: "Linked commit",
            description: null,
            url: null,
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
      } as any,
      operationService: {
        start: mockStart,
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
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
    });

    await service.commit({ laneId: "lane-1", message: "Update git service" });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["commit", "-m", "Refs ADE-123: Update git service"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ message: "Refs ADE-123: Update git service" }),
      }),
    );
  });
});

describe("gitOperationsService commit graph actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates annotated and lightweight tags at a selected commit", async () => {
    mockGit.getHeadSha.mockResolvedValue("head");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockStart } = createTestGitOperationsService();

    await service.createTag({
      laneId: "lane-1",
      commitSha: "abc123",
      tagName: "v1.2.3",
      message: "release",
    });
    await service.createTag({
      laneId: "lane-1",
      commitSha: "def456",
      tagName: "checkpoint",
    });

    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      1,
      ["tag", "-a", "v1.2.3", "abc123", "-m", "release"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockGit.runGitOrThrow).toHaveBeenNthCalledWith(
      2,
      ["tag", "checkpoint", "def456"],
      { cwd: "/tmp/ade-lane", timeoutMs: 30_000 },
    );
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "git_tag_create",
        metadata: expect.objectContaining({ tagName: "v1.2.3", annotated: true }),
      }),
    );
  });

  it("resets the lane branch to a selected commit with the chosen mode", async () => {
    mockGit.getHeadSha.mockResolvedValue("head");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockStart } = createTestGitOperationsService();

    await service.resetToCommit({
      laneId: "lane-1",
      commitSha: "abc123",
      mode: "hard",
    });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["reset", "--hard", "abc123"],
      { cwd: "/tmp/ade-lane", timeoutMs: 60_000 },
    );
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "git_reset_hard",
        metadata: expect.objectContaining({ commitSha: "abc123", mode: "hard" }),
      }),
    );
  });

  it("rejects empty or option-like tag names", async () => {
    const { service } = createTestGitOperationsService();

    await expect(service.createTag({
      laneId: "lane-1",
      commitSha: "abc123",
      tagName: "  ",
    })).rejects.toThrow("Tag name is required");
    await expect(service.createTag({
      laneId: "lane-1",
      commitSha: "abc123",
      tagName: "-bad",
    })).rejects.toThrow("Invalid tag name");
  });
});

describe("gitOperationsService.generateCommitMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the configured model and sends a lightweight changed-files prompt", async () => {
    let capturedPrompt = "";
    let capturedModel = "";

    mockGit.runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff") {
        return {
          exitCode: 0,
          stdout: "M\tapps/desktop/src/main/foo.ts\nA\tapps/desktop/src/main/bar.ts\n",
          stderr: "",
        };
      }
      if (args[0] === "show") {
        return {
          exitCode: 0,
          stdout: "M\tapps/desktop/src/main/previous.ts\n",
          stderr: "",
        };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `unexpected git command: ${args.join(" ")}`,
      };
    });

    const service = createGitOperationsService({
      laneService: {
        getLaneBaseAndBranch: () => ({
          baseRef: "main",
          branchRef: "feature/commit-messages",
          worktreePath: "/tmp/ade-lane",
          laneType: "worktree",
        }),
      } as any,
      operationService: {
        start: vi.fn(),
        finish: vi.fn(),
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              featureModelOverrides: {
                commit_messages: "anthropic/claude-haiku-4-5",
              },
            },
          },
        }),
      } as any,
      aiIntegrationService: {
        getFeatureFlag: () => true,
        getStatus: vi.fn(async () => ({
          availableModelIds: ["anthropic/claude-haiku-4-5"],
        })),
        generateCommitMessage: vi.fn(async (args: { prompt: string; model?: string }) => {
          capturedPrompt = args.prompt;
          capturedModel = args.model ?? "";
          return {
            text: "Update git service.",
            structuredOutput: null,
            provider: "anthropic",
            model: null,
            sessionId: null,
            inputTokens: null,
            outputTokens: null,
            durationMs: 5,
          };
        }),
      } as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
    });

    const result = await service.generateCommitMessage({ laneId: "lane-1" });

    expect(result).toEqual({
      message: "Update git service",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(capturedModel).toBe("anthropic/claude-haiku-4-5");
    expect(capturedPrompt).toContain("Changed files:");
    expect(capturedPrompt).toContain("M\tapps/desktop/src/main/foo.ts");
    expect(capturedPrompt).toContain("A\tapps/desktop/src/main/bar.ts");
    expect(capturedPrompt).toContain("- fewer than 10 words");
    expect(capturedPrompt).not.toContain("Staged diff stat");
    expect(capturedPrompt).not.toContain("Staged patch preview");
    expect(capturedPrompt).not.toContain("Branch:");
    expect(capturedPrompt).toContain("Diff:");
    expect(mockGit.runGit.mock.calls.map((call) => call[0])).toEqual([
      ["diff", "--cached", "--name-status", "--find-renames"],
      ["show", "--name-status", "--format=", "--find-renames", "HEAD"],
      ["diff", "--cached", "--no-color", "-U2", "--find-renames"],
    ]);
  });

  it("prefixes generated commit messages with a Linear reference for linked lanes", async () => {
    mockGit.runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff") {
        return {
          exitCode: 0,
          stdout: "M\tapps/desktop/src/main/foo.ts\n",
          stderr: "",
        };
      }
      if (args[0] === "show") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
    });

    const service = createGitOperationsService({
      laneService: {
        getLaneBaseAndBranch: () => ({
          baseRef: "main",
          branchRef: "ade-123-connect-linear-commits",
          worktreePath: "/tmp/ade-lane",
          laneType: "worktree",
          linearIssue: {
            id: "issue-1",
            identifier: "ADE-123",
            title: "Connect Linear commits",
            description: null,
            url: null,
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
      } as any,
      operationService: {
        start: vi.fn(),
        finish: vi.fn(),
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              featureModelOverrides: {
                commit_messages: "anthropic/claude-haiku-4-5",
              },
            },
          },
        }),
      } as any,
      aiIntegrationService: {
        getFeatureFlag: () => true,
        getStatus: vi.fn(async () => ({
          availableModelIds: ["anthropic/claude-haiku-4-5"],
        })),
        generateCommitMessage: vi.fn(async () => ({
          text: "Update git service.",
          structuredOutput: null,
          provider: "anthropic",
          model: null,
          sessionId: null,
          inputTokens: null,
          outputTokens: null,
          durationMs: 5,
        })),
      } as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
    });

    const result = await service.generateCommitMessage({ laneId: "lane-1" });

    expect(result).toEqual({
      message: "Refs ADE-123: Update git service",
      model: "anthropic/claude-haiku-4-5",
    });
  });
});

describe("gitOperationsService cached lane reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("coalesces concurrent getSyncStatus calls for the same lane", async () => {
    let releaseUpstreamLookup!: () => void;
    const upstreamLookupGate = new Promise<void>((resolve) => {
      releaseUpstreamLookup = resolve;
    });

    mockGit.runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        await upstreamLookupGate;
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "reflog") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
    });

    const { service } = createTestGitOperationsService();
    const first = service.getSyncStatus({ laneId: "lane-1" });
    const second = service.getSyncStatus({ laneId: "lane-1" });

    releaseUpstreamLookup();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(mockGit.runGit).toHaveBeenCalledTimes(2);
    expect(mockGit.runGit).toHaveBeenNthCalledWith(
      1,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      expect.objectContaining({ cwd: "/tmp/ade-lane" }),
    );
    expect(mockGit.runGit).toHaveBeenNthCalledWith(
      2,
      ["rev-list", "--left-right", "--count", "origin/main...HEAD"],
      expect.objectContaining({ cwd: "/tmp/ade-lane" }),
    );
  });

  it("reuses a fresh cached commit list for immediate repeat reads", async () => {
    mockGit.runGitOrThrow.mockResolvedValue(
      "abc123\u001fab\u001fparent123\u001fArul\u001f2026-04-11T21:00:00.000Z\u001fInitial commit",
    );
    mockGit.runGit.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "no upstream",
    });

    const { service } = createTestGitOperationsService();

    const first = await service.listRecentCommits({ laneId: "lane-1", limit: 20 });
    const second = await service.listRecentCommits({ laneId: "lane-1", limit: 20 });

    expect(first).toEqual(second);
    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(1);
    expect(mockGit.runGit).toHaveBeenCalledTimes(1);
  });

  it("reports a missing lane worktree as lane state for commit history", async () => {
    mockGit.runGitOrThrow.mockRejectedValue(
      new Error("git working directory not found: /tmp/missing-lane"),
    );

    const { service } = createTestGitOperationsService("feature/stash-test", {
      worktreePath: "/tmp/missing-lane",
    });

    await expect(service.listRecentCommits({ laneId: "lane-1", limit: 20 })).rejects.toThrow(
      "Lane worktree is missing. Restore or recreate the lane worktree at /tmp/missing-lane before viewing history.",
    );
    expect(mockGit.runGit).not.toHaveBeenCalled();
  });

  it("parses file history entries for modified and renamed files", async () => {
    mockGit.runGitOrThrow.mockResolvedValue(
      [
        "\u001eabc123\u001fab\u001fArul\u001f2026-04-11T21:00:00.000Z\u001fRename file",
        "R100\tsrc/old.ts\tsrc/new.ts",
        "",
        "\u001edef456\u001fde\u001fArul\u001f2026-04-10T10:00:00.000Z\u001fUpdate file",
        "M\tsrc/new.ts",
      ].join("\n"),
    );

    const { service } = createTestGitOperationsService();

    const history = await service.getFileHistory({ laneId: "lane-1", path: "src/new.ts", limit: 2 });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      [
        "log",
        "--follow",
        "-n2",
        "--date=iso-strict",
        "--name-status",
        "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s",
        "--",
        "src/new.ts",
      ],
      expect.objectContaining({ cwd: "/tmp/ade-lane" }),
    );
    expect(history).toEqual([
      {
        commitSha: "abc123",
        shortSha: "ab",
        authorName: "Arul",
        authoredAt: "2026-04-11T21:00:00.000Z",
        subject: "Rename file",
        path: "src/new.ts",
        previousPath: "src/old.ts",
        changeType: "renamed",
      },
      {
        commitSha: "def456",
        shortSha: "de",
        authorName: "Arul",
        authoredAt: "2026-04-10T10:00:00.000Z",
        subject: "Update file",
        path: "src/new.ts",
        previousPath: null,
        changeType: "modified",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// branchSwitch (merged from gitOperationsService.branchSwitch.test.ts)
// ---------------------------------------------------------------------------

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

    const source = byName.get("feature/source");
    expect(source).toBeDefined();
    expect(source!.profiledInCurrentLane).toBe(true);
    expect(source!.ownedByLaneId).toBeNull();
    expect(source!.ownedByLaneName).toBeNull();
    expect(source!.isCurrent).toBe(true);

    const owned = byName.get("feature/owned");
    expect(owned).toBeDefined();
    expect(owned!.ownedByLaneId).toBe("lane-2");
    expect(owned!.ownedByLaneName).toBe("Owner Lane");
    expect(owned!.profiledInCurrentLane).toBe(false);

    const main = byName.get("main");
    expect(main).toBeDefined();
    expect(main!.ownedByLaneId).toBeNull();
    expect(main!.profiledInCurrentLane).toBe(false);

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

  it("attaches last-commit metadata and rejoins tab-containing subjects", async () => {
    mockGit.runGitOrThrow.mockResolvedValue(
      [
        [
          "refs/heads/feat/widget",
          "feat/widget",
          "*",
          "origin/feat/widget",
          "abc1234",
          "2026-04-30T10:00:00+00:00",
          "Arul Sharma",
          "tweak\twidget alignment",
        ].join("\t"),
        [
          "refs/remotes/origin/feat/sidebar",
          "origin/feat/sidebar",
          " ",
          "",
          "def5678",
          "2026-04-29T08:00:00+00:00",
          "Jamie Lee",
          "rebuild sidebar nav",
        ].join("\t"),
      ].join("\n"),
    );

    const { service } = makeServiceWithLanes({});
    const branches = await service.listBranches({ laneId: "lane-1" });
    const local = branches.find((b) => b.name === "feat/widget");
    expect(local).toBeDefined();
    expect(local!.lastCommitSha).toBe("abc1234");
    expect(local!.lastCommitDate).toBe("2026-04-30T10:00:00+00:00");
    expect(local!.lastCommitAuthor).toBe("Arul Sharma");
    expect(local!.lastCommitMessage).toBe("tweak\twidget alignment");

    const remote = branches.find((b) => b.name === "origin/feat/sidebar");
    expect(remote).toBeDefined();
    expect(remote!.lastCommitSha).toBe("def5678");
    expect(remote!.lastCommitAuthor).toBe("Jamie Lee");
    expect(remote!.lastCommitMessage).toBe("rebuild sidebar nav");
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
    expect(switchBranch).toHaveBeenCalledWith({ laneId: "lane-1", branchName: "feature/foo" });
  });
});
