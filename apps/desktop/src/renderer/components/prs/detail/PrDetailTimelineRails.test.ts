import { describe, expect, it } from "vitest";
import type { PrActivityEvent, PrCommit, PrReview, PrWithConflicts } from "../../../../shared/types/prs";
import { parsePrsRouteState } from "../prsRouteState";
import {
  buildCommitRailCommits,
  buildTimelineEvents,
  buildTimelineVisibleEventSearch,
} from "./PrDetailTimelineRails";

describe("buildTimelineVisibleEventSearch", () => {
  it("preserves the selected detail tab when replacing the visible event", () => {
    const current = parsePrsRouteState({
      search: "?tab=normal&prId=pr-1&eventId=comment-old&detailTab=overview",
    });

    expect(buildTimelineVisibleEventSearch({
      current,
      prId: "pr-1",
      eventId: "comment-new",
    })).toBe("?tab=normal&prId=pr-1&eventId=comment-new&detailTab=overview");
  });
});

describe("buildTimelineEvents fold", () => {
  // The fold only reads pr.id / pr.createdAt / pr.baseBranch and (when non-null)
  // detail.*; a minimal pr stub keeps fixtures honest without faking the world.
  const pr = { id: "pr-1", createdAt: "2026-01-01T00:00:00Z", baseBranch: "main" } as unknown as PrWithConflicts;
  function foldArgs(over: Partial<Parameters<typeof buildTimelineEvents>[0]>): Parameters<typeof buildTimelineEvents>[0] {
    return {
      pr,
      detail: null,
      activity: [],
      reviews: [],
      reviewThreads: [],
      comments: [],
      checks: [],
      deployments: [],
      commits: [],
      ...over,
    };
  }
  const forcePush: PrActivityEvent = {
    id: "fp1",
    type: "force_push",
    author: "octocat",
    avatarUrl: null,
    body: null,
    timestamp: "2026-01-02T00:00:00Z",
    metadata: { beforeSha: "1111111aaaa", afterSha: "2222222bbbb" },
  };

  it("keys a force-push event on afterSha and matches the commit-rail entry (rail→event scroll)", () => {
    const events = buildTimelineEvents(foldArgs({ activity: [forcePush] }));
    const fp = events.find((e) => e.type === "commit_push" && e.forcePushed);
    expect(fp).toBeTruthy();
    expect(fp && fp.type === "commit_push" ? fp.sha : null).toBe("2222222bbbb");

    // The rail entry must derive the SAME sha, else selecting it can't resolve
    // the timeline event (the force-push "nothing highlights" bug).
    const rail = buildCommitRailCommits([forcePush], [], []);
    const railFp = rail.find((c) => c.forcePushed);
    expect(railFp?.sha).toBe(fp && fp.type === "commit_push" ? fp.sha : "MISMATCH");
  });

  it("suppresses a bodyless 'commented' review but keeps one with a summary body", () => {
    const reviews: PrReview[] = [
      { reviewer: "bot", reviewerAvatarUrl: null, state: "commented", body: "   ", submittedAt: "2026-01-03T00:00:00Z" },
      { reviewer: "human", reviewerAvatarUrl: null, state: "commented", body: "Real summary", submittedAt: "2026-01-03T01:00:00Z" },
      { reviewer: "approver", reviewerAvatarUrl: null, state: "approved", body: null, submittedAt: "2026-01-03T02:00:00Z" },
    ];
    const reviewEvents = buildTimelineEvents(foldArgs({ reviews })).filter((e) => e.type === "review");
    expect(reviewEvents.map((e) => e.author).sort()).toEqual(["approver", "human"]);
  });

  it("enriches a commit event's avatar from the matching commit snapshot by sha", () => {
    const commitAct: PrActivityEvent = {
      id: "c1",
      type: "commit",
      author: "dev",
      avatarUrl: null,
      body: null,
      timestamp: "2026-01-04T00:00:00Z",
      metadata: { sha: "abc1234", subject: "fix things" },
    };
    const commits: PrCommit[] = [
      {
        sha: "abc1234",
        shortSha: "abc1234",
        message: "fix things",
        author: { login: "dev", name: "Dev", email: null, avatarUrl: "https://avatars.example/dev.png" },
        committedDate: "2026-01-04T00:00:00Z",
      },
    ];
    const commit = buildTimelineEvents(foldArgs({ activity: [commitAct], commits })).find(
      (e) => e.type === "commit_push" && e.sha === "abc1234",
    );
    expect(commit && commit.type === "commit_push" ? commit.avatarUrl : null).toBe("https://avatars.example/dev.png");
  });
});
