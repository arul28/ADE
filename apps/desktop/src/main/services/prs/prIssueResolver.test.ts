import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LaneSummary, PrActionRun, PrCheck, PrDetail, PrFile, PrReviewThread, PrSummary } from "../../../shared/types";
import { buildPrIssueResolutionPrompt, launchPrIssueResolutionChat, previewPrIssueResolutionPrompt } from "./prIssueResolver";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "feature/pr-80",
    description: "Tighten the PR workflow lane.",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/pr-80",
    worktreePath: overrides.worktreePath ?? fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-issue-lane-")),
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-23T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-80",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "ade-dev",
    repoName: "ade",
    githubPrNumber: 80,
    githubUrl: "https://github.com/ade-dev/ade/pull/80",
    githubNodeId: "PR_kwDOExample",
    title: "Stabilize GitHub PR flows",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-80",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    additions: 25,
    deletions: 8,
    lastSyncedAt: "2026-03-23T12:00:00.000Z",
    createdAt: "2026-03-23T11:00:00.000Z",
    updatedAt: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    prId: "pr-80",
    body: "This PR makes the GitHub PR detail view more reliable.",
    labels: [],
    assignees: [],
    requestedReviewers: [],
    author: { login: "octocat", avatarUrl: null },
    isDraft: false,
    milestone: null,
    linkedIssues: [],
    ...overrides,
  };
}

