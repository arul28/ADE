// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock child cards to keep this test focused on Timeline behavior.
vi.mock("./PrReviewThreadCard", () => ({
  PrReviewThreadCard: ({
    thread,
    focused,
  }: {
    thread: { id: string };
    focused?: boolean;
  }) => (
    <div data-testid="review-thread-card" data-thread-id={thread.id} data-focused={!!focused} />
  ),
}));

vi.mock("./PrBotReviewCard", () => ({
  PrBotReviewCard: ({ review }: { review: { reviewer: string } }) => (
    <div data-testid="bot-review-card" data-reviewer={review.reviewer} />
  ),
  detectBotProvider: (login: string) => (login.endsWith("[bot]") ? "coderabbit" : null),
}));

vi.mock("./PrAiSummaryCard", () => ({
  PrAiSummaryCard: ({ prId }: { prId: string }) => (
    <div data-testid="ai-summary-card" data-pr-id={prId} />
  ),
  isAiSummaryDismissed: () => false,
}));

vi.mock("./PrMarkdown", () => ({
  PrMarkdown: ({ children }: { children: string }) => (
    <div data-testid="pr-markdown">{children}</div>
  ),
}));

// Mock the virtualizer: jsdom has no layout, so by default getVirtualItems
// returns an empty list. Render all items at once so tests can assert
// rendered content without coordinating scroll state.
const virtualizerSpy = vi.fn();
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number }) => {
    virtualizerSpy(options);
    const size = options.estimateSize();
    return {
      getTotalSize: () => options.count * size,
      getVirtualItems: () =>
        Array.from({ length: options.count }, (_, index) => ({
          index,
          key: index,
          start: index * size,
          size,
        })),
      scrollToIndex: () => {},
      measureElement: () => {},
    };
  },
}));

import type {
  PrTimelineEvent,
  PrAiSummary,
} from "../../../../shared/types/prs";
import {
  PrTimeline,
  applyTimelineFilters,
  buildRenderItems,
  DEFAULT_PR_TIMELINE_FILTERS,
  type PrTimelineRef,
  type PrTimelineFilters,
} from "./PrTimeline";

