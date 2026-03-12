/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AiPermissionMode, LaneSummary, RebaseNeed, RebaseRun } from "../../../../shared/types";
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

const prAiResolverPanelSpy = vi.fn();
vi.mock("../shared/PrAiResolverPanel", () => ({
  PrAiResolverPanel: (props: Record<string, unknown>) => {
    prAiResolverPanelSpy(props);
    const context = (props.context as Record<string, unknown> | undefined) ?? {};
    return (
      <div
        data-testid="ai-resolver"
        data-permission-mode={String(props.permissionMode ?? "")}
        data-source-tab={String(context.sourceTab ?? "")}
        data-source-lane-id={String(context.sourceLaneId ?? "")}
        data-target-lane-id={String(context.targetLaneId ?? "")}
      >
        AI resolver
      </div>
    );
  },
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

function renderRebaseTab(overrides: Partial<React.ComponentProps<typeof RebaseTab>> = {}) {
  return render(
    <RebaseTab
      rebaseNeeds={[makeNeed()]}
      lanes={[makeLane(), makeLane({ id: "lane-main", name: "Primary", laneType: "primary", parentLaneId: null, childCount: 1, branchRef: "main", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })]}
      selectedItemId="lane-1"
      onSelectItem={vi.fn()}
      resolverModel="anthropic/claude-sonnet-4-6"
      resolverReasoningLevel="medium"
      resolverPermissionMode={"guarded_edit" satisfies AiPermissionMode}
      onResolverChange={vi.fn()}
      onResolverPermissionChange={vi.fn()}
      onRefresh={vi.fn(async () => {})}
      {...overrides}
    />,
  );
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
    prAiResolverPanelSpy.mockClear();
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
    cleanup();
    delete (window as any).ade;
  });

  it("renders the selected lane rebase controls", () => {
    renderRebaseTab();

    expect(screen.getByText("REBASE RUN CONTROL CENTER")).toBeTruthy();
    expect(screen.getByRole("button", { name: "CURRENT LANE ONLY" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "LANE + CHILDREN" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DEFER 4H" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "DISMISS" })).toBeTruthy();
    expect(screen.getByText("Pick the model here, then it locks once the resolver starts.")).toBeTruthy();
  });

  it("starts a local rebase and rescans rebase needs immediately", async () => {
    rebaseStart.mockResolvedValue({ runId: "run-1", run: makeRun("lane_only") });
    const onRefresh = vi.fn(async () => {});
    renderRebaseTab({
      rebaseNeeds: [makeNeed({ conflictPredicted: false, conflictingFiles: [] })],
      onRefresh,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "CURRENT LANE ONLY" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "REBASE NOW (LOCAL ONLY)" })[0]!);

    await waitFor(() => {
      expect(rebaseStart).toHaveBeenCalledWith(
        expect.objectContaining({ laneId: "lane-1", pushMode: "none", actor: "user" }),
      );
    });
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("opens the inline AI resolver with rebase-specific context", async () => {
    renderRebaseTab();
    fireEvent.click(screen.getAllByRole("button", { name: "REBASE WITH AI" })[1]!);

    const resolver = await screen.findByTestId("ai-resolver");
    expect(resolver.getAttribute("data-source-tab")).toBe("rebase");
    expect(resolver.getAttribute("data-source-lane-id")).toBe("lane-1");
    expect(resolver.getAttribute("data-target-lane-id")).toBe("lane-main");
    expect(prAiResolverPanelSpy).toHaveBeenCalled();
  });

  it("passes the selected resolver permission into the PR AI panel", async () => {
    renderRebaseTab({ resolverPermissionMode: "full_edit" });
    fireEvent.click(screen.getAllByRole("button", { name: "REBASE WITH AI" })[1]!);

    const resolver = await screen.findByTestId("ai-resolver");
    expect(resolver.getAttribute("data-permission-mode")).toBe("full_edit");
  });
});
