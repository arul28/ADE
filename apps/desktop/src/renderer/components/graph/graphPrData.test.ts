import { describe, expect, it, vi } from "vitest";
import { buildGraphPrOverlay } from "./graphPrData";
import { getPrEdgeColor } from "../prs/shared/prVisuals";

describe("buildGraphPrOverlay", () => {
  it("derives review, comment, and CI counts from detailed PR data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00Z"));

    const overlay = buildGraphPrOverlay({
      pr: {
        id: "pr-1",
        laneId: "lane-1",
        projectId: "proj-1",
        repoOwner: "acme",
        repoName: "ade",
        githubPrNumber: 42,
        githubUrl: "https://github.com/acme/ade/pull/42",
        githubNodeId: "node-42",
        title: "Ship graph PR integration",
        state: "open",
        baseBranch: "main",
        headBranch: "feature/graph-prs",
        checksStatus: "pending",
        reviewStatus: "requested",
        additions: 120,
        deletions: 18,
        lastSyncedAt: "2026-03-08T10:30:00Z",
        createdAt: "2026-03-07T08:00:00Z",
        updatedAt: "2026-03-08T10:30:00Z"
      },
      baseLaneId: "lane-main",
      mergeInProgress: false,
      detail: {
        status: {
          prId: "pr-1",
          state: "open",
          checksStatus: "pending",
          reviewStatus: "requested",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 2
        },
        checks: [
          {
            name: "unit",
            status: "in_progress",
            conclusion: null,
            detailsUrl: null,
            startedAt: "2026-03-08T11:30:00Z",
            completedAt: null
          }
        ],
        reviews: [
          {
            reviewer: "alex",
            state: "approved",
            body: null,
            submittedAt: "2026-03-08T09:00:00Z"
          },
          {
            reviewer: "sam",
            state: "changes_requested",
            body: "Needs one more test",
            submittedAt: "2026-03-08T11:45:00Z"
          }
        ],
        comments: [
          {
            id: "c-1",
            author: "alex",
            body: "Looks good overall",
            source: "issue",
            url: null,
            path: null,
            line: null,
            createdAt: "2026-03-08T11:50:00Z",
            updatedAt: "2026-03-08T11:50:00Z"
          }
        ]
      }
    });

    expect(overlay.reviewCount).toBe(2);
    expect(overlay.approvedCount).toBe(1);
    expect(overlay.changeRequestCount).toBe(1);
    expect(overlay.commentCount).toBe(1);
    expect(overlay.pendingCheckCount).toBe(1);
    expect(overlay.activityState).toBe("active");
    expect(overlay.behindBaseBy).toBe(2);

    vi.useRealTimers();
  });

  it("prefers live detail status over stale summary fields", () => {
    const overlay = buildGraphPrOverlay({
      pr: {
        id: "pr-2",
        laneId: "lane-2",
        projectId: "proj-1",
        repoOwner: "acme",
        repoName: "ade",
        githubPrNumber: 52,
        githubUrl: "https://github.com/acme/ade/pull/52",
        githubNodeId: "node-52",
        title: "Refresh summary status",
        state: "open",
        baseBranch: "main",
        headBranch: "feature/live-status",
        checksStatus: "pending",
        reviewStatus: "requested",
        additions: 12,
        deletions: 4,
        lastSyncedAt: "2026-03-08T10:30:00Z",
        createdAt: "2026-03-07T08:00:00Z",
        updatedAt: "2026-03-08T10:30:00Z"
      },
      baseLaneId: "lane-main",
      mergeInProgress: false,
      detail: {
        status: {
          prId: "pr-2",
          state: "merged",
          checksStatus: "passing",
          reviewStatus: "approved",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0
        },
        checks: [],
        reviews: [],
        comments: []
      }
    });

    expect(overlay.state).toBe("merged");
    expect(overlay.checksStatus).toBe("passing");
    expect(overlay.reviewStatus).toBe("approved");
    expect(overlay.activityState).toBe("idle");
  });
});

describe("getPrEdgeColor", () => {
  it("prioritizes requested graph colors by PR workflow state", () => {
    expect(getPrEdgeColor({ state: "draft", checksStatus: "none", reviewStatus: "none" })).toBe("#A78BFA");
    expect(getPrEdgeColor({ state: "open", checksStatus: "pending", reviewStatus: "approved", ciRunning: true })).toBe("#3B82F6");
    expect(getPrEdgeColor({ state: "open", checksStatus: "failing", reviewStatus: "changes_requested" })).toBe("#EF4444");
    expect(getPrEdgeColor({ state: "merged", checksStatus: "passing", reviewStatus: "approved" })).toBe("#22C55E");
    expect(getPrEdgeColor({ state: "open", checksStatus: "none", reviewStatus: "requested" })).toBe("#F59E0B");
  });
});
