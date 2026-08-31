// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PrDetail, PrWithConflicts } from "../../../../shared/types/prs";

vi.mock("./PrRequestAiReviewDialog", () => ({
  PrRequestAiReviewDialog: () => null,
}));
vi.mock("./PrReviewSubmitModal", () => ({
  PrReviewSubmitModal: () => null,
}));

import { PrDetailRightMetadataRail } from "./PrDetailRightMetadataRail";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../../test/builtinSurfaces";

afterEach(() => {
  cleanup();
  resetBuiltinSurfacePlugins();
});

const pr = {
  id: "pr-1",
  projectId: "proj-1",
  laneId: "lane-1",
  repoOwner: "acme",
  repoName: "ade",
  state: "open",
} as unknown as PrWithConflicts;

function section(title: string): HTMLElement {
  const found = screen.getByText(title).closest("section");
  if (!found) throw new Error(`no section for ${title}`);
  return found as HTMLElement;
}

function renderRail(
  detail: PrDetail | null = null,
  onOpenAsLane?: () => void,
  prOverride: PrWithConflicts = pr,
) {
  return render(
    <PrDetailRightMetadataRail
      pr={prOverride}
      lane={null}
      detail={detail}
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
      onOpenAsLane={onOpenAsLane}
    />,
  );
}

describe("PrDetailRightMetadataRail — can-this-land column", () => {

  // ADE review diffs a working tree, so a PR with no lane genuinely cannot run
  // it. The button used to go dead and say nothing, which read as "broken" — it
  // now offers the checkout that unblocks it. Without a way to make that lane it
  // falls back to disabled, rather than promising something it cannot do.
  it("offers the lane checkout instead of a dead ADE review button", () => {
    // This is about the LANE gate, so it describes a machine that has the Review
    // plugin — without it the button is gone for a different reason entirely.
    seedBuiltinSurfacePlugins(["review"]);
    const onOpenAsLane = vi.fn();
    renderRail(null, onOpenAsLane);
    const button = screen.getByRole("button", { name: /open as lane to review/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onOpenAsLane).toHaveBeenCalledTimes(1);
  });

  it("falls back to a disabled ADE review button when no lane can be created", () => {
    seedBuiltinSurfacePlugins(["review"]);
    renderRail(null);
    const button = screen.getByRole("button", { name: /ADE review/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /open as lane to review/i })).toBeNull();
  });
  it("folds the review actions into the Reviewers section instead of a standalone pane", () => {
    // A machine that HAS the Review plugin: the ADE review button is an entry
    // point to the Review tab, so it only exists where that tab does.
    seedBuiltinSurfacePlugins(["review"]);
    renderRail();
    const actions = screen.getByTestId("pr-detail-metadata-actions");
    // The two buttons used to be the LAST card in the rail — i.e. the card that
    // absorbed all the column's slack and produced the dead air.
    expect(screen.getByTestId("pr-metadata-section-people").contains(actions)).toBe(true);
    expect(actions.textContent).toContain("ADE review");
    expect(actions.textContent).toContain("Submit review");
  });

  // An ADE review reports into the Review tab. On a machine without the plugin
  // that owns that tab there is nowhere for the findings to land, so the button
  // goes with it — while Submit review, which is GitHub's own, stays.
  it("drops the ADE review button when the Review plugin is not installed", () => {
    renderRail();
    const actions = screen.getByTestId("pr-detail-metadata-actions");
    expect(actions.textContent).not.toContain("ADE review");
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

  // Three empty people sections used to cost a header line, a body gap and a
  // "None yet" line each — ~65px apiece — to say nothing at all.
  it("collapses an empty people section onto its header line, action intact", () => {
    renderRail();
    const reviewers = section("Reviewers");
    const header = reviewers.querySelector("header");
    // "None" rides in the header row. If it were still a body line, the header
    // would not contain it.
    expect(header?.textContent).toContain("None");
    expect(reviewers.textContent).not.toContain("None yet");
    // The whole point of collapsing is that the action survives it.
    expect(header?.textContent).toContain("Request");
    expect(reviewers.dataset.empty).toBe("true");
  });

  // Requesting reviewers and setting labels are plain GitHub API calls that
  // resolve a synthetic `gh:` id. Gating them on a lane left a PR the user could
  // read, comment on and merge but not label.
  it("offers Request and Edit for a PR with no lane", () => {
    renderRail(null, undefined, { ...pr, laneId: null } as unknown as PrWithConflicts);
    expect(section("Reviewers").querySelector("header")?.textContent).toContain("Request");
    expect(section("Labels").querySelector("header")?.textContent).toContain("Edit");
  });

  it("collapses labels and assignees too, and spends no hairline between the three", () => {
    renderRail();
    for (const title of ["Labels", "Assignees"]) {
      const el = section(title);
      expect(el.querySelector("header")?.textContent).toContain("None");
      expect(el.dataset.empty).toBe("true");
      // `divided` is what pays the 18/18 rhythm; the people group is one group
      // and no longer buys rules between its members.
      expect(el.style.marginTop).toBe("");
      expect(el.style.paddingTop).toBe("");
    }
  });

  it("expands a section the moment it has something to list", () => {
    renderRail({
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: [{ login: "alice", avatarUrl: null }],
    } as unknown as PrDetail);
    const labels = section("Labels");
    expect(labels.dataset.empty).toBeUndefined();
    expect(labels.textContent).toContain("bug");
    expect(labels.querySelector("header")?.textContent).not.toContain("None");
    expect(section("Assignees").textContent).toContain("alice");
  });
});
