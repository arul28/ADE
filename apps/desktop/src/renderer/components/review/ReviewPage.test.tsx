/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ReviewPage } from "./ReviewPage";
import { useAppStore } from "../../state/appStore";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div data-testid="review-layout">{children}</div>,
  Panel: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { id?: string }) => (
    <div data-testid={props.id} {...props}>
      {children}
    </div>
  ),
  Separator: (props: React.HTMLAttributes<HTMLDivElement>) => <div role="separator" {...props} />,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

async function openLaunchReviewModal() {
  fireEvent.click(await screen.findByRole("button", { name: /^launch new review$/i }));
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
        modelId: "openai/gpt-5.5",
        reasoningEffort: "medium",
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
        modelId: "openai/gpt-5.5",
        reasoningEffort: "high",
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
        modelId: "openai/gpt-5.5",
        reasoningEffort: "medium",
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
        reviewerRuns: [],
        candidateFindings: [],
        publications: [],
        chatSession: {
          sessionId: "session-1",
          laneId: "lane-review",
          provider: "codex",
          model: "gpt-5.4",
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
            metadata: { provenanceCount: 4, workerDigestCount: 3, sessionDeltaCount: 2, priorReviewCount: 1 },
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
            metadata: { passKey: "diff-risk", summary: "Direct diff risk", totalParsedCount: 1, keptCount: 1 },
            createdAt: "2026-04-03T12:02:00.000Z",
          },
          {
            id: "artifact-pass-cross-file",
            runId: "run-2",
            artifactType: "pass_findings",
            title: "Cross-file impact findings",
            mimeType: "application/json",
            contentText: "{\"summary\":\"Cross-file corroboration\"}",
            metadata: { passKey: "cross-file-impact", summary: "Cross-file corroboration", totalParsedCount: 1, keptCount: 1 },
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
        reviewerRuns: [
          {
            id: "reviewer-diff",
            runId: "run-2",
            reviewerKey: "diff-risk",
            label: "Diff risk",
            focus: "direct diff risks",
            status: "completed",
            chatSessionId: "session-2",
            promptArtifactId: "prompt-diff",
            outputArtifactId: "output-diff",
            findingsArtifactId: "artifact-pass-diff-risk",
            candidateCount: 1,
            keptCount: 1,
            summary: "Direct diff risk",
            errorMessage: null,
            startedAt: "2026-04-03T12:01:00.000Z",
            endedAt: "2026-04-03T12:02:00.000Z",
            createdAt: "2026-04-03T12:01:00.000Z",
            updatedAt: "2026-04-03T12:02:00.000Z",
          },
        ],
        candidateFindings: [
          {
            id: "candidate-1",
            runId: "run-2",
            reviewerRunId: "reviewer-diff",
            reviewerKey: "diff-risk",
            title: "Missing guard on empty result",
            severity: "high",
            findingClass: "intent_drift",
            body: "The branch can surface a blank state instead of the expected fallback.",
            confidence: 0.92,
            evidence: [],
            filePath: "src/review/run.ts",
            line: 42,
            anchorState: "anchored",
            evidenceScore: 0.8,
            lowSignal: false,
            score: 8.1,
            createdAt: "2026-04-03T12:02:00.000Z",
          },
        ],
        publications: [],
        chatSession: {
          sessionId: "session-2",
          laneId: "lane-bugfix",
          provider: "codex",
          model: "gpt-5.4",
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
        reviewerRuns: [],
        candidateFindings: [],
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
          recommendedModelId: "openai/gpt-5.5",
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
    const detailPane = screen.getByTestId("pane-detail");
    expect(within(detailPane).getByText("Review scope")).toBeTruthy();
    expect(within(detailPane).getByText("vs.")).toBeTruthy();
    expect(within(detailPane).getByText("Compare against")).toBeTruthy();
    expect(within(detailPane).getByText(/Reviewed how bugfix\/review-engine differs from feature\/review-tab/i)).toBeTruthy();
    expect(within(detailPane).queryByText("Target mode")).toBeNull();
    expect(await screen.findByText("Missing guard on empty result")).toBeTruthy();
    expect(await screen.findByText("Reviewer outputs")).toBeTruthy();
    expect(await screen.findByText(/strong evidence/i)).toBeTruthy();
    expect(await screen.findByText("Review agent transcript available")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open diff risk transcript in work/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /open.*work/i }).length).toBeGreaterThan(0);
    expect(within(detailPane).getByText(/Run run-2 · Started .* · Completed/i)).toBeTruthy();
    expect(within(detailPane).getByText("Model and reasoning")).toBeTruthy();
    expect(within(detailPane).getByRole("button", { name: /select model \(current: GPT-5\.5\)/i })).toBeTruthy();
    expect(within(detailPane).getByRole("button", { name: "Reasoning effort" })).toBeTruthy();
    expect(within(detailPane).getByRole("button", { name: "Fast mode" })).toBeTruthy();
    expect(within(detailPane).queryByText("Run id")).toBeNull();
    expect(within(detailPane).queryByText(/^Lane$/)).toBeNull();
    expect(within(detailPane).queryByText(/^Publish$/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /rerun/i }));

    await waitFor(() => expect((window.ade.review as any).rerun).toHaveBeenCalledWith("run-2"));
    await waitFor(() => expect(screen.getByTestId("location-search").textContent).toContain("runId=run-3"));
  });

  it("does not show no findings while finding detail is still loading", async () => {
    (window.ade.review as any).getRunDetail.mockImplementation(() => new Promise(() => undefined));

    render(
      <MemoryRouter initialEntries={["/review?runId=run-2"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect((window.ade.review as any).getRunDetail).toHaveBeenCalledWith("run-2"));
    expect(screen.getByText(/Loading findings and evidence for this run/i)).toBeTruthy();
    expect(screen.queryByText("No findings")).toBeNull();
  });

  it("surfaces partial reviewer coverage in the primary review summary", async () => {
    const partialRun = {
      id: "run-partial",
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
        modelId: "openai/gpt-5.5",
        reasoningEffort: "medium",
        publishBehavior: "local_only",
      },
      summary: "Multi-pass review kept 1 high-signal finding(s) from 1 candidate(s). Partial review: 1 specialist reviewer failed (Security/data).",
      errorMessage: "Partial review: 1 specialist reviewer failed (Security/data).",
      findingCount: 0,
      severitySummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      chatSessionId: "session-partial",
      createdAt: "2026-04-05T12:00:00.000Z",
      startedAt: "2026-04-05T12:01:00.000Z",
      endedAt: "2026-04-05T12:05:00.000Z",
      updatedAt: "2026-04-05T12:05:00.000Z",
    } as const;
    (window.ade.review as any).listRuns.mockResolvedValue([partialRun]);
    (window.ade.review as any).getRunDetail.mockResolvedValue({
      ...partialRun,
      findings: [],
      artifacts: [],
      reviewerRuns: [
        {
          id: "reviewer-security",
          runId: "run-partial",
          reviewerKey: "security-data",
          label: "Security/data",
          focus: "security and data risks",
          status: "failed",
          chatSessionId: "session-security",
          promptArtifactId: "prompt-security",
          outputArtifactId: null,
          findingsArtifactId: null,
          candidateCount: 0,
          keptCount: 0,
          summary: null,
          errorMessage: "Timed out.",
          startedAt: "2026-04-05T12:01:00.000Z",
          endedAt: "2026-04-05T12:05:00.000Z",
          createdAt: "2026-04-05T12:01:00.000Z",
          updatedAt: "2026-04-05T12:05:00.000Z",
        },
        {
          id: "reviewer-checks",
          runId: "run-partial",
          reviewerKey: "checks-and-tests",
          label: "Checks and tests",
          focus: "validation evidence",
          status: "completed",
          chatSessionId: "session-checks",
          promptArtifactId: "prompt-checks",
          outputArtifactId: "output-checks",
          findingsArtifactId: "findings-checks",
          candidateCount: 0,
          keptCount: 0,
          summary: "No checks findings.",
          errorMessage: null,
          startedAt: "2026-04-05T12:01:00.000Z",
          endedAt: "2026-04-05T12:03:00.000Z",
          createdAt: "2026-04-05T12:01:00.000Z",
          updatedAt: "2026-04-05T12:03:00.000Z",
        },
      ],
      candidateFindings: [],
      publications: [],
      chatSession: null,
    });

    render(
      <MemoryRouter initialEntries={["/review?runId=run-partial"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Review partially complete/i)).toBeTruthy();
    expect(await screen.findByText(/Partial review: 1\/2 specialist reviewers completed; failed: Security\/data/i)).toBeTruthy();
    expect(await screen.findByText("Specialist reviewer transcripts available")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open checks and tests transcript in work/i })).toBeTruthy();
    expect(screen.queryByText(/2 specialist reviewers completed\. Evidence/i)).toBeNull();
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
    expect(await screen.findByText("Goal mismatch")).toBeTruthy();
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

    await waitFor(() => expect(screen.getByRole("button", { name: /^launch new review$/i })).toBeTruthy());
    await openLaunchReviewModal();
    expect(screen.getByRole("button", { name: /select model/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /start review/i }));

    await waitFor(() => expect((window.ade.review as any).startRun).toHaveBeenCalled());
    const [{ target, config }] = (window.ade.review as any).startRun.mock.calls[0];
    expect(target).toEqual({ mode: "lane_diff", laneId: "lane-review" });
    expect(config).toMatchObject({
      compareAgainst: { kind: "default_branch" },
      selectionMode: "full_diff",
      dirtyOnly: false,
      modelId: "openai/gpt-5.5",
      reasoningEffort: "medium",
      publishBehavior: "local_only",
    });
  });

  it("starts a review with Codex fast mode enabled", async () => {
    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^launch new review$/i })).toBeTruthy());
    await openLaunchReviewModal();
    expect(
      screen.getByText(/This is read only and the model can only read and inspect files/i),
    ).toBeTruthy();

    const fastModeButton = screen.getByRole("button", { name: "Fast mode" });
    fireEvent.click(fastModeButton);
    expect(fastModeButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /start review/i }));

    await waitFor(() => expect((window.ade.review as any).startRun).toHaveBeenCalled());
    const [{ config }] = (window.ade.review as any).startRun.mock.calls[0];
    expect(config).toMatchObject({
      modelId: "openai/gpt-5.5",
      codexFastMode: true,
    });
  });

  it("starts a review with the selected launch config", async () => {
    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^launch new review$/i })).toBeTruthy());
    await openLaunchReviewModal();
    fireEvent.click(screen.getByRole("button", { name: /start review/i }));

    await waitFor(() => expect((window.ade.review as any).startRun).toHaveBeenCalled());
    const [{ config }] = (window.ade.review as any).startRun.mock.calls[0];
    expect(config).toMatchObject({
      publishBehavior: "local_only",
    });
    expect(config.budgets).toBeUndefined();
  });

  it("uses explicit local base language for non-primary lane comparisons", async () => {
    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^launch new review$/i })).toBeTruthy());
    await openLaunchReviewModal();

    expect(screen.getByText("Compare with main")).toBeTruthy();
    expect(screen.getByText(/feature\/review-tab: branch changes vs local main/i)).toBeTruthy();
    expect(screen.getByText(/since it split from local main/i)).toBeTruthy();
    expect(screen.getByText(/Pull or merge remote changes into main first/i)).toBeTruthy();
  });

  it("uses local upstream ref language for primary lane comparisons", async () => {
    useAppStore.setState({
      selectedLaneId: "lane-primary",
      lanes: [
        {
          id: "lane-primary",
          name: "Primary",
          branchRef: "refs/heads/main",
          baseRef: "main",
          laneType: "primary",
          color: null,
          worktreePath: "/Users/arul/ADE",
          status: {} as any,
        },
      ] as any,
    });
    (window.ade.review as any).listLaunchContext.mockResolvedValueOnce({
      lanes: [
        { id: "lane-primary", name: "Primary", branchRef: "refs/heads/main", baseRef: "main", laneType: "primary", color: null },
      ],
      defaultLaneId: "lane-primary",
      defaultBranchName: "main",
      recentCommitsByLane: {},
      recommendedModelId: "openai/gpt-5.5",
    });

    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^launch new review$/i })).toBeTruthy());
    await openLaunchReviewModal();

    expect(screen.getByText("Compare with origin/main")).toBeTruthy();
    expect(screen.getByText(/local main vs local origin\/main/i)).toBeTruthy();
    expect(screen.getByText(/Reviews local commits on main against local origin\/main/i)).toBeTruthy();
    expect(screen.getAllByText(/fetch or pull first when you want latest remote changes included/i).length).toBeGreaterThan(0);
  });

  it("defaults commit range to the newest commit as head and the previous commit as base", async () => {
    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^launch new review$/i })).toBeTruthy());
    await openLaunchReviewModal();
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
      modelId: "openai/gpt-5.5",
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
      recommendedModelId: "openai/gpt-5.5",
    });

    render(
      <MemoryRouter initialEntries={["/review"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^launch new review$/i })).toBeTruthy());
    await openLaunchReviewModal();
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
        modelId: "openai/gpt-5.5",
        reasoningEffort: "medium",
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
      reviewerRuns: [],
      candidateFindings: [],
      publications: [],
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
    expect(screen.getByText(/Run run-missing-time · Started —/)).toBeTruthy();
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
    const detailPane = screen.getByTestId("pane-detail");
    expect(within(detailPane).getByText("Review scope")).toBeTruthy();
    expect(within(detailPane).getByText(/Comparing against local main\. Fetch or pull first when you want latest remote changes included\. Selection: Full diff\./i)).toBeTruthy();
    expect(within(detailPane).queryByText("Selection mode")).toBeNull();
    reviewBridge.listRuns.mockRejectedValueOnce(new Error("Refresh failed"));

    fireEvent.click(screen.getByRole("button", { name: /refresh runs/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Refresh failed");
    });
    expect(screen.getAllByText("feature/review-tab vs main").length).toBeGreaterThan(0);
  });

  it("uses the header refresh control for all review tab reloads", async () => {
    const reviewBridge = window.ade.review as any;

    render(
      <MemoryRouter initialEntries={["/review?runId=run-2"]}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Missing guard on empty result")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^refresh$/i })).toBeNull();

    const listRunsCalls = reviewBridge.listRuns.mock.calls.length;
    const listLaunchContextCalls = reviewBridge.listLaunchContext.mock.calls.length;
    const getRunDetailCalls = reviewBridge.getRunDetail.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /refresh runs/i }));

    await waitFor(() => {
      expect(reviewBridge.listRuns.mock.calls.length).toBeGreaterThan(listRunsCalls);
      expect(reviewBridge.listLaunchContext.mock.calls.length).toBeGreaterThan(listLaunchContextCalls);
      expect(reviewBridge.getRunDetail.mock.calls.length).toBeGreaterThan(getRunDetailCalls);
    });
    expect(reviewBridge.getRunDetail.mock.calls.at(-1)?.[0]).toBe("run-2");
  });
});
