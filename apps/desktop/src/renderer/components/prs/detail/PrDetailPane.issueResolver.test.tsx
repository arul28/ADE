// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, PrActivityEvent, PrCheck, PrReviewThread, PrStatus, PrWithConflicts } from "../../../../shared/types";

const mockUsePrs = vi.fn();

vi.mock("../state/PrsContext", () => ({
  usePrs: () => mockUsePrs(),
}));

vi.mock("../shared/PrIssueResolverModal", () => ({
  PrIssueResolverModal: ({
    open,
    onLaunch,
    onCopyPrompt,
  }: {
    open: boolean;
    onLaunch: (args: { scope: "checks" | "comments" | "both"; additionalInstructions: string }) => Promise<void>;
    onCopyPrompt: (args: { scope: "checks" | "comments" | "both"; additionalInstructions: string }) => Promise<void>;
  }) => (open ? (
    <div>
      <button onClick={() => void onLaunch({ scope: "checks", additionalInstructions: "extra context" })}>launch resolver</button>
      <button onClick={() => void onCopyPrompt({ scope: "checks", additionalInstructions: "extra context" })}>copy resolver prompt</button>
    </div>
  ) : null),
}));

import { PrDetailPane } from "./PrDetailPane";

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return { name: "ci / unit", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null, ...overrides };
}

function makeThread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
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
    url: null,
    createdAt: null,
    updatedAt: null,
    comments: [{ id: "comment-1", author: "reviewer", authorAvatarUrl: null, body: "Please tighten this logic.", url: null, createdAt: null, updatedAt: null }],
    ...overrides,
  };
}

const visibilityCases: Array<{
  name: string;
  checks: PrCheck[];
  reviewThreads: PrReviewThread[];
  statusOverrides?: Partial<PrStatus>;
  visible: boolean;
}> = [
  {
    name: "shows for failed checks only",
    checks: [makeCheck()],
    reviewThreads: [],
    visible: true,
  },
  {
    name: "hides while checks are still running",
    checks: [
      makeCheck(),
      makeCheck({ name: "ci / lint", status: "in_progress", conclusion: null }),
    ],
    reviewThreads: [],
    visible: false,
  },
  {
    name: "shows for unresolved review threads only",
    checks: [makeCheck({ conclusion: "success" })],
    reviewThreads: [makeThread()],
    statusOverrides: { checksStatus: "passing" },
    visible: true,
  },
  {
    name: "hides when nothing actionable remains",
    checks: [makeCheck({ conclusion: "success" })],
    reviewThreads: [makeThread({
      isResolved: true,
      comments: [{ id: "comment-1", author: "reviewer", authorAvatarUrl: null, body: "Looks good now.", url: null, createdAt: null, updatedAt: null }],
    })],
    statusOverrides: { checksStatus: "passing", reviewStatus: "approved" },
    visible: false,
  },
];

function makePr(): PrWithConflicts {
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
    conflictAnalysis: null,
  };
}

function makeLane(): LaneSummary {
  return {
    id: "lane-1",
    name: "feature/pr-80",
    description: "Tighten the GitHub PR lane.",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/pr-80",
    worktreePath: "/tmp/lane-1",
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
    createdAt: "2026-03-23T10:00:00.000Z",
    archivedAt: null,
  };
}

function makeStatus(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    prId: "pr-80",
    state: "open",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    isMergeable: false,
    mergeConflicts: false,
    behindBaseBy: 0,
    ...overrides,
  };
}

function renderPane(args: {
  checks: PrCheck[];
  reviewThreads: PrReviewThread[];
  lanes?: LaneSummary[];
  onNavigate?: (path: string) => void;
  activity?: PrActivityEvent[];
  statusOverrides?: Partial<PrStatus>;
  mergeMethod?: "merge" | "squash" | "rebase";
}) {
  const issueResolutionStart = vi.fn().mockResolvedValue({
    sessionId: "session-1",
    laneId: "lane-1",
    href: "/work?laneId=lane-1&sessionId=session-1",
  });
  const issueResolutionPreviewPrompt = vi.fn().mockResolvedValue({
    title: "Resolve PR #80 issues",
    prompt: "Prepared issue resolver prompt",
  });
  const getReviewThreads = vi.fn().mockResolvedValue(args.reviewThreads);
  const writeClipboardText = vi.fn().mockResolvedValue(undefined);
  const land = vi.fn().mockResolvedValue({
    prId: "pr-80",
    prNumber: 80,
    success: true,
    mergeCommitSha: "sha-merge",
    branchDeleted: false,
    laneArchived: false,
    error: null,
  });
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, {
    ade: {
      prs: {
        getDetail: vi.fn().mockResolvedValue({
          prId: "pr-80",
          body: "This PR improves GitHub PR flows.",
          labels: [],
          assignees: [],
          requestedReviewers: [],
          author: { login: "octocat", avatarUrl: null },
          isDraft: false,
          milestone: null,
          linkedIssues: [],
        }),
        getFiles: vi.fn().mockResolvedValue([]),
        getActionRuns: vi.fn().mockResolvedValue([]),
        getActivity: vi.fn().mockResolvedValue(args.activity ?? []),
        getReviewThreads,
        issueResolutionStart,
        issueResolutionPreviewPrompt,
        land,
        openInGitHub: vi.fn().mockResolvedValue(undefined),
      },
      app: {
        openExternal: vi.fn(),
        writeClipboardText,
      },
    },
  });

  return {
    issueResolutionStart,
    issueResolutionPreviewPrompt,
    getReviewThreads,
    writeClipboardText,
    land,
    onRefresh,
    ...render(
      <PrDetailPane
        pr={makePr()}
        status={makeStatus(args.statusOverrides)}
        checks={args.checks}
        reviews={[]}
        comments={[]}
        detailBusy={false}
        lanes={args.lanes ?? [makeLane()]}
        mergeMethod={args.mergeMethod ?? "squash"}
        onRefresh={onRefresh}
        onNavigate={args.onNavigate ?? vi.fn()}
      />,
    ),
  };
}

