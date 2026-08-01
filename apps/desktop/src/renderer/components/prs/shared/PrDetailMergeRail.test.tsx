// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrDetailMergeRail } from "./PrDetailMergeRail";
import type { PrStatus, PrWithConflicts } from "../../../../shared/types/prs";

afterEach(cleanup);

function makePr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "acme",
    repoName: "repo",
    githubPrNumber: 42,
    githubUrl: "https://github.com/acme/repo/pull/42",
    githubNodeId: null,
    title: "Test PR",
    state: "open",
    baseBranch: "main",
    headBranch: "feature",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PrWithConflicts;
}

function makeStatus(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    prId: "pr-1",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
    mergeStateStatus: "clean",
    ...overrides,
  };
}

describe("PrDetailMergeRail", () => {
  it("opens the merge dialog and merges with the remembered method + commit fields", () => {
    const onMerge = vi.fn();
    render(
      <PrDetailMergeRail
        pr={makePr()}
        status={makeStatus()}
        checks={[]}
        reviews={[]}
        mergeMethod="squash"
        actionBusy={false}
        onMerge={onMerge}
      />,
    );

    // Rail shows the readiness checklist + a single "Merge…" button (no inline dropdown).
    expect(screen.getByTestId("pr-merge-checklist")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pr-merge-open-dialog-button"));

    // The portaled dialog hosts the actual merge button.
    fireEvent.click(screen.getByTestId("pr-merge-primary-button"));
    expect(onMerge).toHaveBeenCalledTimes(1);
    const [method, options] = onMerge.mock.calls[0]!;
    expect(method).toBe("squash");
    expect(options?.bypassRules).toBe(false);
    expect(options?.commitTitle).toBe("Test PR (#42)");
  });

  it("renders the blocked header when merge requirements are unmet", () => {
    render(
      <PrDetailMergeRail
        pr={makePr()}
        status={makeStatus({ isMergeable: false, mergeStateStatus: "blocked", reviewDecision: "review_required" })}
        checks={[]}
        reviews={[]}
        mergeMethod="merge"
        actionBusy={false}
        onMerge={() => {}}
      />,
    );

    expect(screen.getByTestId("pr-merge-blocked")).toBeTruthy();
  });

  it("offers the inline update-branch action when behind base", () => {
    const onUpdateBranch = vi.fn();
    render(
      <PrDetailMergeRail
        pr={makePr()}
        status={makeStatus({ mergeStateStatus: "behind", behindBaseBy: 3 })}
        checks={[]}
        reviews={[]}
        mergeMethod="squash"
        actionBusy={false}
        onMerge={() => {}}
        onUpdateBranch={onUpdateBranch}
      />,
    );

    fireEvent.click(screen.getByTestId("pr-merge-update-branch"));
    expect(onUpdateBranch).toHaveBeenCalledWith("merge");
  });

  it("shows merged banner and delete branch action", () => {
    const onDeleteBranch = vi.fn();
    render(
      <PrDetailMergeRail
        pr={makePr({ state: "merged" })}
        status={makeStatus({ state: "merged" })}
        checks={[]}
        reviews={[]}
        mergeMethod="squash"
        actionBusy={false}
        onMerge={() => {}}
        onDeleteBranch={onDeleteBranch}
      />,
    );

    // First click arms the destructive action without firing the callback.
    fireEvent.click(screen.getByRole("button", { name: /Delete branch/i }));
    expect(onDeleteBranch).not.toHaveBeenCalled();

    // Second click on the now-armed button actually deletes.
    fireEvent.click(screen.getByRole("button", { name: /Click again to confirm/i }));
    expect(onDeleteBranch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pr-merge-merged-banner")).toBeTruthy();
  });

  it("records how a merged PR shipped, including the lane it outlived", () => {
    render(
      <PrDetailMergeRail
        pr={makePr({
          state: "merged",
          createdAt: "2026-01-01T00:00:00.000Z",
          mergedAt: "2026-01-03T04:00:00.000Z",
          mergedBy: { login: "arul", avatarUrl: null },
          mergeMethod: "squash",
          commitCount: 12,
          changedFiles: 9,
          detached: {
            at: "2026-01-04T00:00:00.000Z",
            laneName: "auto-naming",
            laneColor: "#4ADE80",
            chats: 3,
            artifacts: 2,
            checkpoints: 5,
          },
        })}
        status={makeStatus({ state: "merged" })}
        checks={[]}
        reviews={[]}
        mergeMethod="squash"
        actionBusy={false}
        onMerge={() => {}}
      />,
    );

    const summary = screen.getByTestId("pr-shipped-summary");
    expect(summary.textContent).toContain("by arul · squash");
    expect(summary.textContent).toContain("12 commits · 9 files · open 2d 4h");
    // The lane is gone, but what happened in it is not.
    expect(summary.textContent).toContain("was: auto-naming · 3 chats · 2 proof");
  });

  it("omits shipped facts that were never recorded rather than showing blanks", () => {
    render(
      <PrDetailMergeRail
        pr={makePr({ state: "merged", mergedAt: null })}
        status={makeStatus({ state: "merged" })}
        checks={[]}
        reviews={[]}
        mergeMethod="squash"
        actionBusy={false}
        onMerge={() => {}}
      />,
    );

    // A PR merged before ADE recorded merge metadata still renders its banner.
    expect(screen.getByTestId("pr-merge-merged-banner")).toBeTruthy();
    expect(screen.queryByTestId("pr-shipped-summary")).toBeNull();
  });

  it("requires confirmation before closing an open PR", () => {
    const onClose = vi.fn();
    render(
      <PrDetailMergeRail
        pr={makePr({ state: "open" })}
        status={makeStatus()}
        checks={[]}
        reviews={[]}
        mergeMethod="squash"
        actionBusy={false}
        onMerge={() => {}}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Close pull request/i }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Click again to close PR/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
