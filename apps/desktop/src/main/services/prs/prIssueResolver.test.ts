import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IssueInventoryItem, LaneSummary, PrActionRun, PrCheck, PrDetail, PrFile, PrReviewThread, PrSummary } from "../../../shared/types";
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

const WORKFLOW_PR_TOOL_NAMES = [
  "prRefreshIssueInventory",
  "prGetReviewComments",
  "prRerunFailedChecks",
  "prReplyToReviewThread",
  "prResolveReviewThread",
];

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
    expect(prompt).toContain("Runtime: Workflow chat with ADE PR tools");
    expect(prompt).toContain("Please keep the PR description accurate if behavior changes.");
    expect(prompt).toContain("Watch carefully for regressions caused by your fixes.");
    expect(prompt).toContain("update the test");
    expect(prompt).toContain("rerun the complete failing test files or suites locally");
    expect(prompt).toContain("Commit the changes and push the PR branch before you stop.");
    expect(prompt).toContain("If you cannot safely commit or push the necessary changes");
    expect(prompt).toContain("prRefreshIssueInventory");
    expect(prompt).toContain("prGetReviewComments");
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
    expect(prompt).toContain("prResolveReviewThread");
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
    const previewSessionToolNames = vi.fn(() => WORKFLOW_PR_TOOL_NAMES);
    const updateMeta = vi.fn();

    const issueInventoryService = {
      syncFromPrData: vi.fn(() => ({
        items: [],
        convergence: { currentRound: 0, status: "idle" },
      })),
      getNewItems: vi.fn(() => []),
      markSentToAgent: vi.fn(),
    };

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
      agentChatService: { createSession, sendMessage, previewSessionToolNames },
      sessionService: { updateMeta },
      issueInventoryService,
    };

    return { lane, pr, deps, createSession, sendMessage, previewSessionToolNames, updateMeta };
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

  it("uses ADE CLI PR commands in the prompt for Codex launches", async () => {
    const { deps, pr } = makeDeps();

    const result = await previewPrIssueResolutionPrompt(deps as any, {
      prId: pr.id,
      scope: "checks",
      modelId: "openai/gpt-5.4-codex",
      reasoning: "high",
      permissionMode: "guarded_edit",
      additionalInstructions: null,
    });

    expect(result.prompt).toContain("Runtime: Codex chat via ADE CLI");
    expect(result.prompt).toContain("ade prs inventory");
    expect(result.prompt).toContain("ade prs comments");
    expect(result.prompt).toContain("ade prs resolve-thread");
    expect(result.prompt).toContain("This runtime can use the ADE CLI");
    expect(result.prompt).toContain("Immediately after that, run `ade prs comments");
    expect(result.prompt).toContain("Treat the refreshed inventory as a triage index");
    expect(result.prompt).toContain("Do not spend your first steps reading local skill docs");
    expect(result.prompt).toContain("instead of reverse-engineering ADE internals");
    expect(result.prompt).not.toContain("prRefreshIssueInventory");
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
      provider: "codex",
      model: "gpt-5.4",
      modelId: "openai/gpt-5.4-codex",
      surface: "work",
      sessionProfile: "workflow",
      permissionMode: "default",
    }));
    expect(updateMeta).toHaveBeenCalledWith({ sessionId: "session-1", title: "Resolve PR #80 issues" });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      displayText: "Resolve PR #80 issues",
      text: expect.stringContaining("Run focused tests before full CI."),
      executionMode: "parallel",
    }));
    expect(result).toEqual({
      sessionId: "session-1",
      laneId: lane.id,
      href: `/work?laneId=${encodeURIComponent(lane.id)}&sessionId=session-1`,
    });
  });

  it("fails fast when an API workflow chat does not expose required PR tools", async () => {
    const { deps, pr, createSession, sendMessage } = makeDeps();
    deps.agentChatService.previewSessionToolNames = vi.fn(() => ["prGetChecks"]);

    await expect(launchPrIssueResolutionChat(deps as any, {
      prId: pr.id,
      scope: "checks",
      modelId: "opencode/openai/gpt-5.4",
      reasoning: "high",
      permissionMode: "guarded_edit",
      additionalInstructions: null,
    })).rejects.toThrow("PR issue resolver requires ADE PR tools");

    expect(createSession).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
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

  it("launches Claude SDK resolver chats with subagents execution mode and detailed issue context", async () => {
    const lane = makeLane();
    const pr = makePr();
    const createSession = vi.fn(async () => ({ id: "session-claude" }));
    const sendMessage = vi.fn(async () => undefined);

    const deps = {
      prService: {
        listAll: () => [pr],
        getDetail: vi.fn(async () => makeDetail()),
        getFiles: vi.fn(async () => [] as PrFile[]),
        getChecks: vi.fn(async () => [] as PrCheck[]),
        getActionRuns: vi.fn(async () => [] as PrActionRun[]),
        getReviewThreads: vi.fn(async () => [
          {
            id: "thread-claude-1",
            isResolved: false,
            isOutdated: false,
            path: "src/claude.ts",
            line: 12,
            originalLine: 12,
            startLine: null,
            originalStartLine: null,
            diffSide: "RIGHT",
            url: "https://example.com/thread/claude-1",
            createdAt: null,
            updatedAt: null,
            comments: [
              {
                id: "comment-claude-1",
                author: "reviewer",
                authorAvatarUrl: null,
                body: "Please explain why this retry loop is safe.",
                url: "https://example.com/comment/claude-1",
                createdAt: null,
                updatedAt: null,
              },
            ],
          } satisfies PrReviewThread,
        ]),
        getComments: vi.fn(async () => []),
      } as any,
      laneService: {
        list: vi.fn(async () => [lane]),
        getLaneBaseAndBranch: vi.fn(() => ({ baseRef: "main", branchRef: "feature/pr-80", worktreePath: lane.worktreePath, laneType: "worktree" })),
      },
      agentChatService: {
        createSession,
        sendMessage,
        previewSessionToolNames: vi.fn(() => WORKFLOW_PR_TOOL_NAMES),
      },
      sessionService: { updateMeta: vi.fn() },
      issueInventoryService: {
        syncFromPrData: vi.fn(() => ({
          items: [],
          convergence: { currentRound: 0, status: "idle" },
        })),
        getNewItems: vi.fn(() => []),
        markSentToAgent: vi.fn(),
      },
    };

    await launchPrIssueResolutionChat(deps as any, {
      prId: pr.id,
      scope: "comments",
      modelId: "anthropic/claude-sonnet-4-6",
      reasoning: "high",
      permissionMode: "guarded_edit",
      additionalInstructions: null,
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-claude",
      executionMode: "subagents",
      text: expect.stringContaining("Runtime: Claude chat via ADE CLI"),
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Current unresolved review threads (detailed context)"),
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Please explain why this retry loop is safe."),
    }));
  });
});