describe("PrDetailPane issue resolver CTA", () => {
  beforeEach(() => {
    mockUsePrs.mockReturnValue({
      resolverModel: "openai/gpt-5.4-codex",
      resolverReasoningLevel: "high",
      resolverPermissionMode: "guarded_edit",
      setResolverModel: vi.fn(),
      setResolverReasoningLevel: vi.fn(),
      setResolverPermissionMode: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it.each(visibilityCases)("$name", async ({ checks, reviewThreads, statusOverrides, visible }) => {
    renderPane({ checks, reviewThreads, statusOverrides });

    await waitFor(() => {
      if (visible) {
        expect(screen.getByRole("button", { name: /path to merge/i })).toBeTruthy();
      } else {
        expect(screen.queryByRole("button", { name: /path to merge/i })).toBeNull();
      }
    });
  });

  it("shows the action in both the header and the checks tab when issues are actionable", async () => {
    const user = userEvent.setup();
    renderPane({
      checks: [makeCheck()],
      reviewThreads: [makeThread()],
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));

    await waitFor(() => {
      // "Path to Merge" in header + "Resolve issues with agent" in ChecksTab
      expect(screen.getByRole("button", { name: /path to merge/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /resolve issues with agent/i })).toBeTruthy();
    });
  });

  it("keeps the merge readiness checks row in a running state while failed checks are still in flight", async () => {
    renderPane({
      checks: [
        makeCheck({ name: "ci / unit", conclusion: "success" }),
        makeCheck({ name: "ci / e2e", conclusion: "failure" }),
        makeCheck({ name: "ci / lint", status: "in_progress", conclusion: null }),
      ],
      reviewThreads: [],
    });

    await waitFor(() => {
      expect(screen.getByText("Some checks failing")).toBeTruthy();
      expect(screen.getByText("1/3 checks passing, 1 still running")).toBeTruthy();
      expect(screen.getAllByLabelText("CI running").length).toBeGreaterThan(0);
    });
  });

  it("lets the operator attempt a bypass merge and uses the selected merge method", async () => {
    const user = userEvent.setup();
    const { land, onRefresh } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      mergeMethod: "squash",
      statusOverrides: {
        checksStatus: "failing",
        reviewStatus: "changes_requested",
        isMergeable: false,
        mergeConflicts: false,
      },
    });

    const mergeButton = await screen.findByRole("button", { name: /merge pull request/i });
    expect((mergeButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: /create merge commit/i }));
    await user.click(screen.getByRole("checkbox", { name: /attempt merge anyway if github allows bypass rules/i }));

    const bypassButton = screen.getByRole("button", { name: /attempt merge anyway/i });
    expect((bypassButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(bypassButton);

    await waitFor(() => {
      expect(land).toHaveBeenCalledWith({ prId: "pr-80", method: "merge" });
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("launches the issue resolver chat and navigates to the work session", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { issueResolutionStart } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      onNavigate,
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await user.click(await screen.findByRole("button", { name: /resolve issues with agent/i }));
    await user.click(screen.getByRole("button", { name: /launch resolver/i }));

    await waitFor(() => {
      expect(issueResolutionStart).toHaveBeenCalledWith(expect.objectContaining({
        prId: "pr-80",
        scope: "checks",
        additionalInstructions: "extra context",
      }));
      expect(onNavigate).toHaveBeenCalledWith("/work?laneId=lane-1&sessionId=session-1");
    });
  });

  it("reloads review threads when opening the resolver", async () => {
    const user = userEvent.setup();
    const { getReviewThreads } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
    });

    await waitFor(() => {
      expect(getReviewThreads).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await user.click(await screen.findByRole("button", { name: /resolve issues with agent/i }));

    await waitFor(() => {
      expect(getReviewThreads).toHaveBeenCalledTimes(2);
    });
  });

  it("copies the prepared resolver prompt to the clipboard", async () => {
    const user = userEvent.setup();
    const { issueResolutionPreviewPrompt, writeClipboardText } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await user.click(await screen.findByRole("button", { name: /resolve issues with agent/i }));
    await user.click(screen.getByRole("button", { name: /copy resolver prompt/i }));

    await waitFor(() => {
      expect(issueResolutionPreviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
        prId: "pr-80",
        scope: "checks",
        additionalInstructions: "extra context",
      }));
      expect(writeClipboardText).toHaveBeenCalledWith("Prepared issue resolver prompt");
    });
  });

  it("renders review activity bodies as markdown instead of raw source text", async () => {
    renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      activity: [
        {
          id: "review-1",
          type: "review",
          author: "coderabbitai[bot]",
          avatarUrl: null,
          body: "**Actionable comments posted: 3**\n\n<details><summary>Prompt for AI Agents</summary>Use the current code.</details>",
          timestamp: "2026-03-23T12:00:00.000Z",
          metadata: { state: "commented" },
        },
      ],
    });

    expect(await screen.findByText("Actionable comments posted: 3")).toBeTruthy();
    expect(screen.queryByText(/\*\*Actionable comments posted: 3\*\*/)).toBeNull();
    expect(screen.getByText("Prompt for AI Agents")).toBeTruthy();
  });
});
