import { describe, expect, it, vi } from "vitest";
import { createWorkflowTools } from "./workflowTools";

function makeTools(prServiceOverrides: Record<string, unknown> = {}) {
  const prService = {
    getChecks: vi.fn(async () => []),
    getActionRuns: vi.fn(async () => []),
    getReviewThreads: vi.fn(async () => []),
    getComments: vi.fn(async () => []),
    rerunChecks: vi.fn(async () => undefined),
    replyToReviewThread: vi.fn(async () => ({ id: "reply-1", author: "you", authorAvatarUrl: null, body: "Fixed.", url: null, createdAt: null, updatedAt: null })),
    resolveReviewThread: vi.fn(async () => undefined),
    ...prServiceOverrides,
  } as any;

  const tools = createWorkflowTools({
    laneService: {} as any,
    prService,
    sessionId: "session-1",
    laneId: "lane-1",
  });

  return { prService, tools };
}

describe("createWorkflowTools", () => {
  it("refreshes PR issue inventory with actionable review threads and failing checks", async () => {
    const { tools } = makeTools({
      getChecks: vi.fn(async () => [
        { name: "ci / unit", status: "completed", conclusion: "failure", detailsUrl: "https://example.com/check", startedAt: null, completedAt: null },
      ]),
      getActionRuns: vi.fn(async () => [
        {
          id: 17,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          headSha: "abc123",
          htmlUrl: "https://example.com/run/17",
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:00:00.000Z",
          jobs: [
            {
              id: 28,
              name: "test",
              status: "completed",
              conclusion: "failure",
              startedAt: null,
              completedAt: null,
              steps: [
                { name: "vitest", status: "completed", conclusion: "failure", number: 1, startedAt: null, completedAt: null },
              ],
            },
          ],
        },
      ]),
      getReviewThreads: vi.fn(async () => [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          path: "src/prs.ts",
          line: 18,
          originalLine: 18,
          startLine: null,
          originalStartLine: null,
          diffSide: "RIGHT",
          url: "https://example.com/thread/1",
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:00:00.000Z",
          comments: [
            { id: "comment-1", author: "reviewer", authorAvatarUrl: null, body: "Please tighten this logic.", url: null, createdAt: null, updatedAt: null },
          ],
        },
      ]),
      getComments: vi.fn(async () => [
        { id: "issue-1", author: "bot", authorAvatarUrl: null, body: "Heads up", source: "issue", url: null, path: null, line: null, createdAt: null, updatedAt: null },
      ]),
    });

    const result = await (tools.prRefreshIssueInventory as any).execute({ prId: "pr-80" });

    expect(result.success).toBe(true);
    expect(result.summary).toMatchObject({
      hasActionableChecks: true,
      hasActionableComments: true,
      failingCheckCount: 1,
      actionableReviewThreadCount: 1,
    });
    expect(result.reviewThreads).toHaveLength(1);
    expect(result.failingWorkflowRuns[0]).toMatchObject({ name: "CI" });
  });

  it("routes review-thread reply, resolve, and rerun actions through prService", async () => {
    const { prService, tools } = makeTools();

    await (tools.prRerunFailedChecks as any).execute({ prId: "pr-80" });
    await (tools.prReplyToReviewThread as any).execute({ prId: "pr-80", threadId: "thread-1", body: "Fixed." });
    await (tools.prResolveReviewThread as any).execute({ prId: "pr-80", threadId: "thread-1" });

    expect(prService.rerunChecks).toHaveBeenCalledWith({ prId: "pr-80" });
    expect(prService.replyToReviewThread).toHaveBeenCalledWith({ prId: "pr-80", threadId: "thread-1", body: "Fixed." });
    expect(prService.resolveReviewThread).toHaveBeenCalledWith({ prId: "pr-80", threadId: "thread-1" });
  });
});