// ---------------------------------------------------------------------------
// New: formatInventoryItemsSummary (tested via buildPrIssueResolutionPrompt
// with inventoryItems)
// ---------------------------------------------------------------------------

function makeInventoryItem(overrides: Partial<IssueInventoryItem> = {}): IssueInventoryItem {
  return {
    id: "inv-1",
    prId: "pr-80",
    source: "human",
    type: "review_thread",
    externalId: "thread:thread-1",
    state: "new",
    round: 0,
    filePath: "src/main.ts",
    line: 42,
    severity: "major",
    headline: "Fix the null check",
    body: "This will crash at runtime.",
    author: "reviewer",
    url: "https://example.com/thread/1",
    dismissReason: null,
    agentSessionId: null,
    createdAt: "2026-03-23T12:00:00.000Z",
    updatedAt: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

function makeBasePromptArgs(overrides: Record<string, unknown> = {}) {
  return {
    pr: makePr(),
    lane: makeLane({ worktreePath: "/tmp/lane-pr-80" }),
    detail: makeDetail(),
    files: [],
    checks: [
      { name: "ci / unit", status: "completed" as const, conclusion: "failure" as const, detailsUrl: null, startedAt: null, completedAt: null },
    ],
    actionRuns: [],
    reviewThreads: [],
    issueComments: [],
    scope: "both" as const,
    additionalInstructions: null,
    recentCommits: [],
    ...overrides,
  };
}

describe("buildPrIssueResolutionPrompt — inventory items", () => {
  it("formats inventory items with severity, location, source, and author", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      inventoryItems: [
        makeInventoryItem({
          id: "inv-1",
          source: "coderabbit",
          severity: "major",
          filePath: "src/prs.ts",
          line: 55,
          headline: "Handle the loading state",
          externalId: "thread:t-1",
          author: "coderabbitai",
          url: "https://example.com/thread/t-1",
        }),
        makeInventoryItem({
          id: "inv-2",
          type: "check_failure",
          source: "unknown",
          severity: null,
          filePath: null,
          line: null,
          headline: 'CI check "ci / lint" failing',
          externalId: "check:ci / lint",
          author: null,
          url: "https://example.com/check/1",
        }),
      ],
    }));

    // Should use inventory section instead of raw threads/checks
    expect(prompt).toContain("Current issues to address (from inventory");
    expect(prompt).toContain("[Major] Thread thread:t-1 at src/prs.ts:55");
    expect(prompt).toContain("source: coderabbit");
    expect(prompt).toContain("author: coderabbitai");
    expect(prompt).toContain("Summary: Handle the loading state");
    expect(prompt).toContain("Reference: https://example.com/thread/t-1");

    // Check failure formatting
    expect(prompt).toContain('Check check:ci / lint at unknown location');
    expect(prompt).toContain('Summary: CI check "ci / lint" failing');

    // Should NOT contain the raw threads/checks sections
    expect(prompt).not.toContain("Current failing checks");
    expect(prompt).not.toContain("Current unresolved review threads (summaries + references)");
  });

  it("shows 'no new inventory items' when all items are non-new", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      inventoryItems: [
        makeInventoryItem({ state: "fixed" }),
        makeInventoryItem({ id: "inv-2", state: "dismissed" }),
      ],
    }));

    expect(prompt).toContain("No new inventory items to address.");
  });

  it("falls back to raw threads/checks when inventoryItems is null", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      inventoryItems: null,
    }));

    expect(prompt).toContain("Current failing checks");
    expect(prompt).toContain("Current unresolved review threads");
    expect(prompt).not.toContain("from inventory");
  });

  it("falls back to raw threads/checks when inventoryItems is empty array", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      inventoryItems: [],
    }));

    expect(prompt).toContain("Current failing checks");
    expect(prompt).not.toContain("from inventory");
  });
});

