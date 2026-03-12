/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowsTab } from "./WorkflowsTab";

const usePrsMock = vi.fn();

vi.mock("../state/PrsContext", () => ({
  usePrs: () => usePrsMock(),
}));

vi.mock("./IntegrationTab", () => ({
  IntegrationTab: ({ selectedPrId }: { selectedPrId: string | null }) => (
    <div data-testid="integration-tab">integration tab for {selectedPrId ?? "none"}</div>
  ),
}));

vi.mock("./QueueTab", () => ({
  QueueTab: () => <div data-testid="queue-tab">queue tab</div>,
}));

vi.mock("./RebaseTab", () => ({
  RebaseTab: () => <div data-testid="rebase-tab">rebase tab</div>,
}));

function makePrsState() {
  return {
    prs: [],
    lanes: [],
    mergeContextByPrId: {},
    mergeMethod: "squash",
    selectedQueueGroupId: null,
    setSelectedQueueGroupId: vi.fn(),
    selectedRebaseItemId: null,
    setSelectedRebaseItemId: vi.fn(),
    rebaseNeeds: [],
    queueStates: {},
    queueRehearsals: {},
    resolverModel: "anthropic/claude-sonnet-4-6",
    resolverReasoningLevel: "medium",
    resolverPermissionMode: "guarded_edit",
    setResolverModel: vi.fn(),
    setResolverReasoningLevel: vi.fn(),
    setResolverPermissionMode: vi.fn(),
  };
}

describe("WorkflowsTab", () => {
  beforeEach(() => {
    usePrsMock.mockReturnValue(makePrsState());
    (window as any).ade = {
      prs: {
        listIntegrationWorkflows: vi.fn(async () => [
          {
            proposalId: "proposal-1",
            title: "History workflow",
            status: "committed",
            overallOutcome: "clean",
            sourceLaneIds: ["lane-1"],
            integrationLaneId: "lane-int",
            integrationLaneName: "integration/lane-int",
            baseBranch: "main",
            body: "workflow body",
            createdAt: "2026-03-12T12:00:00.000Z",
            cleanupState: "completed",
            workflowDisplayState: "history",
          },
        ]),
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("renders the rich integration tab for active integration workflows", () => {
    render(
      <WorkflowsTab
        activeCategory="integration"
        onChangeCategory={vi.fn()}
        onRefreshAll={vi.fn(async () => {})}
        selectedPrId="pr-123"
        onSelectPr={vi.fn()}
        onOpenGitHubTab={vi.fn()}
        integrationRefreshNonce={0}
      />,
    );

    expect(screen.getByTestId("integration-tab").textContent).toContain("integration tab for pr-123");
  });

  it("shows the workflow history viewer when integration history is selected", async () => {
    render(
      <WorkflowsTab
        activeCategory="integration"
        onChangeCategory={vi.fn()}
        onRefreshAll={vi.fn(async () => {})}
        selectedPrId={null}
        onSelectPr={vi.fn()}
        onOpenGitHubTab={vi.fn()}
        integrationRefreshNonce={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "history" }));

    await waitFor(() => {
      expect(screen.getByText("Stage 1 · Proposal")).toBeTruthy();
    });
    expect(screen.queryByTestId("integration-tab")).toBeNull();
  });
});
