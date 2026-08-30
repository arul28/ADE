// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PrActivityEvent, PrCommit, PrReview, PrWithConflicts } from "../../../../shared/types/prs";
import { parsePrsRouteState } from "../prsRouteState";
import {
  PrDetailTimelineRails,
  buildCommitRailCommits,
  buildTimelineEvents,
  buildTimelineVisibleEventHash,
  buildTimelineVisibleEventSearch,
} from "./PrDetailTimelineRails";
import type { ComponentProps } from "react";
import { PrDetailHeader } from "./PrDetailHeader";

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
  // Sizes are surfaced as data attributes rather than dropped: the split ratio
  // between thread and right rail is a product decision worth asserting, and
  // the real Group needs layout the jsdom environment cannot supply.
  const strip = ({
    defaultSize,
    minSize,
    maxSize,
    orientation: _orientation,
    groupResizeBehavior: _groupResizeBehavior,
    onResize: _onResize,
    ...rest
  }: PaneProps) => ({
    ...rest,
    "data-default-size": defaultSize as number | undefined,
    "data-min-size": minSize as number | undefined,
    "data-max-size": maxSize as number | undefined,
  });
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
vi.mock("../shared/PrCommitTickPill", () => ({
  PrCommitTickPill: (props: { commits: readonly { sha: string }[] }) => (
    <div
      data-testid="pr-commit-tick-pill"
      data-commit-count={props.commits.length}
      // Surfaced so a test can pin the ORDER the rails hand down, not just the count.
      data-first-sha={props.commits[0]?.sha ?? ""}
    />
  ),
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

  it("keeps coordinate-only routes coordinate-based while replacing the visible event", () => {
    const current = parsePrsRouteState({
      search: "?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&detailTab=overview",
    });

    expect(buildTimelineVisibleEventSearch({
      current,
      prId: "gh:ade-dev/ade#123",
      eventId: "comment-new",
    })).toBe("?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-new&detailTab=overview");
  });

  it("preserves a hash-based coordinate PR route when the visible event changes", () => {
    const current = parsePrsRouteState({
      hash: "#/prs?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-old",
    });
    const nextSearch = buildTimelineVisibleEventSearch({
      current,
      prId: "gh:ade-dev/ade#123",
      eventId: "comment-new",
    });

    expect(buildTimelineVisibleEventHash({
      currentHash: "#/prs?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-old",
      nextSearch,
    })).toBe("#/prs?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-new");
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

function renderRails(
  files: Array<{ filename: string; additions: number; deletions: number }> = [],
  pr: PrWithConflicts = layoutPr,
  activity: PrActivityEvent[] = [],
) {
  return render(
    <PrDetailTimelineRails
      pr={pr}
      detail={null}
      status={null}
      checks={[]}
      reviews={[]}
      comments={[]}
      activity={activity}
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

describe("PrDetailTimelineRails — Overview layout", () => {
  it("groups the view as thread + tick pill | can-this-land", () => {
    renderRails([{ filename: "src/cli.ts", additions: 100, deletions: 5 }]);

    const thread = screen.getByTestId("pr-detail-thread-panel");
    const right = screen.getByTestId("pr-detail-right-rail");

    // Commits ride over the thread as a floating tick pill; everything that
    // answers "can this land" — including files changed — sits in the right rail.
    expect(thread.contains(screen.getByTestId("pr-commit-tick-pill"))).toBe(true);
    expect(right.contains(screen.getByTestId("pr-files-changed-card"))).toBe(true);
    expect(right.contains(screen.getByTestId("pr-detail-right-metadata-rail"))).toBe(true);
    expect(right.contains(screen.getByTestId("pr-detail-merge-rail"))).toBe(true);
    expect(thread.contains(screen.getByTestId("pr-detail-merge-rail"))).toBe(false);

    const mergePane = screen.getByTestId("pr-detail-merge-pane");
    expect(right.lastElementChild).toBe(mergePane);
  });

  // Regression: the pill floats, so the thread must NOT reserve the 22px left
  // gutter the old full-height rail needed. That gutter shifted every timeline
  // row (and its spine) right for a control that no longer occupies the column.
  it("reclaims the thread width the old rail gutter reserved", () => {
    renderRails();
    const body = screen.getByTestId("pr-detail-thread-panel").firstElementChild as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.style.paddingLeft).toBe("");
  });

  // Force-pushes are branch actions, not commits. A month-old dependabot PR can
  // carry a dozen of them, which is how a 1-commit PR ended up with 15 ticks.
  it("keeps force-pushes out of the tick pill while the timeline still shows them", () => {
    const activity: PrActivityEvent[] = [
      {
        id: "c1",
        type: "commit",
        author: "dev",
        avatarUrl: null,
        body: null,
        timestamp: "2026-01-02T00:00:00Z",
        metadata: { sha: "aaaaaaa", subject: "first" },
      },
      {
        id: "fp1",
        type: "force_push",
        author: "dev",
        avatarUrl: null,
        body: null,
        timestamp: "2026-01-03T00:00:00Z",
        metadata: { beforeSha: "aaaaaaa", afterSha: "bbbbbbb" },
      },
      {
        id: "c2",
        type: "commit",
        author: "dev",
        avatarUrl: null,
        body: null,
        timestamp: "2026-01-04T00:00:00Z",
        metadata: { sha: "ccccccc", subject: "second" },
      },
    ];
    renderRails([], layoutPr, activity);

    expect(screen.getByTestId("pr-commit-tick-pill").getAttribute("data-commit-count")).toBe("2");
    expect(buildCommitRailCommits(activity, [], []).filter((c) => c.forcePushed)).toHaveLength(1);
  });

  // The pill is a glance-index in a corner, so the newest commit belongs nearest
  // its anchor. `buildCommitRailCommits` emits oldest-first for the timeline, so
  // the rails reverse it on the way in. This pins the direction: without it a
  // future refactor could flip the order back and nothing would fail.
  it("hands the tick pill its commits newest first", () => {
    const activity: PrActivityEvent[] = [
      {
        id: "c1",
        type: "commit",
        author: "dev",
        avatarUrl: null,
        body: null,
        timestamp: "2026-01-01T00:00:00Z",
        metadata: { sha: "aaaaaaa", subject: "oldest" },
      },
      {
        id: "c2",
        type: "commit",
        author: "dev",
        avatarUrl: null,
        body: null,
        timestamp: "2026-01-05T00:00:00Z",
        metadata: { sha: "zzzzzzz", subject: "newest" },
      },
    ];
    // The builder itself stays chronological — the reversal is the rails' doing.
    const built = buildCommitRailCommits(activity, [], []);
    expect(built.map((c) => c.subject)).toEqual(["oldest", "newest"]);

    renderRails([], layoutPr, activity);
    const pill = screen.getByTestId("pr-commit-tick-pill");
    expect(pill.getAttribute("data-first-sha")).toBe("zzzzzzz");
  });

  // The thread gives back a little width so the right rail — which now carries
  // files-changed on top of reviewers/checks/merge — can breathe. A nudge, not a
  // rebalance: the thread still floors above the rail's default.
  // The rail's floor IS its default: it can be widened but never narrowed. A
  // smaller floor let the separator — or the PR-list separator squeezing from
  // the other side — shrink it until reviewers, checks, files and the merge box
  // all truncated, i.e. until the pane hid its own content.
  it("never lets the right rail shrink below the width that shows everything", () => {
    renderRails();
    const right = screen.getByTestId("pr-detail-right-rail");
    const thread = screen.getByTestId("pr-detail-thread-panel");

    expect(right.getAttribute("data-default-size")).toBe("390");
    expect(right.getAttribute("data-min-size")).toBe("390");
    expect(right.getAttribute("data-max-size")).toBe("560");
    expect(thread.getAttribute("data-min-size")).toBe("360");
  });

  // A stored width always beats a new default, so shipping a wider rail under
  // the old key would be invisible to anyone who had ever dragged the separator.
  // The key is versioned; v1 values are dead.
  it("ignores a width saved under the retired key and honours the current one", () => {
    localStorage.setItem("ade.prs.overviewRightRailWidth:proj-1", "300");
    renderRails();
    expect(screen.getByTestId("pr-detail-right-rail").getAttribute("data-default-size")).toBe("390");
    cleanup();

    localStorage.setItem("ade.prs.overviewRightRailWidth.v2:proj-1", "440");
    renderRails();
    expect(screen.getByTestId("pr-detail-right-rail").getAttribute("data-default-size")).toBe("440");
    localStorage.clear();
  });

  it("mounts one drag separator, between the thread and the right rail", () => {
    renderRails();
    expect(screen.getByTestId("pr-detail-timeline-rails")).toBeTruthy();
    expect(screen.queryByTestId("pr-detail-rail-separator-pr-overview-left-separator")).toBeNull();
    expect(screen.getByTestId("pr-detail-rail-separator-pr-overview-right-separator")).toBeTruthy();
  });

  it("replaces ADE merge controls with GitHub guidance for a stacked PR", () => {
    renderRails([], {
      ...layoutPr,
      githubUrl: "https://github.com/acme/ade/pull/42",
      stack: {
        id: "stack-18",
        number: 18,
        size: 3,
        position: 2,
        baseBranch: "main",
      },
    });

    expect(screen.queryByTestId("pr-detail-merge-rail")).toBeNull();
    expect(screen.getByText("GitHub Stack 2 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review and merge on GitHub" })).toBeTruthy();
  });
});


/* -- Folded in from `PrDetailHeader.test.tsx` --
   The header above the same overview; one surface, one suite. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makePr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 1180,
    githubUrl: "https://github.com/arul28/ADE/pull/1180",
    githubNodeId: null,
    title: "ADE UI clutter reduction",
    state: "merged",
    baseBranch: "main",
    headBranch: "ade/ade-ui-clutter-reduction",
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

function renderHeader(overrides: Partial<ComponentProps<typeof PrDetailHeader>> = {}) {
  const props: ComponentProps<typeof PrDetailHeader> = {
    pr: makePr(),
    provisional: false,
    activeTab: "overview",
    onSelectTab: vi.fn(),
    filesCount: 30,
    checksCount: 37,
    editingTitle: false,
    titleDraft: "",
    onTitleDraftChange: vi.fn(),
    onStartTitleEdit: vi.fn(),
    onCancelTitleEdit: vi.fn(),
    onSubmitTitle: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<PrDetailHeader {...props} />) };
}

describe("PrDetailHeader", () => {
  it("carries number, title, state, branch pair and tabs on one row and nothing that was dropped", () => {
    const { container } = renderHeader();

    expect(screen.getByText("#1180")).toBeTruthy();
    expect(screen.getByText("ADE UI clutter reduction")).toBeTruthy();
    expect(screen.getByText("MERGED")).toBeTruthy();
    // The head branch is split so its last 12 characters sit outside the
    // ellipsis: the tail is the part that distinguishes one branch from another.
    expect(screen.getByText("ade/ade-ui-clutt")).toBeTruthy();
    expect(screen.getByText("er-reduction")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("CI / Checks")).toBeTruthy();

    // Dropped: repository name, the CI rollup badge, and the per-PR refresh.
    expect(container.textContent).not.toContain("arul28/ADE");
    expect(container.querySelector('[data-testid="pr-header-ci-badge"]')).toBeNull();
    expect(screen.queryByLabelText("Refresh")).toBeNull();

    // The GitHub control is icon-only.
    const github = screen.getByLabelText("Open on GitHub");
    expect(github.textContent).toBe("");
  });

  it("keeps the edit pencil out of sight until the title row is hovered or focused", () => {
    const onStartTitleEdit = vi.fn();
    renderHeader({ onStartTitleEdit });

    const pencil = screen.getByLabelText("Edit title");
    // Hidden by default, but still in the tab order, so keyboard focus reveals it
    // through the identity row's :focus-within rule.
    expect(pencil.className).toContain("ade-pr-detail-header-edit");
    expect(pencil.closest(".ade-pr-detail-header-identity")).not.toBeNull();
    expect(pencil.getAttribute("disabled")).toBeNull();

    fireEvent.click(pencil);
    expect(onStartTitleEdit).toHaveBeenCalledTimes(1);
  });

  it("has no edit pencil for a PR with no lane, which cannot be renamed", () => {
    renderHeader({ pr: makePr({ laneId: null as unknown as string }) });
    expect(screen.queryByLabelText("Edit title")).toBeNull();
  });

  it("commits the title on Enter and abandons it on Escape", () => {
    const onSubmitTitle = vi.fn();
    const onCancelTitleEdit = vi.fn();
    renderHeader({ editingTitle: true, titleDraft: "New title", onSubmitTitle, onCancelTitleEdit });

    const input = screen.getByLabelText("Pull request title");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmitTitle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancelTitleEdit).toHaveBeenCalledTimes(1);
  });

  it("switches tabs and opens the PR's own GitHub URL", () => {
    const openExternal = vi.fn();
    const openInGitHub = vi.fn();
    (window as unknown as { ade: unknown }).ade = { app: { openExternal }, prs: { openInGitHub } };

    const onSelectTab = vi.fn();
    renderHeader({ onSelectTab });

    fireEvent.click(screen.getByText("CI / Checks"));
    expect(onSelectTab).toHaveBeenCalledWith("checks");

    fireEvent.click(screen.getByLabelText("Open on GitHub"));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/arul28/ADE/pull/1180");
    expect(openInGitHub).not.toHaveBeenCalled();
  });
});
