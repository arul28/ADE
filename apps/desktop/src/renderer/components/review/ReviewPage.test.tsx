/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ReviewPage } from "./ReviewPage";
import { useAppStore } from "../../state/appStore";
import { AgentChatPane } from "../chat/AgentChatPane";

vi.mock("../ui/PaneTilingLayout", () => ({
  PaneTilingLayout: ({ panes }: { panes: Record<string, { children: React.ReactNode }> }) => (
    <div data-testid="mock-pane-layout">
      {Object.entries(panes).map(([id, pane]) => (
        <section key={id} data-testid={`pane-${id}`}>
          {pane.children}
        </section>
      ))}
    </div>
  ),
}));

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: vi.fn(() => <div data-testid="agent-chat-pane" />),
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function FilesProbe() {
  const location = useLocation();
  const state = (location.state ?? null) as { openFilePath?: string; laneId?: string } | null;
  return (
    <div data-testid="files-probe">
      {location.pathname}|{state?.laneId ?? "no-lane"}|{state?.openFilePath ?? "no-file"}
    </div>
  );
}

function resetStore() {
  useAppStore.setState({
    project: { rootPath: "/Users/arul/ADE", name: "ADE" } as any,
    projectHydrated: true,
    showWelcome: false,
    selectedLaneId: "lane-review",
    runLaneId: null,
    focusedSessionId: null,
    lanes: [
      { id: "lane-review", name: "feature/review-tab", branchRef: "refs/heads/feature/review-tab", baseRef: "main", laneType: "worktree", color: null, worktreePath: "/Users/arul/ADE", status: {} as any },
      { id: "lane-bugfix", name: "bugfix/review-engine", branchRef: "refs/heads/bugfix/review-engine", baseRef: "main", laneType: "worktree", color: null, worktreePath: "/Users/arul/ADE-bugfix", status: {} as any },
    ] as any,
    laneInspectorTabs: {},
    terminalAttention: {
      runningCount: 0,
      activeCount: 0,
      needsAttentionCount: 0,
      indicator: "none",
      byLaneId: {},
    },
    workViewByProject: {},
    laneWorkViewByScope: {},
  });
}

