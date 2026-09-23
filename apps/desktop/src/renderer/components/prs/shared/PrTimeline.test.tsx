// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, type Ref } from "react";
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
  PrBotReviewCard: ({ review, defaultOpen }: { review: { reviewer: string }; defaultOpen?: boolean }) => (
    <div
      data-testid="bot-review-card"
      data-reviewer={review.reviewer}
      data-default-open={defaultOpen ? "true" : "false"}
    />
  ),
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
} from "../../../../shared/types/prs";
import {
  PrTimeline,
  type PrTimelineProps,
  type PrTimelineRef,
} from "./PrTimeline";
import { buildDigestTimelineModel } from "./prDigestTimelineModel";

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
    // People are never folded, so each comment stays its own digest row.
    events.push(
      makeEvent({
        id: `e-${i}`,
        type: "issue_comment",
        commentId: `e-${i}`,
        author: `dev-${i}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        body: `comment ${i}`,
        isBot: false,
      }),
    );
  }
  return events;
}

function renderTimeline(
  events: PrTimelineEvent[],
  overrides: Partial<PrTimelineProps> & { ref?: Ref<PrTimelineRef> } = {},
) {
  return render(
    <PrTimeline
      events={events}
      digest={buildDigestTimelineModel(events)}
      prId="pr-1"
      laneId={null}
      repoOwner="acme"
      repoName="ade"
      viewerLogin="alice"
      {...overrides}
    />,
  );
}

function openBotGroup(agent: string) {
  const group = document.querySelector(`[data-testid="pr-digest-bot-group"][data-agent="${agent}"]`) as HTMLElement;
  fireEvent.click(group.querySelector("button[aria-expanded]")!);
  return group;
}

describe("PrTimeline", () => {
  it("mounts without crashing on a 500-event fixture and uses the virtualizer", () => {
    virtualizerSpy.mockClear();
    renderTimeline(fixture500());
    expect(virtualizerSpy).toHaveBeenCalled();
    const args = virtualizerSpy.mock.calls[0]![0] as { count: number };
    expect(args.count).toBe(500);
  });

  it("renders an author avatar once, in the card header", () => {
    renderTimeline([
      makeEvent({
        id: "c1",
        type: "issue_comment",
        commentId: "c1",
        author: "alice",
        avatarUrl: "https://avatars.example/alice.png",
        body: "looks good",
        isBot: false,
      }),
    ]);
    expect(document.querySelectorAll('img[src="https://avatars.example/alice.png"]')).toHaveLength(1);
  });

  it("renders a bodyful bot review collapsed by default (no defaultOpen override)", () => {
    renderTimeline([
      makeEvent({
        id: "r1",
        type: "review",
        reviewId: "r1",
        state: "commented",
        isBot: true,
        author: "greptile-apps[bot]",
        body: "## Greptile review\n" + "finding\n".repeat(40),
      }),
    ]);
    const group = openBotGroup("greptile");
    fireEvent.click(group.querySelector('li[data-event-id="r1"] button')!);
    const card = screen.getByTestId("bot-review-card");
    // A late bot review must not dump its full body expanded at the thread end.
    expect(card.getAttribute("data-default-open")).toBe("false");
  });

  it("collapses a long bot-authored issue comment behind a Show more affordance", () => {
    renderTimeline([
      makeEvent({
        id: "c-bot-long",
        type: "issue_comment",
        commentId: "c-bot-long",
        isBot: true,
        author: "ade[bot]",
        body: "## Bot review\n" + "detail line\n".repeat(30),
      }),
      makeEvent({
        id: "c-human",
        type: "issue_comment",
        commentId: "c-human",
        isBot: false,
        author: "alice",
        body: "looks good to me",
      }),
    ]);
    const group = openBotGroup("ade");
    fireEvent.click(group.querySelector('li[data-event-id="c-bot-long"] button')!);
    // The long bot comment collapses; the short human comment has no collapse control.
    expect(screen.getAllByText("Show more")).toHaveLength(1);
  });

  it("marks bot text split out of the PR body as from the PR description", () => {
    const at = "2026-01-01T00:00:00Z";
    renderTimeline([
      makeEvent({
        id: "desc-bot:pr-1:coderabbit-summary",
        type: "issue_comment",
        commentId: "desc-bot:coderabbit-summary",
        author: "coderabbitai",
        timestamp: at,
        body: "Summary by CodeRabbit",
        isBot: true,
      }),
      makeEvent({
        id: "desc-bot:pr-1:cursor-summary",
        type: "issue_comment",
        commentId: "desc-bot:cursor-summary",
        author: "cursor",
        timestamp: at,
        body: "Cursor summary",
        isBot: true,
      }),
      makeEvent({
        id: "comment:real",
        type: "issue_comment",
        commentId: "real",
        author: "cursor",
        timestamp: "2026-01-01T01:00:00Z",
        body: "A real Cursor comment",
        isBot: true,
      }),
    ]);
    // Every CodeRabbit entry came from the body: the note sits by the name.
    const coderabbit = document.querySelector('[data-agent="coderabbit"]') as HTMLElement;
    expect(coderabbit.querySelector('[data-testid="pr-digest-desc-bot-note"]')?.textContent).toBe("from the PR description");
    // Cursor mixes one body block with one real comment: only that entry is marked.
    const cursor = openBotGroup("cursor");
    const notes = cursor.querySelectorAll('[data-testid="pr-digest-desc-bot-note"]');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.closest("li")?.getAttribute("data-event-id")).toBe("desc-bot:pr-1:cursor-summary");
    expect(cursor.querySelector('li[data-event-id="comment:real"] [data-testid="pr-digest-desc-bot-note"]')).toBeNull();
  });

  it("keeps resolved review threads in the overview thread", () => {
    renderTimeline([
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
    ]);
    const ids = screen.getAllByTestId("review-thread-card").map((c) => c.getAttribute("data-thread-id"));
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
  });

  it("nextUnresolved advances the focused event id via imperative handle", () => {
    const thread = (id: string, at: string) =>
      makeEvent({
        id,
        type: "review_thread",
        threadId: id,
        timestamp: at,
        path: null,
        line: null,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        commentCount: 1,
        firstCommentBody: id,
      });
    const ref = createRef<PrTimelineRef>();
    renderTimeline([thread("t1", "2026-01-01T00:00:00Z"), thread("t2", "2026-01-01T01:00:00Z")], { ref });
    expect(ref.current).not.toBeNull();
    const focusedThreadId = () =>
      screen
        .getAllByTestId("review-thread-card")
        .find((card) => card.getAttribute("data-focused") === "true")
        ?.getAttribute("data-thread-id");
    act(() => ref.current!.nextUnresolved());
    expect(focusedThreadId()).toBe("t1");
    act(() => ref.current!.nextUnresolved());
    expect(focusedThreadId()).toBe("t2");
  });

  it("focusing an entry folded into a bot row opens that row and entry", () => {
    const ref = createRef<PrTimelineRef>();
    renderTimeline(
      [
        makeEvent({
          id: "bot-thread",
          type: "review_thread",
          threadId: "bot-thread",
          author: "coderabbitai",
          path: "a.ts",
          line: 1,
          startLine: null,
          isResolved: true,
          isOutdated: false,
          commentCount: 1,
          firstCommentBody: "done",
        }),
      ],
      { ref },
    );
    expect(screen.queryAllByTestId("review-thread-card")).toHaveLength(0);
    act(() => ref.current!.focusEvent("bot-thread"));
    expect(screen.getByTestId("review-thread-card").getAttribute("data-thread-id")).toBe("bot-thread");
  });

  it("shows an empty state when there are no events", () => {
    renderTimeline([]);
    expect(screen.getByText("No activity yet.")).toBeTruthy();
    expect(screen.queryByTestId("ai-summary-card")).toBeNull();
    expect(screen.queryByTestId("pr-timeline-summary")).toBeNull();
  });

  it("hides comment mutation controls when writeViewerLogin is null", () => {
    renderTimeline(
      [
        makeEvent({
          id: "c-edit",
          type: "issue_comment",
          commentId: "c-edit",
          author: "alice",
          body: "looks good",
          isBot: false,
          commentGithubId: 555,
          commentNodeId: "IC_kwDO",
        }),
      ],
      { writeViewerLogin: null },
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull();
  });

  it("keeps comment mutation controls when writeViewerLogin is omitted", () => {
    renderTimeline([
      makeEvent({
        id: "c-edit-fallback",
        type: "issue_comment",
        commentId: "c-edit-fallback",
        author: "alice",
        body: "looks good",
        isBot: false,
        commentGithubId: 556,
        commentNodeId: "IC_kwDP",
      }),
    ]);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
});
