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
