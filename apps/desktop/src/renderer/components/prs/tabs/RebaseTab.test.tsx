/* @vitest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { LaneSummary, RebaseNeed, RebaseRun } from "../../../../shared/types";
import { RebaseTab } from "./RebaseTab";

vi.mock("../../ui/PaneTilingLayout", () => ({
  PaneTilingLayout: ({ panes }: { panes: Record<string, { children: React.ReactNode }> }) => (
    <div>
      {Object.values(panes).map((pane, index) => (
        <section key={index}>{pane.children}</section>
      ))}
    </div>
  ),
}));

vi.mock("../shared/UrgencyGroup", () => ({
  UrgencyGroup: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <div>{title}</div>
      {children}
    </div>
  ),
}));

vi.mock("../shared/PrAiResolverPanel", () => ({
  PrAiResolverPanel: () => <div>AI resolver</div>,
}));

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "wave1-W-UX",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "ade/wave1-w-ux",
    worktreePath: "/tmp/lane-1",
    attachedRootPath: null,
    parentLaneId: "lane-main",
    childCount: 0,
    stackDepth: 1,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-03-11T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: "lane-1",
    laneName: "wave1-W-UX",
    baseBranch: "main",
    behindBy: 1,
    conflictPredicted: true,
    conflictingFiles: ["apps/desktop/src/renderer/components/automations/AutomationsPage.test.tsx"],
    prId: null,
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

function makeRun(scope: RebaseRun["scope"] = "lane_only"): RebaseRun {
  return {
    runId: "run-1",
    rootLaneId: "lane-1",
    scope,
    pushMode: "none",
    state: "completed",
    startedAt: "2026-03-11T12:00:00.000Z",
    finishedAt: "2026-03-11T12:01:00.000Z",
    actor: "user",
    baseBranch: "main",
    lanes: [],
    currentLaneId: null,
    failedLaneId: null,
    error: null,
    pushedLaneIds: [],
    canRollback: false,
  };
}

describe("RebaseTab", () => {
  const rebaseStart = vi.fn();
  const rebaseSubscribe = vi.fn(() => () => {});
  const scanNeeds = vi.fn(async () => []);
  const prepareProposal = vi.fn(async () => ({
    laneId: "lane-1",
    peerLaneId: "lane-main",
    provider: "subscription",
    preparedAt: "2026-03-11T12:00:00.000Z",
    contextDigest: "digest",
    activeConflict: {
      laneId: "lane-1",
      kind: null,
      inProgress: false,
      conflictedFiles: [],
      canContinue: false,
      canAbort: false,
    },
    laneExportLite: null,
    peerLaneExportLite: null,
    conflictExportStandard: null,
    files: [],
    stats: {
      approxChars: 0,
      laneExportChars: 0,
      peerLaneExportChars: 0,
      conflictExportChars: 0,
      fileCount: 0,
    },
    warnings: [],
    existingProposalId: null,
  }));

  beforeEach(() => {
    rebaseStart.mockReset();
    rebaseSubscribe.mockClear();
    scanNeeds.mockClear();
    prepareProposal.mockClear();
    (window as any).ade = {
      lanes: {
        rebaseStart,
        rebaseAbort: vi.fn(),
        rebaseRollback: vi.fn(),
        rebasePush: vi.fn(),
        rebaseSubscribe,
      },
      rebase: {
        scanNeeds,
      },
      conflicts: {
        prepareProposal,
      },
    };
  });

  afterEach(() => {
    delete (window as any).ade;
  });

  it("hides descendant scope and rebase-tab defer-dismiss controls for lanes without children", () => {
    render(
      <RebaseTab
        rebaseNeeds={[makeNeed()]}
        lanes={[makeLane(), makeLane({ id: "lane-main", name: "Primary", laneType: "primary", parentLaneId: null, childCount: 1, branchRef: "main", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })]}
        selectedItemId="lane-1"
        onSelectItem={vi.fn()}
        resolverModel="anthropic/claude-sonnet-4-6"
        resolverReasoningLevel="medium"
        onResolverChange={vi.fn()}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    expect(screen.queryByText("LANE + CHILDREN")).toBeNull();
    expect(screen.getByText("This lane has no child lanes, so only the current lane will be rebased.")).toBeTruthy();
    expect(screen.queryByText("DEFER 4H")).toBeNull();
    expect(screen.queryByText("DISMISS")).toBeNull();
    expect(screen.queryByText("REBASE RUN CONTROL CENTER")).toBeNull();
    expect(screen.queryByText("CONTINUE")).toBeNull();
    expect(screen.queryByText("SKIP LANE")).toBeNull();
  });

  it("rebases zero-child lanes with lane_only scope and rescans rebase needs immediately", async () => {
    rebaseStart.mockResolvedValue({ runId: "run-1", run: makeRun("lane_only") });
    render(
      <RebaseTab
        rebaseNeeds={[makeNeed({ conflictPredicted: false, conflictingFiles: [] })]}
        lanes={[makeLane(), makeLane({ id: "lane-main", name: "Primary", laneType: "primary", parentLaneId: null, childCount: 1, branchRef: "main", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })]}
        selectedItemId="lane-1"
        onSelectItem={vi.fn()}
        resolverModel="anthropic/claude-sonnet-4-6"
        resolverReasoningLevel="medium"
        onResolverChange={vi.fn()}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "REBASE NOW (LOCAL ONLY)" })[0]!);

    await waitFor(() => {
      expect(rebaseStart).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-1", scope: "lane_only" }));
    });
    await waitFor(() => {
      expect(scanNeeds).toHaveBeenCalled();
    });
  });

  it("loads overlap previews in preview mode so blocked parent stacks do not hard-fail the tab", async () => {
    prepareProposal.mockResolvedValue({
      laneId: "lane-1",
      peerLaneId: "lane-main",
      provider: "subscription",
      preparedAt: "2026-03-11T12:00:00.000Z",
      contextDigest: "digest",
      activeConflict: {
        laneId: "lane-1",
        kind: null,
        inProgress: false,
        conflictedFiles: [],
        canContinue: false,
        canAbort: false,
      },
      laneExportLite: null,
      peerLaneExportLite: null,
      conflictExportStandard: null,
      files: [
        {
          path: "apps/desktop/src/renderer/components/automations/AutomationsPage.test.tsx",
          conflictType: "content",
          laneDiff: "@@ -1 +1 @@\n-old\n+new\n",
          peerDiff: "@@ -1 +1 @@\n-old\n+peer\n",
          markerPreview: null,
        },
      ],
      stats: {
        approxChars: 100,
        laneExportChars: 0,
        peerLaneExportChars: 0,
        conflictExportChars: 0,
        fileCount: 1,
      },
      warnings: [
        "Subscription AI is unavailable; proposal preview is prepared for manual/external resolution.",
        "Pack refresh removed in W6; using live git/conflict state only.",
        "Conflict/lane pack exports removed in W6; AI context uses direct overlap/conflict payloads.",
        "Peer diff (apps/desktop/src/renderer/components/automations/AutomationsPage.test.tsx) truncated to 6000 characters.",
      ],
      existingProposalId: null,
    });

    render(
      <RebaseTab
        rebaseNeeds={[makeNeed()]}
        lanes={[makeLane(), makeLane({ id: "lane-main", name: "Primary", laneType: "primary", parentLaneId: null, childCount: 1, branchRef: "main", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })]}
        selectedItemId="lane-1"
        onSelectItem={vi.fn()}
        resolverModel="anthropic/claude-sonnet-4-6"
        resolverReasoningLevel="medium"
        onResolverChange={vi.fn()}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    await waitFor(() => {
      expect(prepareProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          peerLaneId: "lane-main",
          allowBlockedParentPreview: true,
        }),
      );
    });

    expect(screen.queryByText(/Subscription AI is unavailable/i)).toBeNull();
    expect(screen.queryByText(/Pack refresh removed in W6/i)).toBeNull();
    expect(screen.queryByText(/Conflict\/lane pack exports removed in W6/i)).toBeNull();
    expect(screen.getByText(/truncated to 6000 characters/i)).toBeTruthy();
  });
});
