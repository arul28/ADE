// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { PrWithConflicts } from "../../../../shared/types/prs";

vi.mock("./PrRequestAiReviewDialog", () => ({
  PrRequestAiReviewDialog: () => null,
}));
vi.mock("./PrReviewSubmitModal", () => ({
  PrReviewSubmitModal: () => null,
}));

import { PrDetailRightMetadataRail } from "./PrDetailRightMetadataRail";

afterEach(cleanup);

const pr = {
  id: "pr-1",
  projectId: "proj-1",
  laneId: "lane-1",
  repoOwner: "acme",
  repoName: "ade",
  state: "open",
} as unknown as PrWithConflicts;

function renderRail() {
  return render(
    <PrDetailRightMetadataRail
      pr={pr}
      lane={null}
      detail={null}
      status={null}
      reviews={[]}
      checks={[{ name: "build", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null }]}
      actionRuns={[]}
      showReviewerEditor={false}
      setShowReviewerEditor={() => {}}
      reviewerInput=""
      setReviewerInput={() => {}}
      showLabelEditor={false}
      setShowLabelEditor={() => {}}
      labelInput=""
      setLabelInput={() => {}}
      onRequestReviewers={() => {}}
      onSetLabels={() => {}}
      actionBusy={false}
      onSubmitReview={() => {}}
    />,
  );
}

describe("PrDetailRightMetadataRail — can-this-land column", () => {
  it("folds the review actions into the Reviewers section instead of a standalone pane", () => {
    renderRail();
    const actions = screen.getByTestId("pr-detail-metadata-actions");
    // The two buttons used to be the LAST card in the rail — i.e. the card that
    // absorbed all the column's slack and produced the dead air.
    expect(screen.getByTestId("pr-metadata-section-people").contains(actions)).toBe(true);
    expect(actions.textContent).toContain("ADE review");
    expect(actions.textContent).toContain("Submit review");
  });

  it("makes checks the growth target and no longer carries the files pane", () => {
    renderRail();
    const rail = screen.getByTestId("pr-detail-right-metadata-rail");
    const checks = screen.getByTestId("pr-checks-card");
    expect(checks.className).toContain("flex-1");
    // Checks are last: the merge rail is pinned below by the parent column.
    expect(rail.lastElementChild).toBe(checks);
    // Files moved to the left "what changed" rail.
    expect(screen.queryByTestId("pr-files-changed-card")).toBeNull();
  });
});
