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
});
