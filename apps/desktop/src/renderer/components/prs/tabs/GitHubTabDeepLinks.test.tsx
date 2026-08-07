// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPrSnapshot, LaneSummary } from "../../../../shared/types";
import type { PrRouteSelectionTarget } from "../prsRouteState";

vi.mock("react-resizable-panels", async () => {
  const harness = await import("./GitHubTab.testHarness");
  return {
    Group: harness.MockPanelGroup,
    Panel: harness.MockPanel,
    Separator: harness.MockSeparator,
  };
});

vi.mock("../state/PrsContext", async () => {
  const { mockUsePrs } = await import("./GitHubTab.testHarness");
  return { usePrs: () => mockUsePrs() };
});

vi.mock("../detail/PrDetailPane", async () => {
  const { MockPrDetailPane } = await import("./GitHubTab.testHarness");
  return { PrDetailPane: MockPrDetailPane };
});

import { GitHubTab } from "./GitHubTab";
import {
  cleanupGitHubTabTest,
  mockUsePrs,
  renderGitHubTab,
  setupGitHubTabTest,
} from "./GitHubTab.testHarness";
import {
  createDeferred,
  makeGitHubPr,
  makePrsContext,
  snapshot,
} from "./GitHubTab.testFixtures";

describe("GitHubTab explicit coordinate targets", () => {
  beforeEach(() => {
    setupGitHubTabTest();
  });

  afterEach(() => {
    cleanupGitHubTabTest();
  });

  function renderTab(overrides: Partial<{
    selectedPrId: string | null;
    selectedPrTarget: PrRouteSelectionTarget | null;
    onSelectPr: ReturnType<typeof vi.fn>;
    onRefreshAll: ReturnType<typeof vi.fn>;
    lanes: LaneSummary[];
  }> = {}) {
    return renderGitHubTab(GitHubTab, overrides);
  }

  it("renders a coordinate deep link before the GitHub snapshot arrives", async () => {
    const user = userEvent.setup();
    const deferredSnapshot = createDeferred<GitHubPrSnapshot>();
    vi.mocked(window.ade.prs.getGitHubSnapshot).mockReturnValueOnce(deferredSnapshot.promise);

    renderTab({
      selectedPrId: "pr-merged",
      selectedPrTarget: {
        prId: null,
        prNumber: 200,
        repoOwner: "ade-dev",
        repoName: "ade",
      },
    });

    expect(screen.getByTestId("pr-detail-pane").textContent).toContain("gh:ade-dev/ade#200");
    await act(async () => {
      deferredSnapshot.resolve(snapshot);
      await deferredSnapshot.promise;
    });

    await user.click(screen.getByRole("button", { name: /^merged/i }));
    expect(screen.queryByRole("button", { name: /Show in/i })).toBeNull();
  });

  it("does not auto-select the first row after clearing an unresolved coordinate target", async () => {
    const user = userEvent.setup();
    const onSelectPr = vi.fn();
    const target: PrRouteSelectionTarget = {
      prId: null,
      prNumber: 200,
      repoOwner: "ade-dev",
      repoName: "ade",
    };
    function Harness() {
      const [selection, setSelection] = React.useState<{
        id: string | null;
        target: PrRouteSelectionTarget | null;
      }>({ id: null, target });
      return (
        <MemoryRouter>
          <GitHubTab
            lanes={[]}
            mergeMethod="squash"
            selectedPrId={selection.id}
            selectedPrTarget={selection.target}
            onSelectPr={(id, nextTarget) => {
              onSelectPr(id, nextTarget ?? null);
              setSelection({ id, target: nextTarget ?? null });
            }}
            onRefreshAll={vi.fn().mockResolvedValue(undefined)}
          />
        </MemoryRouter>
      );
    }

    render(<Harness />);
    expect((await screen.findByTestId("pr-detail-pane")).textContent).toContain("gh:ade-dev/ade#200");

    await user.click(screen.getByRole("button", { name: /^merged/i }));

    await waitFor(() => expect(onSelectPr).toHaveBeenLastCalledWith(null, null));
    expect(screen.queryByTestId("pr-detail-pane")).toBeNull();
  });

  it("widens history for an unresolved closed coordinate target without blocking its shell", async () => {
    const deferredHistory = createDeferred<GitHubPrSnapshot>();
    const openOnlySnapshot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [makeGitHubPr()],
    };
    vi.mocked(window.ade.prs.getGitHubSnapshot)
      .mockResolvedValueOnce(openOnlySnapshot)
      .mockReturnValueOnce(deferredHistory.promise);

    renderTab({
      selectedPrId: null,
      selectedPrTarget: {
        prId: null,
        prNumber: 200,
        repoOwner: "ade-dev",
        repoName: "ade",
      },
    });

    expect(screen.getByTestId("pr-detail-pane").textContent).toContain("gh:ade-dev/ade#200");
    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({
        force: false,
        includeExternalClosed: true,
        historyPageLimit: 2,
      });
    });
    await act(async () => {
      deferredHistory.resolve({
        ...snapshot,
        repoPullRequests: [makeGitHubPr({
          id: "repo-closed-target",
          githubPrNumber: 200,
          state: "merged",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
        })],
      });
      await deferredHistory.promise;
    });
  });

  it("uses a local coordinate match when the snapshot link id is foreign", async () => {
    const user = userEvent.setup();
    const targetSnapshot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [makeGitHubPr({ linkedPrId: "foreign-machine-pr" })],
    };
    vi.mocked(window.ade.prs.getGitHubSnapshot).mockResolvedValue(targetSnapshot);
    mockUsePrs.mockReturnValue(makePrsContext([{
      id: "local-pr",
      githubPrNumber: 101,
      repoOwner: "ade-dev",
      repoName: "ade",
      state: "open",
    }]));

    renderTab({
      selectedPrId: null,
      selectedPrTarget: {
        prId: "foreign-machine-pr",
        prNumber: 101,
        repoOwner: "ade-dev",
        repoName: "ade",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("local-pr");
      expect(screen.getByTestId("pr-detail-pane").getAttribute("data-unmapped")).toBe("false");
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Unmap from lane" }));
    expect(window.ade.prs.delete).toHaveBeenCalledWith({
      prId: "local-pr",
      closeOnGitHub: false,
      archiveLane: false,
    });
    confirm.mockRestore();
  });

  it("reconciles local PR state when snapshot repository casing differs", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.getGitHubSnapshot).mockResolvedValue({
      ...snapshot,
      repoPullRequests: [makeGitHubPr({
        repoOwner: "ADE-DEV",
        repoName: "ADE",
        linkedPrId: null,
        linkedLaneId: null,
        linkedLaneName: null,
        title: "Cached open title",
        state: "open",
      })],
      externalPullRequests: [],
    });
    mockUsePrs.mockReturnValue(makePrsContext([{
      id: "local-pr",
      githubPrNumber: 101,
      repoOwner: "ade-dev",
      repoName: "ade",
      title: "Local merged title",
      state: "merged",
      updatedAt: "2026-03-13T12:30:00.000Z",
    }]));

    renderTab();
    await user.click(await screen.findByRole("button", { name: /^merged/i }));

    await waitFor(() => {
      expect(screen.getByText("Local merged title")).not.toBeNull();
    });
    expect(screen.queryByText("Cached open title")).toBeNull();
    expect(screen.getByTestId("pr-detail-pane").getAttribute("data-unmapped")).toBe("false");
  });

  it("resolves a coordinate deep link when the ADE row is not local", async () => {
    const targetSnapshot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unmapped",
          githubPrNumber: 200,
          title: "Unmapped target",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
        }),
        makeGitHubPr(),
      ],
    };
    vi.mocked(window.ade.prs.getGitHubSnapshot).mockResolvedValue(targetSnapshot);
    mockUsePrs.mockReturnValue(makePrsContext([]));

    renderTab({
      selectedPrId: null,
      selectedPrTarget: {
        prId: "pr-from-another-machine",
        prNumber: 200,
        repoOwner: "ade-dev",
        repoName: "ade",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("gh:ade-dev/ade#200");
    });
    // The unresolved explicit target must not be replaced by the first row.
    expect(screen.getByTestId("pr-detail-pane").textContent).not.toContain("gh:ade-dev/ade#101");
  });
});
