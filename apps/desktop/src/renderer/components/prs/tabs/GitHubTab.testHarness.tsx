import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render } from "@testing-library/react";
import { vi } from "vitest";
import type { LaneSummary, MergeMethod } from "../../../../shared/types";
import type { GitHubTabProps } from "./GitHubTab";
import { installGitHubTabWindowMocks, makePrsContext } from "./GitHubTab.testFixtures";

export const mockUsePrs = vi.fn();

export function MockPanelGroup({ children }: { children: React.ReactNode }) {
  return <div data-testid="github-tab-layout">{children}</div>;
}

export function MockPanel({
  children,
  id,
  defaultSize: _defaultSize,
  minSize: _minSize,
  maxSize: _maxSize,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  id?: string;
  defaultSize?: unknown;
  minSize?: unknown;
  maxSize?: unknown;
}) {
  return <div data-testid={id} {...props}>{children}</div>;
}

export function MockSeparator(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="separator" {...props} />;
}

type MockUnmappedAffordance = {
  canCreateLane: boolean;
  onCreateLane: () => void;
};

export function MockPrDetailPane({
  pr,
  unmapped,
  unmappedAffordance,
}: {
  pr: { id: string };
  unmapped?: boolean;
  unmappedAffordance?: MockUnmappedAffordance | null;
}) {
  return (
    <div data-testid="pr-detail-pane" data-unmapped={unmapped ? "true" : "false"}>
      {pr.id}
      {unmappedAffordance?.canCreateLane ? (
        <div data-testid="pr-unmapped-affordance">
          <button type="button" onClick={unmappedAffordance.onCreateLane}>
            Open as lane
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function setupGitHubTabTest(): void {
  mockUsePrs.mockReturnValue(makePrsContext([
    { id: "pr-open", state: "open", checksStatus: "pending", reviewStatus: "requested", additions: 12, deletions: 3 },
    { id: "pr-merged", state: "merged", checksStatus: "passing", reviewStatus: "approved", additions: 5, deletions: 1 },
  ]));
  installGitHubTabWindowMocks();
}

export function cleanupGitHubTabTest(): void {
  cleanup();
  vi.useRealTimers();
}

export function renderGitHubTab(
  Component: React.ComponentType<GitHubTabProps>,
  overrides: Partial<{
    selectedPrId: string | null;
    selectedPrTarget: GitHubTabProps["selectedPrTarget"];
    onSelectPr: ReturnType<typeof vi.fn>;
    onRefreshAll: ReturnType<typeof vi.fn>;
    lanes: LaneSummary[];
  }> = {},
) {
  const onSelectPr = overrides.onSelectPr ?? vi.fn();
  const onRefreshAll = overrides.onRefreshAll ?? vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <Component
        lanes={overrides.lanes ?? []}
        mergeMethod={"squash" satisfies MergeMethod}
        selectedPrId={overrides.selectedPrId ?? null}
        selectedPrTarget={overrides.selectedPrTarget}
        onSelectPr={onSelectPr}
        onRefreshAll={onRefreshAll}
      />
    </MemoryRouter>,
  );
  return { onSelectPr, onRefreshAll };
}
