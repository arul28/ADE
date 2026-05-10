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

function createTestGitOperationsService(branchRef = "feature/stash-test") {
  const mockStart = vi.fn().mockReturnValue({ operationId: "op-1" });
  const mockFinish = vi.fn();

  const service = createGitOperationsService({
    laneService: {
      getLaneBaseAndBranch: vi.fn().mockReturnValue({
        baseRef: "main",
        branchRef,
        worktreePath: "/tmp/ade-lane",
        laneType: "worktree",
      }),
    } as any,
    operationService: {
      start: mockStart,
      finish: mockFinish,
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

  return {
    service,
    mockStart,
    mockFinish,
  };
}

describe("gitOperationsService.stashClear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls git stash clear with the lane worktree path and returns the action result", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockStart, mockFinish } = createTestGitOperationsService();

    const result = await service.stashClear({ laneId: "lane-1" });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["stash", "clear"],
      { cwd: "/tmp/ade-lane", timeoutMs: 15_000 },
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

describe("gitOperationsService stash item commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls git stash pop with the lane worktree path and stash ref", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockStart, mockFinish } = createTestGitOperationsService();

    const result = await service.stashPop({ laneId: "lane-1", stashRef: "stash@{1}" });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["stash", "pop", "stash@{1}"],
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
        kind: "git_stash_pop",
        metadata: expect.objectContaining({ stashRef: "stash@{1}" }),
      }),
    );
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        status: "succeeded",
      }),
    );
  });

  it("calls git stash drop with the lane worktree path and stash ref", async () => {
    mockGit.getHeadSha.mockResolvedValue("abc123");
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    const { service, mockStart, mockFinish } = createTestGitOperationsService();

    const result = await service.stashDrop({ laneId: "lane-1", stashRef: "stash@{0}" });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
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
        metadata: expect.objectContaining({ stashRef: "stash@{0}" }),
      }),
    );
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        status: "succeeded",
      }),
    );
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
