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
    ...overrides,
  };
}

describe("PrDetailMergeRail", () => {
  it("merges with the selected method", () => {
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

    fireEvent.click(screen.getByTestId("pr-merge-primary-button"));
    expect(onMerge).toHaveBeenCalledWith("squash", { bypassRules: false });
  });

  it("shows blocked reasons and passes bypassRules when enabled", () => {
    const onMerge = vi.fn();
    render(
      <PrDetailMergeRail
        pr={makePr()}
        status={makeStatus({ isMergeable: false, reviewStatus: "requested" })}
        checks={[]}
        reviews={[]}
        mergeMethod="merge"
        actionBusy={false}
        onMerge={onMerge}
      />,
    );

    expect(screen.getByTestId("pr-merge-blocked")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("pr-merge-primary-button"));
    expect(onMerge).toHaveBeenCalledWith("merge", { bypassRules: true });
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
