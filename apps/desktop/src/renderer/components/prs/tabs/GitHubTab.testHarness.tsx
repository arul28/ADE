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
  linkableLanes: Array<{ id: string; name: string }>;
  selectedLaneId: string;
  onSelectLane: (laneId: string) => void;
  onLink: () => void;
  linkBusy: boolean;
  canCreateLane: boolean;
  onCreateLane: () => void;
  scope: "repo" | "external";
};

export function MockPrDetailPane({
  pr,
  onUnmap,
  unmapped,
  unmappedAffordance,
}: {
  pr: { id: string };
  onUnmap?: () => void;
  unmapped?: boolean;
  unmappedAffordance?: MockUnmappedAffordance | null;
}) {
  return (
    <div data-testid="pr-detail-pane" data-unmapped={unmapped ? "true" : "false"}>
      {pr.id}
      {onUnmap ? <button type="button" onClick={onUnmap}>Unmap from lane</button> : null}
      {unmappedAffordance ? (
        <div data-testid="pr-unmapped-affordance">
          {unmappedAffordance.canCreateLane ? (
            <button type="button" onClick={unmappedAffordance.onCreateLane}>
              Create lane from PR branch
            </button>
          ) : null}
          {unmappedAffordance.linkableLanes.length > 0 ? (
            <>
              <select
                aria-label="Select lane to map"
                value={unmappedAffordance.selectedLaneId}
                onChange={(event) => unmappedAffordance.onSelectLane(event.target.value)}
              >
                <option value="">Map to lane…</option>
                {unmappedAffordance.linkableLanes.map((lane) => (
                  <option key={lane.id} value={lane.id}>{lane.name}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!unmappedAffordance.selectedLaneId || unmappedAffordance.linkBusy}
                onClick={unmappedAffordance.onLink}
              >
                Map
              </button>
            </>
          ) : null}
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
        onSelectPr={onSelectPr}
        onRefreshAll={onRefreshAll}
      />
    </MemoryRouter>,
  );
  return { onSelectPr, onRefreshAll };
}