describe("buildPrIssueResolutionPrompt — round and previouslyHandled", () => {
  it("includes round number in PR context", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: 3,
    }));

    expect(prompt).toContain("Resolution round: 3");
  });

  it("does not include round line when round is null", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: null,
    }));

    expect(prompt).not.toContain("Resolution round:");
  });

  it("renders Previous rounds section with fixed and dismissed counts", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: 3,
      previouslyHandled: {
        fixedCount: 4,
        dismissedCount: 2,
        escalatedCount: 1,
        fixedHeadlines: ["Fix null check", "Handle edge case", "Update imports"],
        dismissedHeadlines: ["Cosmetic nit"],
      },
    }));

    expect(prompt).toContain("Previous rounds");
    expect(prompt).toContain("Fixed 4 issues, dismissed 2, escalated 1");
    expect(prompt).toContain("Fixed: Fix null check, Handle edge case, Update imports");
    expect(prompt).toContain("Dismissed: Cosmetic nit");
    expect(prompt).toContain("Do not re-address items that are already fixed or dismissed");
  });

  it("omits Previous rounds when all counts are zero", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: 1,
      previouslyHandled: {
        fixedCount: 0,
        dismissedCount: 0,
        escalatedCount: 0,
        fixedHeadlines: [],
        dismissedHeadlines: [],
      },
    }));

    expect(prompt).not.toContain("Previous rounds");
  });

  it("omits Previous rounds when previouslyHandled is null", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: 2,
      previouslyHandled: null,
    }));

    expect(prompt).not.toContain("Previous rounds");
  });

  it("uses incremental goal text for round > 1", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: 2,
    }));

    expect(prompt).toContain("This is continuation round 2");
    expect(prompt).toContain("Focus on the remaining NEW issues");
    expect(prompt).toContain("Do not re-address items from prior rounds");
  });

  it("uses standard goal text for round 1", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: 1,
    }));

    expect(prompt).toContain("Get the selected PR issue scope");
    expect(prompt).not.toContain("continuation round");
  });

  it("uses standard goal text when round is not provided", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs());

    expect(prompt).toContain("Get the selected PR issue scope");
    expect(prompt).not.toContain("continuation round");
  });

  it("truncates fixedHeadlines to 8 items", () => {
    const prompt = buildPrIssueResolutionPrompt(makeBasePromptArgs({
      round: 3,
      previouslyHandled: {
        fixedCount: 10,
        dismissedCount: 0,
        escalatedCount: 0,
        fixedHeadlines: ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10"],
        dismissedHeadlines: [],
      },
    }));

    expect(prompt).toContain("Fixed: H1, H2, H3, H4, H5, H6, H7, H8");
    expect(prompt).not.toContain("H9");
    expect(prompt).not.toContain("H10");
  });
});
