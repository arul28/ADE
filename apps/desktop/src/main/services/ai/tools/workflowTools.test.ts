import { describe, expect, it, vi } from "vitest";
import { REVIEW_THREAD_DIFF_HUNK_MAX_CHARS, createWorkflowTools } from "./workflowTools";

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
      actionableIssueCommentCount: 1,
      actionableCommentCount: 2,
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

  /**
   * The resolver used to receive a review comment with only a path and a line
   * number, so it reasoned about feedback without ever seeing the code.
   */
  function makeReviewThread(comments: Array<Record<string, unknown>>) {
    return {
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
      comments,
    };
  }

  it("hands the resolver the diff hunk a review thread is anchored to", async () => {
    const diffHunk = "@@ -14,6 +14,9 @@ export function upsertRow(\n   const id = row.id;\n+  cache.set(id, row);\n";
    const { tools } = makeTools({
      getReviewThreads: vi.fn(async () => [
        makeReviewThread([
          { id: "comment-1", author: "reviewer", body: "This never evicts.", url: null, diffHunk },
        ]),
      ]),
    });

    const result = await (tools.prRefreshIssueInventory as any).execute({ prId: "pr-80" });

    expect(result.reviewThreads[0].diffHunk).toBe(diffHunk);
  });

  it("trims an oversized diff hunk from the front, keeping the commented lines", async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `-  legacy line ${i}`).join("\n");
    const tail = "+  const fixed = true;";
    const { tools } = makeTools({
      getReviewThreads: vi.fn(async () => [
        makeReviewThread([
          { id: "comment-1", author: "reviewer", body: "Look here.", url: null, diffHunk: `@@ -1,9 +1,9 @@\n${filler}\n${tail}` },
        ]),
      ]),
    });

    const result = await (tools.prRefreshIssueInventory as any).execute({ prId: "pr-80" });

    const hunk: string = result.reviewThreads[0].diffHunk;
    // A diff hunk ends at the commented line, so the tail is what the comment
    // is about — that is the end that must survive the cap.
    expect(hunk.endsWith(tail)).toBe(true);
    expect(hunk.startsWith("...\n")).toBe(true);
    // cap + the "...\n" ellipsis marker the trim prepends
    expect(hunk.length).toBeLessThanOrEqual(REVIEW_THREAD_DIFF_HUNK_MAX_CHARS + 4);
    // Never cut mid-line.
    expect(hunk.split("\n")[1].startsWith("-  legacy line ")).toBe(true);
  });

  it("reports no diff hunk rather than an empty string when GitHub omits one", async () => {
    const { tools } = makeTools({
      getReviewThreads: vi.fn(async () => [
        makeReviewThread([
          { id: "comment-1", author: "reviewer", body: "General note.", url: null, diffHunk: null },
          { id: "comment-2", author: "reviewer", body: "Second.", url: null },
        ]),
      ]),
    });

    const result = await (tools.prRefreshIssueInventory as any).execute({ prId: "pr-80" });

    expect(result.reviewThreads[0].diffHunk).toBeNull();
  });
});
