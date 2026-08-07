// @vitest-environment jsdom

import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateLaneFromPrBranchResult,
  CreateLaneFromPrBranchPreflightResult,
  GitHubPrSnapshot,
  PrSummary,
} from "../../../../shared/types";

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

import { GitHubTabPrRow } from "../shared/GitHubTabPrRow";
import { GitHubTab } from "./GitHubTab";
import {
  cleanupGitHubTabTest,
  renderGitHubTab,
  setupGitHubTabTest,
} from "./GitHubTab.testHarness";
import {
  createDeferred,
  makeGitHubPr,
  makeLaneSummary,
  makePreflightResult,
  snapshot,
} from "./GitHubTab.testFixtures";
import {
  buildProvisionalGithubPrItem,
  findSelectionTargetItem,
  itemMatchesSelectionTarget,
} from "./githubTabModel";

describe("GitHubTab rows and mapping", () => {
  beforeEach(() => {
    setupGitHubTabTest();
  });

  afterEach(() => {
    cleanupGitHubTabTest();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid provisional PR number %s",
    (prNumber) => {
      expect(buildProvisionalGithubPrItem({
        prNumber,
        repoOwner: "ade-dev",
        repoName: "ade",
      })).toBeNull();
    },
  );

  it("does not resolve an ambiguous number-only PR route across repositories", () => {
    const target = {
      prId: null,
      prNumber: 224,
      repoOwner: null,
      repoName: null,
    } as const;
    const repoItem = makeGitHubPr({ githubPrNumber: 224 });
    const secondRepoItem = makeGitHubPr({
      id: "repo-pr-224-other",
      repoOwner: "other-owner",
      repoName: "other-repo",
      githubPrNumber: 224,
    });

    expect(itemMatchesSelectionTarget(repoItem, target)).toBe(true);
    expect(itemMatchesSelectionTarget(secondRepoItem, target)).toBe(true);
    expect(findSelectionTargetItem([repoItem, secondRepoItem], target)).toBeNull();
  });

  function renderTab(overrides: Parameters<typeof renderGitHubTab>[1] = {}) {
    return renderGitHubTab(GitHubTab, overrides);
  }

  it("keeps the GitHub action outside the row button and does not expose a lane id as its label", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const item = makeGitHubPr({
      linkedLaneId: "lane-internal-uuid",
      linkedLaneName: null,
    });
    const { container } = render(
      <GitHubTabPrRow item={item} selected={false} linkedPr={null} onSelect={onSelect} />,
    );

    expect(screen.queryByText("lane-internal-uuid")).toBeNull();
    expect(screen.queryByText("unmapped")).toBeNull();

    const rowButton = container.querySelector<HTMLButtonElement>('[data-tour="prs.listRow"]');
    const githubButton = screen.getByRole("button", { name: "View on GitHub" });
    expect(rowButton).not.toBeNull();
    expect(rowButton?.contains(githubButton)).toBe(false);

    await user.click(rowButton!);
    expect(onSelect).toHaveBeenCalledWith(item);
    await user.click(githubButton);
    expect(window.ade.app.openExternal).toHaveBeenCalledWith(item.githubUrl);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // ADE-135: `not_run` means nothing verified the commit. The row must show the
  // hollow ring and say why, rather than rendering nothing (which is how three
  // bot successes came to read as "CI passed").
  it("shows a hollow ring carrying the rollup reason when no CI ran", () => {
    const item = makeGitHubPr({});
    const linkedPr = {
      checksStatus: "not_run",
      checksReason: "No CI has run on this commit — 3 apps reported, none of them CI.",
      reviewStatus: "approved",
    } as unknown as PrSummary;

    render(<GitHubTabPrRow item={item} selected={false} linkedPr={linkedPr} onSelect={vi.fn()} />);

    expect(screen.getByLabelText("No CI has run").title).toBe(
      "No CI has run on this commit — 3 apps reported, none of them CI.",
    );
  });

  it("falls back to generic copy when the rollup gave no reason", () => {
    const linkedPr = { checksStatus: "not_run", checksReason: null } as unknown as PrSummary;

    render(
      <GitHubTabPrRow item={makeGitHubPr({})} selected={false} linkedPr={linkedPr} onSelect={vi.fn()} />,
    );

    expect(screen.getByLabelText("No CI has run").title).toBe("No CI has run on this commit.");
  });

  it("shows a running CI indicator for PR cards with pending checks", async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getAllByLabelText("CI running").length).toBeGreaterThan(0);
    });
  });

  it("shows linked and unmapped PRs together under the status tabs", async () => {
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        ...snapshot.repoPullRequests,
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Open PR")).not.toBeNull();
      expect(screen.getByText("Unlinked PR")).not.toBeNull();
    });
  });

  it("marks unlinked PRs as unmapped", async () => {
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        ...snapshot.repoPullRequests,
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Unlinked PR")).not.toBeNull();
    });
    expect(screen.getAllByText("unmapped").length).toBeGreaterThan(0);
  });

  it("does not mark unlinked PRs as unmapped in the merged bucket", async () => {
    const user = userEvent.setup();
    const snapshotWithMergedUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        ...snapshot.repoPullRequests,
        makeGitHubPr({
          id: "repo-merged-unlinked",
          githubPrNumber: 201,
          title: "Merged after lane deleted",
          state: "merged",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-12T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithMergedUnlinked);
    renderTab();

    await user.click(await screen.findByRole("button", { name: /merged/i }));
    await waitFor(() => {
      expect(screen.getByText("Merged after lane deleted")).not.toBeNull();
    });
    // Mapping is a live-work concept: on a merged PR the lane is gone and mapping one
    // would do nothing, so the badge must not appear.
    expect(screen.queryByText("unmapped")).toBeNull();
  });

  it("shows frozen lane provenance on a detached merged PR", async () => {
    const user = userEvent.setup();
    const snapshotWithDetached: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        ...snapshot.repoPullRequests,
        makeGitHubPr({
          id: "repo-detached",
          githubPrNumber: 202,
          title: "Shipped from a deleted lane",
          state: "merged",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-11T12:00:00.000Z",
          detached: {
            at: "2026-03-12T09:00:00.000Z",
            laneName: "auto-naming",
            laneColor: "#4ADE80",
            chats: 3,
            artifacts: 2,
            checkpoints: 5,
          },
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithDetached);
    renderTab();

    await user.click(await screen.findByRole("button", { name: /merged/i }));
    await waitFor(() => {
      expect(screen.getByText("Shipped from a deleted lane")).not.toBeNull();
    });
    expect(screen.getByText("was: auto-naming")).not.toBeNull();
    expect(screen.getByText("· 3 chats · 2 proof")).not.toBeNull();
    expect(screen.queryByText("unmapped")).toBeNull();
  });

  it("shows merge facts instead of CI and review signals on a merged row", async () => {
    const user = userEvent.setup();
    const snapshotWithMerged: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        ...snapshot.repoPullRequests,
        makeGitHubPr({
          id: "repo-merged-facts",
          githubPrNumber: 203,
          title: "Merged with facts",
          state: "merged",
          baseBranch: "main",
          mergedAt: "2026-03-12T10:00:00.000Z",
          mergedBy: { login: "arul", avatarUrl: null },
          mergeMethod: "squash",
          createdAt: "2026-03-10T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithMerged);
    renderTab();

    await user.click(await screen.findByRole("button", { name: /merged/i }));
    await waitFor(() => {
      expect(screen.getByText("Merged with facts")).not.toBeNull();
    });
    expect(screen.getByText("arul · squash · → main")).not.toBeNull();
  });

  it("renders bot badge when isBot is true", async () => {
    const snapshotWithBot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "bot-pr",
          githubPrNumber: 300,
          title: "Bot PR",
          author: "dependabot[bot]",
          isBot: true,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithBot);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("bot")).not.toBeNull();
    });
  });

  it("renders labels when present", async () => {
    const snapshotWithLabels: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "labeled-pr",
          githubPrNumber: 400,
          title: "Labeled PR",
          labels: [
            { name: "bug", color: "d73a4a", description: null },
            { name: "enhancement", color: "a2eeef", description: null },
          ],
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithLabels);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("bug")).not.toBeNull();
      expect(screen.getByText("enhancement")).not.toBeNull();
    });
  });

  it("renders comment count when greater than zero", async () => {
    const snapshotWithComments: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "commented-pr",
          githubPrNumber: 500,
          title: "Commented PR",
          commentCount: 42,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithComments);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("42")).not.toBeNull();
    });
  });

  it("sorts PRs by updatedAt descending", async () => {
    const snapshotOrdered: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "pr-old",
          githubPrNumber: 50,
          title: "Old PR",
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:10:00.000Z",
        }),
        makeGitHubPr({
          id: "pr-new",
          githubPrNumber: 150,
          title: "New PR",
          createdAt: "2026-03-13T08:00:00.000Z",
          updatedAt: "2026-03-13T12:30:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotOrdered);
    renderTab();

    await waitFor(() => {
      const buttons = screen.getAllByRole("button").filter((btn) =>
        btn.textContent?.includes("PR") && (btn.textContent?.includes("Old") || btn.textContent?.includes("New")),
      );
      expect(buttons.length).toBe(2);
      expect(buttons[0]!.textContent).toContain("New PR");
      expect(buttons[1]!.textContent).toContain("Old PR");
    });
  });

  it("requires confirmation before unmapping a GitHub PR from its lane", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderTab();

      await waitFor(() => {
        expect(screen.getByText("Open PR")).toBeTruthy();
      });
      await user.click(screen.getByRole("button", { name: /#101 Open PR/i }));
      await waitFor(() => {
        expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
      });
      await user.click(screen.getByRole("button", { name: /unmap from lane/i }));

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Unmap PR #101"));
      expect(window.ade.prs.delete).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("renders the full PR detail pane (with create/map affordance) for a selected unmapped PR", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          headBranch: "feature/no-lane",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    // No lane owns the PR head branch → the "Create lane from PR branch" action
    // is offered (and there is no matching lane to map to).
    renderTab({ lanes: [] });

    await user.click(await screen.findByText("Unlinked PR"));

    // The full detail pane renders (not the legacy read-only gate), keyed by a
    // stable synthetic id derived from the GitHub coordinates.
    const pane = await screen.findByTestId("pr-detail-pane");
    expect(pane.getAttribute("data-unmapped")).toBe("true");
    expect(pane.textContent).toContain("gh:ade-dev/ade#200");

    // The create/map affordance is present (no read-only gate).
    const affordance = within(pane).getByTestId("pr-unmapped-affordance");
    expect(within(affordance).getByRole("button", { name: /create lane from pr branch/i })).toBeTruthy();
  });

  it("maps an unmapped PR to a lane via the in-pane affordance", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          headBranch: "feature/lane-match",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    renderTab({
      lanes: [makeLaneSummary({ id: "lane-match", name: "Matching lane", branchRef: "refs/heads/feature/lane-match" })],
    });

    await user.click(await screen.findByText("Unlinked PR"));
    const pane = await screen.findByTestId("pr-detail-pane");
    const affordance = within(pane).getByTestId("pr-unmapped-affordance");

    await user.selectOptions(within(affordance).getByLabelText("Select lane to map"), "lane-match");
    await user.click(within(affordance).getByRole("button", { name: /^map$/i }));

    await waitFor(() => {
      expect(window.ade.prs.linkToLane).toHaveBeenCalledWith({
        laneId: "lane-match",
        prUrlOrNumber: "https://github.com/ade-dev/ade/pull/200",
      });
    });
  });

  it("opens a preflight dialog for an unmapped PR branch", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    renderTab();

    const trigger = await screen.findByRole("button", { name: /create lane from pr branch/i });
    await user.click(trigger);

    expect(window.ade.prs.preflightCreateLaneFromPrBranch).toHaveBeenCalledWith({
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: 200,
    });
    const dialog = await screen.findByRole("dialog", { name: /create lane from pr branch/i });
    const cancel = within(dialog).getByRole("button", { name: /cancel/i });
    const confirm = within(dialog).getByRole("button", { name: /create lane/i });
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    expect(within(dialog).getByText(/#200 Unlinked PR/)).toBeTruthy();
    expect(within(dialog).getAllByText("origin/feature/open").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Unlinked PR").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("main").length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /create lane from pr branch/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps focus in the dialog while creation is busy and restores an action after failure", async () => {
    const user = userEvent.setup();
    const createResult = createDeferred<CreateLaneFromPrBranchResult>();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [makeGitHubPr({
        id: "repo-unlinked",
        githubPrNumber: 200,
        title: "Unlinked PR",
        linkedPrId: null,
        linkedLaneId: null,
        linkedLaneName: null,
        adeKind: null,
      })],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>)
      .mockResolvedValue(snapshotWithUnlinked);
    (window.ade.prs.createLaneFromPrBranch as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(createResult.promise);
    renderTab();

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));
    const dialog = await screen.findByRole("dialog", { name: /create lane from pr branch/i });
    await user.click(within(dialog).getByRole("button", { name: /^create lane$/i }));

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: /create lane from pr branch/i })).toBe(dialog);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => {
      createResult.reject(new Error("creation failed"));
      await Promise.resolve();
    });
    expect(await within(dialog).findByText("creation failed")).toBeTruthy();
    await user.tab();
    const activeControl = document.activeElement;
    expect(dialog.contains(activeControl)).toBe(true);
    expect(activeControl).toBeInstanceOf(HTMLButtonElement);
    expect((activeControl as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores stale create-lane preflight results from a previous PR", async () => {
    const user = userEvent.setup();
    const firstPreflight = createDeferred<CreateLaneFromPrBranchPreflightResult>();
    const secondPreflight = createDeferred<CreateLaneFromPrBranchPreflightResult>();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked-first",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "First PR",
          headBranch: "feature/first",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:10:00.000Z",
        }),
        makeGitHubPr({
          id: "repo-unlinked-second",
          githubPrNumber: 201,
          githubUrl: "https://github.com/ade-dev/ade/pull/201",
          title: "Second PR",
          headBranch: "feature/second",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    (window.ade.prs.preflightCreateLaneFromPrBranch as ReturnType<typeof vi.fn>)
      .mockImplementation((args: { githubPrNumber: number }) =>
        args.githubPrNumber === 200 ? firstPreflight.promise : secondPreflight.promise);
    renderTab();

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));
    expect(window.ade.prs.preflightCreateLaneFromPrBranch).toHaveBeenCalledWith({
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: 200,
    });
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await user.click(await screen.findByText("Second PR"));
    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));
    expect(window.ade.prs.preflightCreateLaneFromPrBranch).toHaveBeenCalledWith({
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: 201,
    });

    await act(async () => {
      firstPreflight.resolve(makePreflightResult({
        githubPrNumber: 200,
        title: "First PR",
        headBranch: "feature/first",
        remoteBranch: "origin/feature/first",
      }));
      await firstPreflight.promise;
    });
    expect(screen.queryByText(/#200 First PR/)).toBeNull();
    expect(screen.getByText(/checking branch ownership/i)).toBeTruthy();

    await act(async () => {
      secondPreflight.resolve(makePreflightResult({
        githubPrNumber: 201,
        title: "Second PR",
        headBranch: "feature/second",
        remoteBranch: "origin/feature/second",
      }));
      await secondPreflight.promise;
    });

    expect(await screen.findByText(/#201 Second PR/)).toBeTruthy();
    expect(screen.queryByText(/#200 First PR/)).toBeNull();
    const secondDialog = await screen.findByRole("dialog", { name: /create lane from pr branch/i });
    expect(within(secondDialog).getAllByText("origin/feature/second").length).toBeGreaterThan(0);
  });

  it("shows blocking preflight conflicts before creating a lane", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    (window.ade.prs.preflightCreateLaneFromPrBranch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      preflight: {
        repoOwner: "ade-dev",
        repoName: "ade",
        githubPrNumber: 200,
        githubUrl: "https://github.com/ade-dev/ade/pull/200",
        title: "Unlinked PR",
        headBranch: "feature/open",
        headRepoOwner: "ade-dev",
        headRepoName: "ade",
        remoteBranch: "origin/feature/open",
        importBranchRef: "origin/feature/open",
        targetLaneName: "Unlinked PR",
        baseBranch: "main",
        canCreate: false,
        status: "blocked",
        blockingConflict: {
          code: "branch_owned",
          message: "Branch 'feature/open' is already owned by lane 'Existing lane'.",
          laneId: "lane-existing",
          laneName: "Existing lane",
        },
        blockingConflicts: [],
      },
      lane: null,
      pr: null,
    });
    renderTab();

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));

    expect(await screen.findByText(/already owned by lane 'Existing lane'/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^create lane$/i })).toHaveProperty("disabled", true);
    expect(window.ade.prs.createLaneFromPrBranch).not.toHaveBeenCalled();
  });

  it("does not let an archived branch match hide the create-lane action", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    (window.ade.prs.preflightCreateLaneFromPrBranch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      preflight: {
        repoOwner: "ade-dev",
        repoName: "ade",
        githubPrNumber: 200,
        githubUrl: "https://github.com/ade-dev/ade/pull/200",
        title: "Unlinked PR",
        headBranch: "feature/open",
        headRepoOwner: "ade-dev",
        headRepoName: "ade",
        remoteBranch: "origin/feature/open",
        importBranchRef: "origin/feature/open",
        targetLaneName: "Unlinked PR",
        baseBranch: "main",
        canCreate: false,
        status: "blocked",
        blockingConflict: {
          code: "branch_owned",
          message: "Branch 'feature/open' is already owned by archived lane 'Archived lane'.",
          laneId: "lane-archived",
          laneName: "Archived lane",
        },
        blockingConflicts: [],
      },
      lane: null,
      pr: null,
    });

    renderTab({
      lanes: [
        makeLaneSummary({
          id: "lane-archived",
          name: "Archived lane",
          branchRef: "refs/heads/feature/open",
          archivedAt: "2026-03-12T12:00:00.000Z",
        }),
      ],
    });

    expect(await screen.findByRole("button", { name: /create lane from pr branch/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Archived lane" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /create lane from pr branch/i }));

    expect(await screen.findByText(/already owned by archived lane 'Archived lane'/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^create lane$/i })).toHaveProperty("disabled", true);
  });

  it("creates a lane from an unmapped PR branch, refreshes lanes, and selects the mapped PR", async () => {
    const user = userEvent.setup();
    const onSelectPr = vi.fn();
    const onRefreshAll = vi.fn().mockResolvedValue(undefined);
    const forcedSnapshot = createDeferred<GitHubPrSnapshot>();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
      externalPullRequests: [],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(snapshotWithUnlinked)
      .mockReturnValueOnce(forcedSnapshot.promise);
    renderTab({ onSelectPr, onRefreshAll });

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));
    await user.click(await screen.findByRole("button", { name: /^create lane$/i }));

    await waitFor(() => {
      expect(window.ade.prs.createLaneFromPrBranch).toHaveBeenCalledWith({
        repoOwner: "ade-dev",
        repoName: "ade",
        githubPrNumber: 200,
      });
    });
    await waitFor(() => {
      expect(onSelectPr).toHaveBeenLastCalledWith("pr-created", {
        prId: "pr-created",
        prNumber: 200,
        repoOwner: "ade-dev",
        repoName: "ade",
      });
    });
    expect(onRefreshAll).toHaveBeenCalledWith({ prId: "pr-created" });
    expect(window.ade.lanes.list).toHaveBeenCalledWith({
      includeArchived: false,
      includeStatus: false,
    });
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: true });
    await act(async () => {
      forcedSnapshot.resolve(snapshotWithUnlinked);
      await forcedSnapshot.promise;
    });
  });
});
