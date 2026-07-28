// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PrActivityEvent, PrCommit, PrReview, PrWithConflicts } from "../../../../shared/types/prs";
import { parsePrsRouteState } from "../prsRouteState";
import {
  PrDetailTimelineRails,
  buildCommitRailCommits,
  buildTimelineEvents,
  buildTimelineVisibleEventSearch,
} from "./PrDetailTimelineRails";

vi.mock("react-resizable-panels", () => {
  type PaneProps = React.HTMLAttributes<HTMLDivElement> & {
    id?: string;
    defaultSize?: unknown;
    minSize?: unknown;
    maxSize?: unknown;
    orientation?: unknown;
    groupResizeBehavior?: unknown;
    onResize?: unknown;
  };
  const strip = ({
    defaultSize: _defaultSize,
    minSize: _minSize,
    maxSize: _maxSize,
    orientation: _orientation,
    groupResizeBehavior: _groupResizeBehavior,
    onResize: _onResize,
    ...rest
  }: PaneProps) => rest;
  return {
    Group: (props: PaneProps) => <div {...strip(props)} />,
    Panel: (props: PaneProps) => <div {...strip(props)} />,
    Separator: (props: PaneProps) => <div role="separator" {...strip(props)} />,
  };
});

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/prs", search: "?tab=normal&prId=pr-1" }),
}));

vi.mock("../shared/PrTimeline", () => ({
  PrTimeline: React.forwardRef(function PrTimeline(_props: unknown, _ref: unknown) {
    return <div data-testid="pr-timeline" />;
  }),
}));
vi.mock("../shared/PrCommitRail", () => ({
  PrCommitRail: () => <div data-testid="pr-commit-rail" />,
}));
vi.mock("../shared/PrDetailMergeRail", () => ({
  PrDetailMergeRail: () => <div data-testid="pr-detail-merge-rail" />,
}));
vi.mock("../shared/PrDetailRightMetadataRail", () => ({
  PrDetailRightMetadataRail: () => <div data-testid="pr-detail-right-metadata-rail" />,
}));
vi.mock("../shared/PrCommentComposer", () => ({
  PrCommentComposer: () => null,
}));
vi.mock("../shared/PrCommandPalettes", () => ({
  PrCommandPalettes: () => null,
}));

afterEach(cleanup);

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

  it("pins the PR description to the top even when its createdAt is newer than later events", () => {
    // An adopted/linked PR can carry a wrong (too-recent) createdAt; the
    // description must still render first (GitHub parity), not sink below the
    // force-push whose real timestamp is earlier.
    const latePr = { id: "pr-1", createdAt: "2026-12-31T00:00:00Z", baseBranch: "main" } as unknown as PrWithConflicts;
    const detail = {
      body: "PR description",
      author: { login: "octocat", avatarUrl: null },
    } as unknown as Parameters<typeof buildTimelineEvents>[0]["detail"];
    const events = buildTimelineEvents(foldArgs({ pr: latePr, detail, activity: [forcePush] }));
    expect(events[0]?.type).toBe("description");
    // The earlier-timestamped force-push is still present, just below.
    expect(events.some((e) => e.type === "commit_push")).toBe(true);
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

const layoutPr = {
  id: "pr-1",
  projectId: "proj-1",
  laneId: "lane-1",
  repoOwner: "acme",
  repoName: "ade",
  state: "open",
  baseBranch: "main",
  headBranch: "feature",
  createdAt: "2026-01-01T00:00:00Z",
} as unknown as PrWithConflicts;

function renderRails(files: Array<{ filename: string; additions: number; deletions: number }> = []) {
  return render(
    <PrDetailTimelineRails
      pr={layoutPr}
      detail={null}
      status={null}
      checks={[]}
      reviews={[]}
      comments={[]}
      activity={[]}
      commits={[]}
      files={files}
      reviewThreads={[]}
      deployments={[]}
      viewerLogin="alice"
      filters={{} as never}
      onFiltersChange={() => {}}
      aiSummary={null}
      aiSummaryDismissed={false}
      onDismissAiSummary={() => {}}
      onRegenerateAiSummary={() => {}}
      commentDraft=""
      setCommentDraft={() => {}}
      actionBusy={false}
      onAddComment={() => {}}
      deepLink={{ eventId: null, threadId: null, commitSha: null }}
      actionRuns={[]}
      mergeMethod="squash"
      showReviewerEditor={false}
      setShowReviewerEditor={() => {}}
      reviewerInput=""
      setReviewerInput={() => {}}
      showLabelEditor={false}
      setShowLabelEditor={() => {}}
      labelInput=""
      setLabelInput={() => {}}
      onMerge={() => {}}
      onRequestReviewers={() => {}}
      onSetLabels={() => {}}
      lane={null}
      onSubmitReview={() => {}}
    />,
  );
}

describe("PrDetailTimelineRails — Overview B′ layout", () => {
  it("groups the rails as what-changed | thread | can-this-land", () => {
    renderRails([{ filename: "src/cli.ts", additions: 100, deletions: 5 }]);

    const left = screen.getByTestId("pr-detail-left-rail");
    const right = screen.getByTestId("pr-detail-right-rail");

    expect(left.contains(screen.getByTestId("pr-commit-rail"))).toBe(true);
    expect(left.contains(screen.getByTestId("pr-files-changed-card"))).toBe(true);
    expect(right.contains(screen.getByTestId("pr-detail-right-metadata-rail"))).toBe(true);
    expect(right.contains(screen.getByTestId("pr-detail-merge-rail"))).toBe(true);
    expect(left.contains(screen.getByTestId("pr-detail-merge-rail"))).toBe(false);

    const mergePane = screen.getByTestId("pr-detail-merge-pane");
    expect(right.lastElementChild).toBe(mergePane);
  });

  it("mounts resizable rails with drag separators either side of the thread", () => {
    renderRails();
    expect(screen.getByTestId("pr-detail-timeline-rails")).toBeTruthy();
    expect(screen.getByTestId("pr-detail-rail-separator-pr-overview-left-separator")).toBeTruthy();
    expect(screen.getByTestId("pr-detail-rail-separator-pr-overview-right-separator")).toBeTruthy();
  });
});
