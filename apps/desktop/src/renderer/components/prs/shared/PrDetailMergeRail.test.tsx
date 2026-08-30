// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrDetailMergeRail } from "./PrDetailMergeRail";
import { formatTimestampShort } from "./prFormatters";
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

    // How it merged rides with the outcome headline, not the fact list.
    expect(screen.getByTestId("pr-merge-merged-banner").textContent).toContain("squash merge");

    const summary = screen.getByTestId("pr-shipped-summary");
    // Attribution: who merged it, and when.
    expect(summary.textContent).toContain("arul");
    expect(summary.textContent).toContain(formatTimestampShort("2026-01-03T04:00:00.000Z"));
    // Figures: each fact keeps its own value + noun rather than a run-on line.
    expect(summary.textContent).toContain("12 commits");
    expect(summary.textContent).toContain("9 files");
    expect(summary.textContent).toContain("2d 4h open");
    // The lane is gone, but what happened in it is not — and it is marked as ADE's.
    const lane = screen.getByTestId("pr-shipped-lane");
    expect(lane.textContent).toContain("ADE lane");
    expect(lane.textContent).toContain("auto-naming");
    expect(lane.textContent).toContain("3 chats · 2 proof");
  });

  it("renders the merged branch pair as chips that keep the full name on hover", () => {
    render(
      <PrDetailMergeRail
        pr={makePr({
          state: "merged",
          headBranch: "ade/a-very-long-lane-branch-name-that-must-truncate-7f6566e2",
          baseBranch: "main",
          mergedAt: "2026-01-03T04:00:00.000Z",
        })}
        status={makeStatus({ state: "merged" })}
        checks={[]}
        reviews={[]}
        mergeMethod="squash"
        actionBusy={false}
        onMerge={() => {}}
      />,
    );

    // The rail is ~390px wide, so the head chip ellipsises rather than wrapping
    // the layout — the untruncated name stays reachable as the chip's title.
    const head = screen.getByTitle("ade/a-very-long-lane-branch-name-that-must-truncate-7f6566e2");
    expect(head.style.overflow).toBe("hidden");
    expect(screen.getByTitle("main")).toBeTruthy();
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

    // The rail's narrow "Close" button only opens the confirmation dialog.
    fireEvent.click(screen.getByTestId("pr-close-open-dialog-button"));
    expect(onClose).not.toHaveBeenCalled();

    // Confirming inside the portaled dialog is what actually closes the PR.
    fireEvent.click(screen.getByTestId("pr-close-confirm-button"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