beforeEach(() => {
  // IntersectionObserver stub — mark everything immediately visible.
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    constructor(private cb: (entries: IntersectionObserverEntry[]) => void) {}
    observe(el: Element) {
      this.cb([
        {
          isIntersecting: true,
          target: el,
        } as unknown as IntersectionObserverEntry,
      ]);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = "";
    thresholds = [];
  };

  // scrollTo is called by the virtualizer when `scrollToIndex` runs.
  // jsdom doesn't implement it on HTMLElement so stub it.
  Element.prototype.scrollTo = function () {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeEvent(overrides: Partial<PrTimelineEvent> & Pick<PrTimelineEvent, "type">): PrTimelineEvent {
  const base = {
    id: "ev-" + Math.random().toString(36).slice(2, 10),
    timestamp: new Date().toISOString(),
    author: "alice",
    avatarUrl: null,
  };
  // We rely on caller passing the rest of the discriminated union fields.
  return { ...base, ...overrides } as PrTimelineEvent;
}

function fixture500(): PrTimelineEvent[] {
  const events: PrTimelineEvent[] = [];
  for (let i = 0; i < 500; i += 1) {
    // Distinct author per commit so the same-author commit-grouping fold does
    // not collapse the list — this fixture exists to exercise virtualization
    // over a large render-item count, not the grouping path.
    events.push(
      makeEvent({
        id: `e-${i}`,
        type: "commit_push",
        author: `dev-${i}`,
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        subject: `commit ${i}`,
        commitCount: 1,
        forcePushed: false,
      }),
    );
  }
  return events;
}

describe("applyTimelineFilters", () => {
  const events: PrTimelineEvent[] = [
    makeEvent({
      id: "t-open",
      type: "review_thread",
      threadId: "t-open",
      path: "a.ts",
      line: 1,
      startLine: null,
      isResolved: false,
      isOutdated: false,
      commentCount: 1,
      firstCommentBody: "issue",
    }),
    makeEvent({
      id: "t-resolved",
      type: "review_thread",
      threadId: "t-resolved",
      path: "b.ts",
      line: 2,
      startLine: null,
      isResolved: true,
      isOutdated: false,
      commentCount: 1,
      firstCommentBody: "done",
    }),
    makeEvent({
      id: "t-outdated",
      type: "review_thread",
      threadId: "t-outdated",
      path: "c.ts",
      line: 3,
      startLine: null,
      isResolved: false,
      isOutdated: true,
      commentCount: 1,
      firstCommentBody: "stale",
    }),
  ];

  it("shows resolved and outdated threads by default", () => {
    const out = applyTimelineFilters(events, DEFAULT_PR_TIMELINE_FILTERS, "alice");
    expect(out).toHaveLength(3);
  });

  it("hides resolved and outdated when flags are off", () => {
    const filters: PrTimelineFilters = {
      showResolved: false,
      showOutdated: false,
      onlyMine: false,
      onlyBots: false,
    };
    const out = applyTimelineFilters(events, filters, "alice");
    const ids = out.map((e) => e.id);
    expect(ids).toEqual(["t-open"]);
  });

  it("includes resolved + outdated when flags are on", () => {
    const filters: PrTimelineFilters = {
      showResolved: true,
      showOutdated: true,
      onlyMine: false,
      onlyBots: false,
    };
    const out = applyTimelineFilters(events, filters, "alice");
    expect(out).toHaveLength(3);
  });

  it("excludes check notifications from the overview feed", () => {
    const out = applyTimelineFilters(
      [
        makeEvent({
          id: "check:Vercel:2026-05-15T00:03:20Z",
          type: "check_update",
          checkName: "Vercel",
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://example.com",
        }),
        makeEvent({
          id: "t-open",
          type: "review_thread",
          threadId: "t-open",
          path: "a.ts",
          line: 1,
          startLine: null,
          isResolved: false,
          isOutdated: false,
          commentCount: 1,
          firstCommentBody: "open",
        }),
      ],
      DEFAULT_PR_TIMELINE_FILTERS,
      "alice",
    );
    expect(out.map((event) => event.id)).toEqual(["t-open"]);
  });

  it("always keeps pr_opened events even when mine/bots filters are active", () => {
    const opened = makeEvent({
      id: "opened:pr-1",
      type: "pr_opened",
      author: "octocat",
      title: "Add PR opened banner",
      githubPrNumber: 42,
      repoOwner: "acme",
      repoName: "ade",
      baseBranch: "main",
      headBranch: "feature/banner",
      isDraft: false,
      additions: 12,
      deletions: 3,
    });
    const mineOnly: PrTimelineFilters = {
      ...DEFAULT_PR_TIMELINE_FILTERS,
      onlyMine: true,
    };
    const botsOnly: PrTimelineFilters = {
      ...DEFAULT_PR_TIMELINE_FILTERS,
      onlyBots: true,
    };
    expect(applyTimelineFilters([opened], mineOnly, "alice").map((e) => e.id)).toEqual(["opened:pr-1"]);
    expect(applyTimelineFilters([opened], botsOnly, "alice").map((e) => e.id)).toEqual(["opened:pr-1"]);
  });
});

function makeThread(id: string, isResolved: boolean): PrTimelineEvent {
  return makeEvent({
    id,
    type: "review_thread",
    threadId: id,
    path: "a.ts",
    line: 1,
    startLine: null,
    isResolved,
    isOutdated: false,
    commentCount: 1,
    firstCommentBody: id,
  });
}

describe("buildRenderItems", () => {
  it("folds a run of 2+ consecutive resolved threads into one resolved-group", () => {
    const items = buildRenderItems([
      makeThread("r1", true),
      makeThread("r2", true),
      makeThread("r3", true),
    ]);
    expect(items).toHaveLength(1);
    const group = items[0]!;
    expect(group.kind).toBe("resolved-group");
    if (group.kind !== "resolved-group") throw new Error("expected resolved-group");
    expect(group.threads.map((t) => t.id)).toEqual(["r1", "r2", "r3"]);
    // Group id is derived from the first folded thread so it stays stable.
    expect(group.id).toBe("resolved-group:r1");
  });

  it("leaves a single resolved thread as a plain event (no fold)", () => {
    const items = buildRenderItems([makeThread("solo", true)]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("event");
    expect(items[0]!.id).toBe("solo");
  });

  it("does not fold an unresolved thread sandwiched between resolved ones — it breaks the run", () => {
    const items = buildRenderItems([
      makeThread("r1", true),
      makeThread("r2", true),
      makeThread("open", false),
      makeThread("r3", true),
      makeThread("r4", true),
    ]);
    // Two folded groups around the unresolved event in the middle.
    expect(items.map((i) => i.kind)).toEqual(["resolved-group", "event", "resolved-group"]);
    expect(items[1]!.kind === "event" && items[1]!.event.id).toBe("open");
    if (items[0]!.kind !== "resolved-group" || items[2]!.kind !== "resolved-group") {
      throw new Error("expected resolved-group bookends");
    }
    expect(items[0]!.threads.map((t) => t.id)).toEqual(["r1", "r2"]);
    expect(items[2]!.threads.map((t) => t.id)).toEqual(["r3", "r4"]);
  });

  it("flushes a trailing resolved run after a non-thread event", () => {
    const items = buildRenderItems([
      makeEvent({
        type: "commit_push",
        id: "c1",
        author: "solo",
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        subject: "commit",
        commitCount: 1,
        forcePushed: false,
      }),
      makeThread("r1", true),
      makeThread("r2", true),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["event", "resolved-group"]);
    expect(items[0]!.id).toBe("c1");
  });

  function makeCommit(id: string, author: string): PrTimelineEvent {
    return makeEvent({
      id,
      type: "commit_push",
      author,
      sha: "a".repeat(40),
      shortSha: id.slice(0, 7),
      subject: id,
      commitCount: 1,
      forcePushed: false,
    });
  }

  it("folds 2+ consecutive same-author commits into one commit-group", () => {
    const items = buildRenderItems([
      makeCommit("c1", "alice"),
      makeCommit("c2", "alice"),
      makeCommit("c3", "alice"),
    ]);
    expect(items).toHaveLength(1);
    const group = items[0]!;
    expect(group.kind).toBe("commit-group");
    if (group.kind !== "commit-group") throw new Error("expected commit-group");
    expect(group.commits.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(group.id).toBe("commit-group:c1");
  });

  it("breaks the commit run when the author changes", () => {
    const items = buildRenderItems([
      makeCommit("c1", "alice"),
      makeCommit("c2", "alice"),
      makeCommit("c3", "bob"),
    ]);
    // alice's pair folds; bob's single stays a plain event.
    expect(items.map((i) => i.kind)).toEqual(["commit-group", "event"]);
    expect(items[1]!.kind === "event" && items[1]!.event.id).toBe("c3");
  });

  it("synthesizes a single checks-summary before the merge from all check rows", () => {
    const items = buildRenderItems([
      makeEvent({
        id: "check:lint",
        type: "check_update",
        checkName: "lint",
        status: "completed",
        conclusion: "success",
        detailsUrl: null,
      }),
      makeEvent({
        id: "check:test",
        type: "check_update",
        checkName: "test",
        status: "completed",
        conclusion: "failure",
        detailsUrl: null,
      }),
      makeEvent({
        type: "merge",
        id: "merge:1",
        mergeCommitSha: "abc1234",
        method: "squash",
        baseBranch: "main",
      }),
    ]);
    // Check rows collapse into one summary placed *before* the merge.
    expect(items.map((i) => i.kind)).toEqual(["checks-summary", "event"]);
    const summary = items[0]!;
    if (summary.kind !== "checks-summary") throw new Error("expected checks-summary");
    expect(summary.checks.map((c) => c.checkName).sort()).toEqual(["lint", "test"]);
    expect(items[1]!.kind === "event" && items[1]!.event.type).toBe("merge");
  });
});

describe("PrTimeline", () => {
  it("mounts without crashing on a 500-event fixture and uses the virtualizer", () => {
    virtualizerSpy.mockClear();
    const events = fixture500();
    render(
      <PrTimeline
        events={events}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={{ ...DEFAULT_PR_TIMELINE_FILTERS, showResolved: true }}
        onFiltersChange={() => {}}
      />,
    );
    expect(virtualizerSpy).toHaveBeenCalled();
    const args = virtualizerSpy.mock.calls[0]![0] as { count: number };
    expect(args.count).toBe(500);
  });

  it("keeps resolved review threads in the full overview thread", () => {
    const events: PrTimelineEvent[] = [
      makeEvent({
        id: "open",
        type: "review_thread",
        threadId: "t1",
        path: "a.ts",
        line: 10,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        commentCount: 1,
        firstCommentBody: "open",
      }),
      makeEvent({
        id: "closed",
        type: "review_thread",
        threadId: "t2",
        path: "b.ts",
        line: 2,
        startLine: null,
        isResolved: true,
        isOutdated: false,
        commentCount: 1,
        firstCommentBody: "closed",
      }),
    ];
    render(
      <PrTimeline
        events={events}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={{ ...DEFAULT_PR_TIMELINE_FILTERS, showResolved: true }}
        onFiltersChange={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("review-thread-card");
    const ids = cards.map((c) => c.getAttribute("data-thread-id"));
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
  });

  it("nextUnresolved advances the focused event id via imperative handle", () => {
    const events: PrTimelineEvent[] = [
      makeEvent({
        id: "t1",
        type: "review_thread",
        threadId: "t1",
        path: null,
        line: null,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        commentCount: 1,
        firstCommentBody: "a",
      }),
      makeEvent({
        id: "t2",
        type: "review_thread",
        threadId: "t2",
        path: null,
        line: null,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        commentCount: 1,
        firstCommentBody: "b",
      }),
    ];
    const ref = createRef<PrTimelineRef>();
    render(
      <PrTimeline
        ref={ref}
        events={events}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={DEFAULT_PR_TIMELINE_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    expect(ref.current).not.toBeNull();
    act(() => ref.current!.nextUnresolved());
    const first = screen
      .getAllByTestId("review-thread-card")
      .find((card) => card.getAttribute("data-focused") === "true");
    expect(first?.getAttribute("data-thread-id")).toBe("t1");
    act(() => ref.current!.nextUnresolved());
    const second = screen
      .getAllByTestId("review-thread-card")
      .find((card) => card.getAttribute("data-focused") === "true");
    expect(second?.getAttribute("data-thread-id")).toBe("t2");
  });

  it("distinguishes empty filtered results from an empty timeline", () => {
    render(
      <PrTimeline
        events={[
          makeEvent({
            id: "resolved-only",
            type: "review_thread",
            threadId: "resolved-only",
            path: "a.ts",
            line: 1,
            startLine: null,
            isResolved: true,
            isOutdated: false,
            commentCount: 1,
            firstCommentBody: "resolved",
          }),
        ]}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={{ ...DEFAULT_PR_TIMELINE_FILTERS, showResolved: false }}
        onFiltersChange={() => {}}
      />,
    );

    expect(screen.getByText("No events match the current filters.")).toBeTruthy();
  });

  it("renders the AI summary card when a summary is provided", () => {
    const summary: PrAiSummary = {
      prId: "pr-1",
      summary: "LGTM",
      riskAreas: [],
      reviewerHotspots: [],
      unresolvedConcerns: [],
      generatedAt: new Date().toISOString(),
      headSha: "a".repeat(40),
    };
    render(
      <PrTimeline
        events={[]}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={DEFAULT_PR_TIMELINE_FILTERS}
        onFiltersChange={() => {}}
        summary={summary}
      />,
    );
    expect(screen.getByTestId("ai-summary-card")).toBeTruthy();
  });

  it("renders the PR opened banner with title, branches, and stats", () => {
    render(
      <PrTimeline
        events={[
          makeEvent({
            type: "pr_opened",
            id: "opened:pr-1",
            author: "arul28",
            title: "ship: prepare lane for review",
            githubPrNumber: 128,
            repoOwner: "acme",
            repoName: "ade",
            baseBranch: "main",
            headBranch: "ship/lane-review",
            isDraft: false,
            additions: 240,
            deletions: 18,
          }),
        ]}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={DEFAULT_PR_TIMELINE_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    const banner = screen.getByTestId("pr-timeline-opened-banner");
    expect(banner.textContent).toContain("Pull request opened");
    expect(banner.textContent).toContain("ship: prepare lane for review");
    expect(banner.textContent).toContain("#128");
    expect(banner.textContent).toContain("@arul28");
    expect(banner.textContent).toContain("ship/lane-review");
    expect(banner.textContent).toContain("main");
    expect(banner.textContent).toContain("+240");
    expect(banner.textContent).toContain("-18");
  });

  it("collapses 2+ consecutive resolved threads into a foldable group instead of separate cards", () => {
    render(
      <PrTimeline
        events={[makeThread("r1", true), makeThread("r2", true)]}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={{ ...DEFAULT_PR_TIMELINE_FILTERS, showResolved: true }}
        onFiltersChange={() => {}}
      />,
    );
    const group = screen.getByTestId("pr-timeline-resolved-group");
    expect(group.textContent).toContain("2 resolved conversations");
    // Folded threads stay hidden until the group is expanded.
    expect(screen.queryAllByTestId("review-thread-card")).toHaveLength(0);
  });

  it("focusing a folded thread expands its group so the thread renders (indexById maps to the group)", () => {
    const ref = createRef<PrTimelineRef>();
    render(
      <PrTimeline
        ref={ref}
        events={[makeThread("r1", true), makeThread("r2", true)]}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={{ ...DEFAULT_PR_TIMELINE_FILTERS, showResolved: true }}
        onFiltersChange={() => {}}
      />,
    );
    expect(screen.queryAllByTestId("review-thread-card")).toHaveLength(0);
    // scrollToEventId/focusEvent must resolve a *folded* thread id via indexById;
    // focusing it expands the containing group and reveals the cards.
    act(() => ref.current!.focusEvent("r2"));
    const ids = screen
      .getAllByTestId("review-thread-card")
      .map((c) => c.getAttribute("data-thread-id"));
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
  });

  it("renders commit pushes as compact dividers without unresolved floating chip", () => {
    render(
      <PrTimeline
        events={[
          makeEvent({
            type: "commit_push",
            id: "commit:abc1234",
            sha: "abc1234",
            shortSha: "abc1234",
            subject: "Fix scroll behavior",
            commitCount: 1,
            forcePushed: false,
          }),
          makeEvent({
            type: "review_thread",
            id: "thread:t1",
            threadId: "t1",
            path: "src/app.ts",
            line: 12,
            startLine: null,
            isResolved: false,
            isOutdated: false,
            commentCount: 1,
            firstCommentBody: "Please fix",
          }),
        ]}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={DEFAULT_PR_TIMELINE_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    expect(screen.getByTestId("pr-timeline-commit-divider").textContent).toContain("Fix scroll behavior");
    expect(screen.queryByTestId("pr-timeline-unresolved-fab")).toBeNull();
  });
});
