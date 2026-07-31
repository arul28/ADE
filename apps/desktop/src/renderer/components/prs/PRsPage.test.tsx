// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PrSummary } from "../../../shared/types";

// Mock the PRs context hook so we can drive { error, prs, loading } directly.
const usePrsMock = vi.fn();
vi.mock("./state/PrsContext", () => ({
  PrsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePrs: () => usePrsMock(),
}));

// Stub the heavy tab subtrees: we only care about the page-level render branch.
vi.mock("./tabs/GitHubTab", () => ({
  GitHubTab: () => <div data-testid="github-tab" />,
}));
vi.mock("./tabs/WorkflowsTab", () => ({
  WorkflowsTab: () => <div data-testid="workflows-tab" />,
}));
vi.mock("./CreatePrModal", () => ({
  CreatePrModal: () => null,
}));

// Router + store + dialog bus stubs.
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/prs", search: "" }),
}));
vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: any) => unknown) =>
    selector({
      project: null,
      projectBinding: null,
      refreshLanes: vi.fn(async () => undefined),
    }),
  selectActiveProjectRoot: () => null,
}));
vi.mock("../../lib/useDialogBus", () => ({
  useDialogBus: () => {},
}));

import { PRsPage } from "./PRsPage";

function makePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    title: "Cached PR",
    githubPrNumber: 42,
  } as unknown as PrSummary;
}

function baseValue(overrides: Record<string, unknown> = {}) {
  return {
    activeTab: "normal",
    setActiveTab: vi.fn(),
    prs: [],
    lanes: [],
    mergeMethod: "merge",
    selectedPrId: null,
    setSelectedPrId: vi.fn(),
    rebaseNeeds: [],
    selectedRebaseItemId: null,
    setSelectedRebaseItemId: vi.fn(),
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  usePrsMock.mockReset();
});

describe("PRsPage error gating", () => {
  it("keeps cached PRs visible when an error coexists with data", () => {
    usePrsMock.mockReturnValue(
      baseValue({ error: "boom", prs: [makePr()], loading: false }),
    );

    render(<PRsPage />);

    // Normal render: header + GitHub tab present, no dead-end EmptyState.
    expect(screen.getByText("Pull Requests")).toBeTruthy();
    expect(screen.getByTestId("github-tab")).toBeTruthy();
    expect(screen.queryByText(/Failed to load PRs/i)).toBeNull();
  });

  it("shows a dead-end with a working Retry when there is no cached data", () => {
    const refresh = vi.fn(async () => undefined);
    usePrsMock.mockReturnValue(
      baseValue({ error: "boom", prs: [], loading: false, refresh }),
    );

    render(<PRsPage />);

    expect(screen.getByText(/Failed to load PRs: boom/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: /Retry/i });
    expect(retry).toBeTruthy();

    fireEvent.click(retry);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