describe("ReviewPage", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    resetStore();
    (AgentChatPane as unknown as { mockClear?: () => void }).mockClear?.();
    const run1 = {
      id: "run-1",
      projectId: "project-1",
      laneId: "lane-review",
      status: "completed",
      targetLabel: "feature/review-tab vs main",
      compareTarget: { kind: "default_branch", label: "main", ref: "main", laneId: null, branchRef: "main" },
      target: {
        mode: "lane_diff",
        laneId: "lane-review",
      },
      config: {
        compareAgainst: { kind: "default_branch" },
        selectionMode: "full_diff",
        dirtyOnly: false,
        modelId: "openai/gpt-5.5-codex",
        reasoningEffort: "medium",
        budgets: { maxFiles: 25, maxDiffChars: 120000, maxPromptChars: 60000, maxFindings: 8, maxFindingsPerPass: 6, maxPublishedFindings: 6 },
        publishBehavior: "local_only",
      },
      summary: "Reviewed against default branch",
      errorMessage: null,
      findingCount: 1,
      severitySummary: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
      chatSessionId: "session-1",
      createdAt: "2026-04-02T12:00:00.000Z",
      startedAt: "2026-04-02T12:01:00.000Z",
      endedAt: "2026-04-02T12:05:00.000Z",
      updatedAt: "2026-04-02T12:05:00.000Z",
    } as const;
    const run2 = {
      id: "run-2",
      projectId: "project-1",
      laneId: "lane-bugfix",
      status: "completed",
      targetLabel: "bugfix/review-engine vs feature/review-tab",
      compareTarget: { kind: "lane", laneId: "lane-review", label: "feature/review-tab", ref: "feature/review-tab", branchRef: "feature/review-tab" },
      target: {
        mode: "lane_diff",
        laneId: "lane-bugfix",
      },
      config: {
        compareAgainst: { kind: "lane", laneId: "lane-review" },
        selectionMode: "full_diff",
        dirtyOnly: false,
        modelId: "openai/gpt-5.5-codex",
        reasoningEffort: "high",
        budgets: { maxFiles: 25, maxDiffChars: 120000, maxPromptChars: 60000, maxFindings: 8, maxFindingsPerPass: 6, maxPublishedFindings: 6 },
        publishBehavior: "local_only",
      },
      summary: "Reviewed lane-to-lane diff",
      errorMessage: null,
      findingCount: 2,
      severitySummary: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
      chatSessionId: "session-2",
      createdAt: "2026-04-03T12:00:00.000Z",
      startedAt: "2026-04-03T12:01:00.000Z",
      endedAt: "2026-04-03T12:05:00.000Z",
      updatedAt: "2026-04-03T12:05:00.000Z",
    } as const;
    const run3 = {
      id: "run-3",
      projectId: "project-1",
      laneId: "lane-review",
      status: "queued",
      targetLabel: "feature/review-tab vs main",
      compareTarget: { kind: "default_branch", label: "main", ref: "main", laneId: null, branchRef: "main" },
      target: {
        mode: "lane_diff",
        laneId: "lane-review",
      },
      config: {
        compareAgainst: { kind: "default_branch" },
        selectionMode: "full_diff",
        dirtyOnly: false,
        modelId: "openai/gpt-5.5-codex",
        reasoningEffort: "medium",
        budgets: { maxFiles: 25, maxDiffChars: 120000, maxPromptChars: 60000, maxFindings: 8, maxFindingsPerPass: 6, maxPublishedFindings: 6 },
        publishBehavior: "local_only",
      },
      summary: null,
      errorMessage: null,
      findingCount: 0,
      severitySummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      chatSessionId: null,
      createdAt: "2026-04-04T12:00:00.000Z",
      startedAt: "2026-04-04T12:00:00.000Z",
      endedAt: null,
      updatedAt: "2026-04-04T12:00:00.000Z",
    } as const;
    let runs: any[] = [run1, run2];
    const details = new Map<string, any>([
      ["run-1", {
        ...run1,
        findings: [],
        artifacts: [],
        publications: [],
        chatSession: {
          sessionId: "session-1",
          laneId: "lane-review",
          provider: "codex",
          model: "gpt-5.4-codex",
          status: "active",
          startedAt: "2026-04-02T12:01:00.000Z",
          endedAt: null,
          lastActivityAt: "2026-04-02T12:05:00.000Z",
          lastOutputPreview: "Review transcript",
          summary: "Review transcript",
          title: "Review transcript",
        },
      }],
      ["run-2", {
        ...run2,
        findings: [
          {
            id: "finding-1",
            runId: "run-2",
            title: "Missing guard on empty result",
            severity: "high",
            findingClass: "intent_drift",
            body: "The branch can surface a blank state instead of the expected fallback.",
            confidence: 0.92,
            evidence: [
              { kind: "diff_hunk", summary: "@@ -12,6 +12,8 @@", filePath: "src/review/run.ts", line: 42, quote: "+ return null;", artifactId: null },
              { kind: "artifact", summary: "Raw diff-risk pass output", filePath: null, line: null, quote: null, artifactId: "artifact-pass-diff-risk" },
            ],
            filePath: "src/review/run.ts",
            line: 42,
            anchorState: "anchored",
            sourcePass: "adjudicated",
            publicationState: "local_only",
            originatingPasses: ["diff-risk", "cross-file-impact"],
            adjudication: {
              score: 8.1,
              candidateCount: 2,
              mergedFindingIds: ["raw-1", "raw-2"],
              rationale: "Merged overlapping findings from diff-risk and cross-file-impact with shared evidence.",
              publicationEligible: true,
            },
          },
        ],
        artifacts: [
          {
            id: "artifact-provenance",
            runId: "run-2",
            artifactType: "provenance_brief",
            title: "Provenance brief",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Lane history and prior review signals\"}",
            metadata: { provenanceCount: 4, missionCount: 1, workerDigestCount: 3, sessionDeltaCount: 2, priorReviewCount: 1 },
            createdAt: "2026-04-03T12:01:00.000Z",
          } as any,
          {
            id: "artifact-rules",
            runId: "run-2",
            artifactType: "rule_overlays",
            title: "Rule overlays",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Renderer-surface and shared-contract overlays\"}",
            metadata: { matchedRuleCount: 2, ruleCount: 2, pathCount: 2 },
            createdAt: "2026-04-03T12:01:30.000Z",
          } as any,
          {
            id: "artifact-validation",
            runId: "run-2",
            artifactType: "validation_signals",
            title: "Validation signals",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Checks, tests, and failure excerpts\"}",
            metadata: { signalCount: 3, checkCount: 1, testRunCount: 1, issueCount: 1 },
            createdAt: "2026-04-03T12:01:45.000Z",
          } as any,
          {
            id: "artifact-pass-diff-risk",
            runId: "run-2",
            artifactType: "pass_findings",
            title: "Diff risk findings",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Direct diff risk\"}",
            metadata: { passKey: "diff-risk", summary: "Direct diff risk", totalParsedCount: 1, keptCount: 1, budgetTrimmedCount: 0 },
            createdAt: "2026-04-03T12:02:00.000Z",
          },
          {
            id: "artifact-pass-cross-file",
            runId: "run-2",
            artifactType: "pass_findings",
            title: "Cross-file impact findings",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Cross-file corroboration\"}",
            metadata: { passKey: "cross-file-impact", summary: "Cross-file corroboration", totalParsedCount: 1, keptCount: 1, budgetTrimmedCount: 0 },
            createdAt: "2026-04-03T12:02:30.000Z",
          },
          {
            id: "artifact-adjudication",
            runId: "run-2",
            artifactType: "adjudication_result",
            title: "Review adjudication",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Merged overlaps\"}",
            metadata: { acceptedCount: 1, rejectedCount: 0, publicationEligibleCount: 1 },
            createdAt: "2026-04-03T12:02:45.000Z",
          },
          {
            id: "artifact-merged",
            runId: "run-2",
            artifactType: "merged_findings",
            title: "Merged review findings",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Merged overlaps\"}",
            metadata: { findingCount: 1, publicationEligibleCount: 1 },
            createdAt: "2026-04-03T12:02:50.000Z",
          },
          { id: "artifact-1", runId: "run-2", artifactType: "diff_bundle", title: "Captured diff", mimeType: "text/plain", contentText: "diff --git a/src/review/run.ts b/src/review/run.ts", metadata: null, createdAt: "2026-04-03T12:03:00.000Z" },
        ],
        publications: [],
        chatSession: {
          sessionId: "session-2",
          laneId: "lane-bugfix",
          provider: "codex",
          model: "gpt-5.4-codex",
          status: "active",
          startedAt: "2026-04-03T12:01:00.000Z",
          endedAt: null,
          lastActivityAt: "2026-04-03T12:05:00.000Z",
          lastOutputPreview: "Review transcript",
          summary: "Review transcript",
          title: "Review transcript",
        },
      }],
      ["run-3", {
        ...run3,
        findings: [],
        artifacts: [],
        publications: [],
        chatSession: null,
      }],
    ]);
    globalThis.window.ade = {
      app: {
        openPathInEditor: vi.fn(async () => undefined),
      },
      review: {
        listLaunchContext: vi.fn(async () => ({
          lanes: [
            { id: "lane-review", name: "feature/review-tab", branchRef: "refs/heads/feature/review-tab", baseRef: "main", laneType: "worktree", color: null },
            { id: "lane-bugfix", name: "bugfix/review-engine", branchRef: "refs/heads/bugfix/review-engine", baseRef: "main", laneType: "worktree", color: null },
          ],
          defaultLaneId: "lane-review",
          defaultBranchName: "main",
          recentCommitsByLane: {
            "lane-review": [
              { sha: "abc123def4567890", shortSha: "abc123d", subject: "First commit", authoredAt: "2026-04-01T12:00:00.000Z", pushed: true },
              { sha: "def456abc1237890", shortSha: "def456a", subject: "Second commit", authoredAt: "2026-04-02T12:00:00.000Z", pushed: true },
            ],
          },
          recommendedModelId: "openai/gpt-5.5-codex",
        })),
        listRuns: vi.fn(async () => runs),
        getRunDetail: vi.fn(async (runId: string) => details.get(runId) ?? null),
        startRun: vi.fn(async () => {
          runs = [run3, ...runs.filter((run) => run.id !== "run-3")];
          return { runId: "run-3" };
        }),
        rerun: vi.fn(async () => {
          runs = [run3, ...runs.filter((run) => run.id !== "run-3")];
          return { runId: "run-3" };
        }),
        onEvent: vi.fn(() => () => undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("loads a saved run from the query param and reruns it", async () => {
    render(
      <MemoryRouter initialEntries={["/review?runId=run-2"]}>
        <Routes>
          <Route path="/review" element={<><LocationProbe /><ReviewPage /></>} />
          <Route path="/files" element={<FilesProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("location-search").textContent).toContain("runId=run-2"));
    expect((await screen.findAllByText("Reviewed lane-to-lane diff")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Missing guard on empty result")).toBeTruthy();
    expect(await screen.findByText("Passes and adjudication")).toBeTruthy();
    expect(await screen.findByText("publication eligible")).toBeTruthy();
    expect(AgentChatPane).toHaveBeenCalled();
    expect(AgentChatPane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lockSessionId: "session-2",
        presentation: expect.objectContaining({ mode: "resolver", assistantLabel: "Review" }),
      }),
      expect.anything(),
    );

    fireEvent.click(screen.getByRole("button", { name: /rerun/i }));

    await waitFor(() => expect((window.ade.review as any).rerun).toHaveBeenCalledWith("run-2"));
    await waitFor(() => expect(screen.getByTestId("location-search").textContent).toContain("runId=run-3"));
  });

  it("surfaces ADE-native finding classes and compact review context artifacts", async () => {
    render(
      <MemoryRouter initialEntries={["/review?runId=run-2"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Context used for this review")).toBeTruthy();
    expect((await screen.findAllByText("Provenance brief")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Rule overlays")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Validation signals")).length).toBeGreaterThan(0);
    expect(await screen.findByText("4 items")).toBeTruthy();
    expect(await screen.findByText("2 items")).toBeTruthy();
    expect(await screen.findByText("3 items")).toBeTruthy();
    expect(await screen.findByText("intent drift")).toBeTruthy();
  });

  it("opens findings in ADE files first and keeps the editor handoff secondary", async () => {
    render(
      <MemoryRouter initialEntries={["/review?runId=run-2"]}>
        <Routes>
          <Route path="/review" element={<><LocationProbe /><ReviewPage /></>} />
          <Route path="/files" element={<FilesProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Missing guard on empty result")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open editor/i }));
    await waitFor(() => expect(window.ade.app.openPathInEditor).toHaveBeenCalledWith({
      rootPath: "/Users/arul/ADE-bugfix",
      target: "src/review/run.ts",
    }));

    fireEvent.click(screen.getByRole("button", { name: /open in files/i }));
    await waitFor(() => expect(screen.getByTestId("files-probe").textContent).toBe("/files|lane-bugfix|src/review/run.ts"));
  });

  it("starts a lane diff review against the default branch", async () => {
    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<><LocationProbe /><ReviewPage /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByText("Launch review").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /select model/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /start review/i }));

    await waitFor(() => expect((window.ade.review as any).startRun).toHaveBeenCalled());
    const [{ target, config }] = (window.ade.review as any).startRun.mock.calls[0];
    expect(target).toEqual({ mode: "lane_diff", laneId: "lane-review" });
    expect(config).toMatchObject({
      compareAgainst: { kind: "default_branch" },
      selectionMode: "full_diff",
      dirtyOnly: false,
      modelId: "openai/gpt-5.5-codex",
      reasoningEffort: "medium",
      publishBehavior: "local_only",
    });
  });

  it("defaults commit range to the newest commit as head and the previous commit as base", async () => {
    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByText("Launch review").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Commit range"));

    const baseSelect = screen.getByRole("combobox", { name: /earlier commit \(base\)/i }) as HTMLSelectElement;
    const headSelect = screen.getByRole("combobox", { name: /later commit \(head\)/i }) as HTMLSelectElement;

    expect(baseSelect.value).toBe("abc123def4567890");
    expect(headSelect.value).toBe("def456abc1237890");

    fireEvent.click(screen.getByRole("button", { name: /start review/i }));

    await waitFor(() => expect((window.ade.review as any).startRun).toHaveBeenCalled());
    const [{ target, config }] = (window.ade.review as any).startRun.mock.calls[0];
    expect(target).toEqual({
      mode: "commit_range",
      laneId: "lane-review",
      baseCommit: "abc123def4567890",
      headCommit: "def456abc1237890",
    });
    expect(config).toMatchObject({
      selectionMode: "selected_commits",
      dirtyOnly: false,
      modelId: "openai/gpt-5.5-codex",
    });
  });

  it("disables commit-range selectors when the lane only has one recent commit", async () => {
    (window.ade.review as any).listLaunchContext.mockResolvedValueOnce({
      lanes: [
        { id: "lane-review", name: "feature/review-tab", branchRef: "refs/heads/feature/review-tab", baseRef: "main", laneType: "worktree", color: null },
      ],
      defaultLaneId: "lane-review",
      defaultBranchName: "main",
      recentCommitsByLane: {
        "lane-review": [
          { sha: "abc123def4567890", shortSha: "abc123d", subject: "Only commit", authoredAt: "2026-04-01T12:00:00.000Z", pushed: true },
        ],
      },
      recommendedModelId: "openai/gpt-5.5-codex",
    });

    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByText("Launch review").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Commit range"));

    const baseSelect = screen.getByRole("combobox", { name: /earlier commit \(base\)/i }) as HTMLSelectElement;
    const headSelect = screen.getByRole("combobox", { name: /later commit \(head\)/i }) as HTMLSelectElement;

    expect(baseSelect.value).toBe("");
    expect(headSelect.value).toBe("");
    expect(baseSelect.disabled).toBe(true);
    expect(headSelect.disabled).toBe(true);
    expect(screen.getByText(/at least two recent commits are needed to review a commit range/i)).toBeTruthy();
  });

  it("shows a placeholder instead of fabricating missing timestamps", async () => {
    const missingTimeRun = {
      id: "run-missing-time",
      projectId: "project-1",
      laneId: "lane-review",
      status: "completed",
      targetLabel: "feature/review-tab vs main",
      compareTarget: { kind: "default_branch", label: "main", ref: "main", laneId: null, branchRef: "main" },
      target: { mode: "lane_diff", laneId: "lane-review" },
      config: {
        compareAgainst: { kind: "default_branch" },
        selectionMode: "full_diff",
        dirtyOnly: false,
        modelId: "openai/gpt-5.5-codex",
        reasoningEffort: "medium",
        budgets: { maxFiles: 25, maxDiffChars: 120000, maxPromptChars: 60000, maxFindings: 8, maxFindingsPerPass: 6, maxPublishedFindings: 6 },
        publishBehavior: "local_only",
      },
      summary: "Missing timestamps should stay visible as missing.",
      errorMessage: null,
      findingCount: 0,
      severitySummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      chatSessionId: null,
      createdAt: null,
      startedAt: null,
      endedAt: null,
      updatedAt: null,
    } as any;
    (window.ade.review as any).listRuns.mockResolvedValue([missingTimeRun]);
    (window.ade.review as any).getRunDetail.mockResolvedValue({
      ...missingTimeRun,
      findings: [],
      artifacts: [],
      chatSession: null,
    });

    render(
      <MemoryRouter initialEntries={["/review?runId=run-missing-time"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Missing timestamps should stay visible as missing.")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows an inline error banner when refreshing runs fails after runs are already loaded", async () => {
    const reviewBridge = window.ade.review as any;

    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Reviewed against default branch")).toBeTruthy();
    reviewBridge.listRuns.mockRejectedValueOnce(new Error("Refresh failed"));

    fireEvent.click(screen.getByRole("button", { name: /refresh runs/i }));

    expect((await screen.findByRole("alert")).textContent).toContain("Refresh failed");
    expect(screen.getAllByText("feature/review-tab vs main").length).toBeGreaterThan(0);
  });
});
