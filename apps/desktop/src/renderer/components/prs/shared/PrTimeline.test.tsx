// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
    events.push(
      makeEvent({
        id: `e-${i}`,
        type: "commit_push",
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

  it("hides resolved and outdated by default", () => {
    const out = applyTimelineFilters(events, DEFAULT_PR_TIMELINE_FILTERS, "alice");
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
        filters={DEFAULT_PR_TIMELINE_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    expect(virtualizerSpy).toHaveBeenCalled();
    const args = virtualizerSpy.mock.calls[0]![0] as { count: number };
    expect(args.count).toBe(500);
  });

  it("hides resolved review threads under default filters", () => {
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
        filters={DEFAULT_PR_TIMELINE_FILTERS}
        onFiltersChange={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("review-thread-card");
    const ids = cards.map((c) => c.getAttribute("data-thread-id"));
    expect(ids).toContain("t1");
    expect(ids).not.toContain("t2");
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

  it("toggles the onlyMine filter when Mine pill is clicked", () => {
    const onFiltersChange = vi.fn();
    render(
      <PrTimeline
        events={[]}
        prId="pr-1"
        laneId={null}
        repoOwner="acme"
        repoName="ade"
        viewerLogin="alice"
        filters={DEFAULT_PR_TIMELINE_FILTERS}
        onFiltersChange={onFiltersChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Mine/i }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_PR_TIMELINE_FILTERS,
      onlyMine: true,
    });
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

  it("renders commit pushes as prominent dividers without unresolved floating chip", () => {
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
