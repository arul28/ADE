import { describe, expect, it } from "vitest";
import {
  buildManualLandWarnings,
  buildQueueGuidance,
  getQueueWorkflowBucket,
} from "./queueWorkflowModel";
import type { QueueGroupLike, QueueMemberLike } from "./queueWorkflowModel";
import type { PrStatus, RebaseNeed } from "../../../../shared/types/prs";

function makeMember(overrides: Partial<QueueMemberLike> = {}): QueueMemberLike {
  return {
    prId: overrides.prId ?? "pr-1",
    laneId: overrides.laneId ?? "lane-1",
    laneName: overrides.laneName ?? "Lane 1",
    position: overrides.position ?? 0,
    pr: overrides.pr ?? {
      state: "closed",
      checksStatus: "none",
      reviewStatus: "none",
    },
  };
}

function makeGroup(overrides: Partial<QueueGroupLike> = {}): QueueGroupLike {
  return {
    landingState: overrides.landingState ?? null,
    members: overrides.members ?? [],
  };
}

describe("queueWorkflowModel", () => {
  it("buckets active groups by open members and completed landings into history", () => {
    expect(
      getQueueWorkflowBucket(
        makeGroup({
          members: [makeMember({ pr: { state: "open", checksStatus: "passing", reviewStatus: "approved" } })],
        }),
      ),
    ).toBe("active");

    expect(
      getQueueWorkflowBucket(
        makeGroup({
          landingState: { state: "completed" } as QueueGroupLike["landingState"],
          members: [makeMember()],
        }),
      ),
    ).toBe("history");
  });

  it("surfaces the right manual landing warnings from status or member summary", () => {
    const warnings = buildManualLandWarnings({
      status: {
        prId: "pr-1",
        state: "open",
        checksStatus: "failing",
        reviewStatus: "requested",
        isMergeable: false,
        mergeConflicts: true,
        behindBaseBy: 3,
      } satisfies PrStatus,
      memberSummary: {
        state: "open",
        checksStatus: "pending",
        reviewStatus: "changes_requested",
      } satisfies QueueMemberLike["pr"],
    });

    expect(warnings).toEqual([
      "CI is failing for the current PR.",
      "Review is still pending on the current PR.",
      "GitHub reports merge conflicts on the current PR.",
    ]);

    expect(
      buildManualLandWarnings({
        status: {
          prId: "pr-2",
          state: "open",
          checksStatus: "none",
          reviewStatus: "none",
          isMergeable: false,
          mergeConflicts: false,
          behindBaseBy: 0,
        } satisfies PrStatus,
        memberSummary: null,
      }),
    ).toEqual(["GitHub has not marked the current PR as mergeable yet. Manual land can still succeed if GitHub allows a bypass merge."]);
  });

  it("advises the operator to rebase the next lane after a successful land", () => {
    const nextRebaseNeed: RebaseNeed = {
      laneId: "lane-next",
      laneName: "Next Lane",
      kind: "lane_base",
      baseBranch: "main",
      behindBy: 2,
      conflictPredicted: false,
      conflictingFiles: [],
      prId: "pr-next",
      groupContext: "group-1",
      dismissedAt: null,
      deferredUntil: null,
    };

    expect(
      buildQueueGuidance({
        group: makeGroup({
          members: [makeMember({ laneName: "Current Lane" })],
        }),
        currentStatus: null,
        landWarnings: [],
        lastLandSucceeded: true,
        currentRebaseNeed: nextRebaseNeed,
      }),
    ).toEqual({
      tone: "warning",
      title: "Refresh the next lane",
      description: "Next Lane is 2 commits behind main. Rebase it to refresh CI and PR state before landing again.",
      primaryAction: "rebase",
      primaryLabel: "Open rebase for Next Lane",
      secondaryAction: "open_pr",
      secondaryLabel: "Open current PR view",
      nextRebaseLaneId: "lane-next",
    });
  });

  it("warns when manual queue landing is required and otherwise falls back to ready guidance", () => {
    expect(
      buildQueueGuidance({
        group: makeGroup({
          landingState: { state: "landing", waitReason: "manual" } as QueueGroupLike["landingState"],
          members: [makeMember({ laneName: "Manual Lane" })],
        }),
        currentStatus: null,
        landWarnings: [],
        lastLandSucceeded: false,
        currentRebaseNeed: null,
      }),
    ).toEqual({
      tone: "blocked",
      title: "Queue blocked on operator action",
      description: "Queue automation is waiting for a manual decision.",
      primaryAction: "open_pr",
      primaryLabel: "Open current PR view",
      secondaryAction: "none",
      secondaryLabel: null,
      nextRebaseLaneId: null,
    });

    expect(
      buildQueueGuidance({
        group: makeGroup({
          members: [makeMember({ laneName: "Ready Lane", pr: { state: "open", checksStatus: "passing", reviewStatus: "approved" } })],
        }),
        currentStatus: null,
        landWarnings: [],
        lastLandSucceeded: false,
        currentRebaseNeed: null,
      }),
    ).toEqual({
      tone: "ready",
      title: "Ready to land the current PR",
      description: "Current queue item: Ready Lane. Review the PR state, then merge when you're ready.",
      primaryAction: "land",
      primaryLabel: "Land current PR",
      secondaryAction: "open_pr",
      secondaryLabel: "Open current PR view",
      nextRebaseLaneId: null,
    });
  });
});