describe("buildPrIssueResolutionPrompt", () => {
  it("includes scope, issue inventory, extra instructions, and regression guidance", () => {
    const prompt = buildPrIssueResolutionPrompt({
      pr: makePr(),
      lane: makeLane({ worktreePath: "/tmp/lane-pr-80" }),
      detail: makeDetail(),
      files: [
        { filename: "src/prs.ts", status: "modified", additions: 10, deletions: 2, patch: null, previousFilename: null },
      ],
      checks: [
        { name: "ci / unit", status: "completed", conclusion: "failure", detailsUrl: "https://example.com/check", startedAt: null, completedAt: null },
      ],
      actionRuns: [
        {
          id: 71,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          headSha: "abc123",
          htmlUrl: "https://example.com/run/71",
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:10:00.000Z",
          jobs: [
            {
              id: 81,
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
        } satisfies PrActionRun,
      ],
      reviewThreads: [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          path: "src/prs.ts",
          line: 42,
          originalLine: 42,
          startLine: null,
          originalStartLine: null,
          diffSide: "RIGHT",
          url: "https://example.com/thread/1",
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:05:00.000Z",
          comments: [
            {
              id: "comment-1",
              author: "reviewer",
              authorAvatarUrl: null,
              body: "Please handle the loading state here.",
              url: "https://example.com/comment/1",
              createdAt: "2026-03-23T12:00:00.000Z",
              updatedAt: "2026-03-23T12:00:00.000Z",
            },
          ],
        } satisfies PrReviewThread,
      ],
      issueComments: [
        {
          id: "issue-comment-1",
          author: "coderabbitai[bot]",
          authorAvatarUrl: null,
          body: "Consider simplifying this branch.",
          source: "issue",
          url: "https://example.com/issue-comment/1",
          path: null,
          line: null,
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:00:00.000Z",
        },
      ],
      scope: "both",
      additionalInstructions: "Please keep the PR description accurate if behavior changes.",
      recentCommits: [{ sha: "abcdef123456", subject: "Refine PR detail header" }],
    });

    expect(prompt).toContain("Selected scope: checks and review comments");
    expect(prompt).toContain("ADE PR id (for ADE tools): pr-80");
    expect(prompt).toContain("Please keep the PR description accurate if behavior changes.");
    expect(prompt).toContain("Watch carefully for regressions caused by your fixes.");
    expect(prompt).toContain("update the test");
    expect(prompt).toContain("rerun the complete failing test files or suites locally");
    expect(prompt).toContain("prRefreshIssueInventory");
    expect(prompt).toContain("thread-1");
    expect(prompt).toContain("ci / unit");
  });

  it("compresses review-thread bodies into references and filters noisy advisory comments", () => {
    const prompt = buildPrIssueResolutionPrompt({
      pr: makePr({ title: "fix codex chat" }),
      lane: makeLane({ worktreePath: "/tmp/lane-pr-80" }),
      detail: makeDetail({
        body: "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->\n## Summary by CodeRabbit\nHuge autogenerated summary",
      }),
      files: [],
      checks: [],
      actionRuns: [],
      reviewThreads: [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          path: "apps/desktop/src/renderer/components/chat/AgentChatPane.tsx",
          line: 551,
          originalLine: 551,
          startLine: null,
          originalStartLine: null,
          diffSide: "RIGHT",
          url: "https://example.com/thread/1",
          createdAt: null,
          updatedAt: null,
          comments: [
            {
              id: "comment-1",
              author: "coderabbitai",
              authorAvatarUrl: null,
              body: "_⚠️ Potential issue_ | _🟡 Minor_\n\n**Derive `assistantLabel` from the effective provider.**\n\nThis can drift from the model that will actually run.\n\n<details><summary>Prompt</summary>Very long autogenerated block</details>",
              url: "https://example.com/comment/1",
              createdAt: null,
              updatedAt: null,
            },
          ],
        } satisfies PrReviewThread,
      ],
      issueComments: [
        {
          id: "issue-comment-1",
          author: "coderabbitai[bot]",
          authorAvatarUrl: null,
          body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai --> giant summary",
          source: "issue",
          url: "https://example.com/issue-comment/1",
          path: null,
          line: null,
          createdAt: null,
          updatedAt: null,
        },
        {
          id: "issue-comment-2",
          author: "vercel[bot]",
          authorAvatarUrl: null,
          body: "[vc]: deployment details",
          source: "issue",
          url: "https://example.com/issue-comment/2",
          path: null,
          line: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      scope: "comments",
      additionalInstructions: null,
      recentCommits: [],
    });

    expect(prompt).toContain("Changed test files / likely hotspots");
    expect(prompt).toContain("No changed test files detected in this PR.");
    expect(prompt).toContain("Current unresolved review threads (summaries + references)");
    expect(prompt).toContain("Summary: Derive assistantLabel from the effective provider.");
    expect(prompt).toContain("Reference: https://example.com/thread/1");
    expect(prompt).not.toContain("Very long autogenerated block");
    expect(prompt).not.toContain("giant summary");
    expect(prompt).not.toContain("deployment details");
    expect(prompt).not.toContain("Huge autogenerated summary");
    expect(prompt).toContain("If you are running outside ADE, use the linked GitHub thread/check URLs");
  });

  it("highlights changed test files as likely hotspots", () => {
    const prompt = buildPrIssueResolutionPrompt({
      pr: makePr(),
      lane: makeLane({ worktreePath: "/tmp/lane-pr-80" }),
      detail: makeDetail(),
      files: [
        { filename: "apps/desktop/src/renderer/components/chat/AgentChatMessageList.test.tsx", status: "modified", additions: 525, deletions: 8, patch: null, previousFilename: null },
        { filename: "apps/desktop/src/main/services/chat/chatTextBatching.test.ts", status: "added", additions: 113, deletions: 0, patch: null, previousFilename: null },
        { filename: "apps/desktop/src/renderer/components/chat/AgentChatPane.tsx", status: "modified", additions: 10, deletions: 2, patch: null, previousFilename: null },
      ],
      checks: [],
      actionRuns: [],
      reviewThreads: [],
      issueComments: [],
      scope: "checks",
      additionalInstructions: null,
      recentCommits: [],
    });

    expect(prompt).toContain("Changed test files / likely hotspots");
    expect(prompt).toContain("heavily modified test file: apps/desktop/src/renderer/components/chat/AgentChatMessageList.test.tsx (+525/-8)");
    expect(prompt).toContain("new test file: apps/desktop/src/main/services/chat/chatTextBatching.test.ts (+113/-0)");
    expect(prompt).toContain("Treat newly added or heavily modified test files as likely regression hotspots");
  });
});

describe("launchPrIssueResolutionChat", () => {
  const failingCheck: PrCheck = { name: "ci / unit", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null };

  function makeDeps(overrides: { checks?: PrCheck[] } = {}) {
    const lane = makeLane();
    const pr = makePr();
    const createSession = vi.fn(async () => ({ id: "session-1" }));
    const sendMessage = vi.fn(async () => undefined);
    const updateMeta = vi.fn();

    const deps = {
      prService: {
        listAll: () => [pr],
        getDetail: vi.fn(async () => makeDetail()),
        getFiles: vi.fn(async () => [] as PrFile[]),
        getChecks: vi.fn(async () => overrides.checks ?? [failingCheck]),
        getActionRuns: vi.fn(async () => [] as PrActionRun[]),
        getReviewThreads: vi.fn(async () => [] as PrReviewThread[]),
        getComments: vi.fn(async () => []),
      } as any,
      laneService: {
        list: vi.fn(async () => [lane]),
        getLaneBaseAndBranch: vi.fn(() => ({ baseRef: "main", branchRef: "feature/pr-80", worktreePath: lane.worktreePath, laneType: "worktree" })),
      },
      agentChatService: { createSession, sendMessage },
      sessionService: { updateMeta },
    };

    return { lane, pr, deps, createSession, sendMessage, updateMeta };
  }

  it("previews the exact first prompt without creating a chat session", async () => {
    const { deps, createSession, sendMessage, pr } = makeDeps();

    const result = await previewPrIssueResolutionPrompt(deps as any, {
      prId: pr.id,
      scope: "checks",
      modelId: "openai/gpt-5.4-codex",
      reasoning: "high",
      permissionMode: "guarded_edit",
      additionalInstructions: "Keep commits tight and rerun focused tests first.",
    });

    expect(result.title).toBe("Resolve PR #80 issues");
    expect(result.prompt).toContain("Keep commits tight and rerun focused tests first.");
    expect(createSession).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("creates a normal work chat session and sends the composed prompt", async () => {
    const { lane, pr, deps, createSession, sendMessage, updateMeta } = makeDeps();

    const result = await launchPrIssueResolutionChat(deps as any, {
      prId: pr.id,
      scope: "checks",
      modelId: "openai/gpt-5.4-codex",
      reasoning: "high",
      permissionMode: "guarded_edit",
      additionalInstructions: "Run focused tests before full CI.",
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      laneId: lane.id,
      provider: "unified",
      modelId: "openai/gpt-5.4-codex",
      surface: "work",
      sessionProfile: "workflow",
      unifiedPermissionMode: "edit",
    }));
    expect(updateMeta).toHaveBeenCalledWith({ sessionId: "session-1", title: "Resolve PR #80 issues" });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      displayText: "Resolve PR #80 issues",
      text: expect.stringContaining("Run focused tests before full CI."),
    }));
    expect(result).toEqual({
      sessionId: "session-1",
      laneId: lane.id,
      href: `/work?laneId=${encodeURIComponent(lane.id)}&sessionId=session-1`,
    });
  });

  it("rejects checks scope while checks are still running", async () => {
    const runningCheck: PrCheck = { name: "ci / unit", status: "in_progress", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null };
    const { pr, deps } = makeDeps({ checks: [runningCheck] });

    await expect(launchPrIssueResolutionChat(deps as any, {
      prId: pr.id,
      scope: "checks",
      modelId: "openai/gpt-5.4-codex",
    })).rejects.toThrow("Failing checks are not currently actionable");
  });
});
