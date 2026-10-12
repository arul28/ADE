/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  ChatFindIndex,
  chatFindIndexOf,
  chatFindMatchAt,
  chatFindStartIndex,
  computeChatFindMatches,
} from "./chatFind";
import { onPendingChatFind, setPendingChatFind, takePendingChatFind } from "./chatFindTargets";
import {
  collapseChatTranscriptEvents,
  groupChatTranscriptRows,
  type ChatTranscriptGroupedEnvelope,
} from "./chatTranscriptRows";

type TranscriptEvent = AgentChatEventEnvelope["event"];

const SESSION_ID = "session-find";
const START_MS = Date.parse("2026-10-12T10:00:00.000Z");

/** The rows the transcript renders from these events: envelopes, collapsed, grouped. */
function transcriptRows(events: readonly TranscriptEvent[]): ChatTranscriptGroupedEnvelope[] {
  const envelopes: AgentChatEventEnvelope[] = events.map((event, index) => ({
    sessionId: SESSION_ID,
    timestamp: new Date(START_MS + index * 1_000).toISOString(),
    sequence: index + 1,
    event,
  }));
  return groupChatTranscriptRows(collapseChatTranscriptEvents(envelopes));
}

/** An index with every row folded: the state background indexing reaches. */
function foldedIndex(rows: readonly ChatTranscriptGroupedEnvelope[]): ChatFindIndex {
  const index = new ChatFindIndex();
  index.update(rows, new Set());
  index.indexSome(Number.POSITIVE_INFINITY);
  return index;
}

describe("chat find counts matches", () => {
  it.each<{ body: string; query: string; total: number }>([
    { body: "Alpha beta ALPHA", query: "alpha", total: 2 },
    { body: "aaaa", query: "AA", total: 2 },
    { body: "Alpha beta", query: "gamma", total: 0 },
  ])("finds $query in \"$body\": $total, case-insensitive and non-overlapping", ({ body, query, total }) => {
    const rows = transcriptRows([{ type: "user_message", text: body }]);
    const matches = computeChatFindMatches(foldedIndex(rows).docs(), query);
    expect(rows).toHaveLength(1);
    expect(matches.total).toBe(total);
    expect(matches.entries.map((entry) => entry.count)).toEqual(total ? [total] : []);
    expect(matches.entries[0]?.key ?? null).toBe(total ? rows[0]!.key : null);
  });
});

describe("chat find searches the displayed text of a reply", () => {
  it.each<{ label: string; markdown: string; query: string; total: number }>([
    { label: "bold markup is dropped, its words count", markdown: "**bold** word", query: "bold", total: 1 },
    { label: "a link's URL does not count", markdown: "[read the docs](https://example.com/zebra-page)", query: "zebra", total: 0 },
    { label: "a link's label counts", markdown: "[read the docs](https://example.com/zebra-page)", query: "read the docs", total: 1 },
    { label: "a scene fence's source does not count", markdown: "```scene\n<div>zebra</div>\n```", query: "zebra", total: 0 },
    { label: "a mosaic fence's source does not count", markdown: "```mosaic\nzebra\n```", query: "zebra", total: 0 },
    { label: "an ordinary code fence counts", markdown: "```ts\nconst zebra = 1\n```", query: "zebra", total: 1 },
  ])("$label ($query: $total)", ({ markdown, query, total }) => {
    const rows = transcriptRows([{ type: "text", text: markdown, messageId: "reply-1", turnId: "turn-1" }]);
    const matches = computeChatFindMatches(foldedIndex(rows).docs(), query);
    expect(rows).toHaveLength(1);
    expect(matches.total).toBe(total);
    expect(matches.entries.map((entry) => entry.count)).toEqual(total ? [total] : []);
    expect(matches.entries[0]?.key ?? null).toBe(total ? rows[0]!.key : null);
  });
});

describe("chat find searches the rows the transcript draws", () => {
  const plannedWake = {
    watchId: "watch-1",
    prId: "pr-1",
    githubPrNumber: 42,
    mode: "watch",
    card: {
      cardId: "card-ci-1",
      variant: "pr_ci",
      state: "live",
      title: "CI failed",
      fallbackText: "CI failed on the branch",
    },
  } as const;

  it.each<{ label: string; event: TranscriptEvent; query: string; total: number }>([
    {
      label: "a queued steer waits in the composer, so it is not counted",
      event: { type: "user_message", text: "zebra steer", deliveryState: "queued", steerId: "steer-1" },
      query: "zebra",
      total: 0,
    },
    {
      label: "an accepted steer is in the timeline, so it counts",
      event: { type: "user_message", text: "zebra steer", deliveryState: "accepted", steerId: "steer-1" },
      query: "zebra",
      total: 1,
    },
    {
      label: "a PR-watch wake card is ADE's chrome, so its agent text is not counted",
      event: { type: "user_message", text: "agent reply zebra", metadata: { prWatchWake: plannedWake } },
      query: "zebra",
      total: 0,
    },
    {
      label: "the same words without a wake card are a normal message, so they count",
      event: { type: "user_message", text: "agent reply zebra" },
      query: "zebra",
      total: 1,
    },
    {
      label: "a hidden brief with no display line shows nothing, so its prompt is not counted",
      event: {
        type: "user_message",
        text: "long hidden brief zebra",
        metadata: { hideFullPrompt: true },
      },
      query: "zebra",
      total: 0,
    },
    {
      label: "the brief's display line counts",
      event: {
        type: "user_message",
        text: "long hidden brief zebra",
        displayText: "Refactor the module",
        metadata: { hideFullPrompt: true },
      },
      query: "refactor",
      total: 1,
    },
    {
      label: "a sent message is searched as the user typed it, not the expanded provider text",
      event: { type: "user_message", text: "expanded provider text zebra", displayText: "what I typed" },
      query: "expanded",
      total: 0,
    },
    {
      label: "the typed text counts",
      event: { type: "user_message", text: "expanded provider text zebra", displayText: "what I typed" },
      query: "typed",
      total: 1,
    },
    {
      label: "a board move counts its line",
      event: {
        type: "user_message",
        text: "Moved zebra card to Done",
        metadata: { boardMove: { from: "working", to: "done", at: "2026-10-12T10:00:00.000Z", moveId: "move-1" } },
      },
      query: "zebra",
      total: 1,
    },
  ])("$label: $query -> $total", ({ event, query, total }) => {
    const rows = transcriptRows([event]);
    const matches = computeChatFindMatches(foldedIndex(rows).docs(), query);
    expect(rows).toHaveLength(1);
    expect(matches.total).toBe(total);
    expect(matches.entries.map((entry) => entry.count)).toEqual(total ? [total] : []);
    expect(matches.entries[0]?.key ?? null).toBe(total ? rows[0]!.key : null);
  });
});

describe("ChatFindIndex", () => {
  it("folds rows in slices, reports only real changes, and keeps excluded rows out of the search", () => {
    const events: TranscriptEvent[] = [
      { type: "user_message", text: "first zebra" },
      { type: "text", text: "second zebra reply", messageId: "reply-2", turnId: "turn-2" },
      { type: "text", text: "third reply", messageId: "reply-3", turnId: "turn-3" },
    ];
    const rows = transcriptRows(events);
    const index = new ChatFindIndex();

    expect(index.update(rows, new Set())).toBe(true);
    expect(index.hasPending()).toBe(true);
    expect(index.docs()).toEqual([]);

    expect(index.indexSome(Number.POSITIVE_INFINITY)).toBe(true);
    expect(index.hasPending()).toBe(false);
    expect(index.docs().map((doc) => doc.key)).toEqual(rows.map((row) => row.key));
    expect(index.update(rows, new Set())).toBe(false);

    expect(index.update(rows, new Set([rows[1]!.key]))).toBe(true);
    expect(index.docs().map((doc) => doc.key)).toEqual([rows[0]!.key, rows[2]!.key]);

    // A streamed reply changes its text: until it is folded again it is left out.
    const streamed = transcriptRows([
      events[0]!,
      events[1]!,
      { type: "text", text: "third reply, still streaming", messageId: "reply-3", turnId: "turn-3" },
    ]);
    expect(index.update(streamed, new Set([streamed[1]!.key]))).toBe(true);
    expect(index.hasPending()).toBe(true);
    expect(index.docs().map((doc) => doc.key)).toEqual([rows[0]!.key]);
    expect(index.indexSome(Number.POSITIVE_INFINITY)).toBe(true);
    expect(index.docs().map((doc) => doc.key)).toEqual([rows[0]!.key, streamed[2]!.key]);
  });
});

describe("match locate, identity and wrap", () => {
  const events: TranscriptEvent[] = [
    { type: "text", text: "zebra and zebra", messageId: "reply-a", turnId: "turn-a" },
    { type: "user_message", text: "no match here" },
    { type: "text", text: "one zebra", messageId: "reply-b", turnId: "turn-b" },
    { type: "user_message", text: "later words" },
  ];

  it("maps each flat index to its row and occurrence, and back again", () => {
    const rows = transcriptRows(events);
    const matches = computeChatFindMatches(foldedIndex(rows).docs(), "zebra");
    expect(matches.total).toBe(3);
    expect(matches.entries).toEqual([
      { key: rows[0]!.key, count: 2, start: 0 },
      { key: rows[2]!.key, count: 1, start: 2 },
    ]);

    expect(chatFindMatchAt(matches, 0)).toEqual({ key: rows[0]!.key, occurrence: 0 });
    expect(chatFindMatchAt(matches, 1)).toEqual({ key: rows[0]!.key, occurrence: 1 });
    expect(chatFindMatchAt(matches, 2)).toEqual({ key: rows[2]!.key, occurrence: 0 });
    expect(chatFindMatchAt(matches, 3)).toBeNull();
    expect(chatFindMatchAt(matches, -1)).toBeNull();

    for (let index = 0; index < matches.total; index += 1) {
      expect(chatFindIndexOf(matches, chatFindMatchAt(matches, index)!)).toBe(index);
    }
    // An occurrence the row no longer has lands on its last one; a row without matches has none.
    expect(chatFindIndexOf(matches, { key: rows[0]!.key, occurrence: 9 })).toBe(1);
    expect(chatFindIndexOf(matches, { key: rows[1]!.key, occurrence: 0 })).toBeNull();
    expect(chatFindStartIndex(computeChatFindMatches([], "zebra"), 0, () => 0)).toBeNull();
  });

  it.each<{ label: string; fromOrder: number | null; expectedStart: number; expectedRow: number }>([
    { label: "no reader position starts at the first match", fromOrder: null, expectedStart: 0, expectedRow: 0 },
    { label: "a match in the row the reader is on starts there", fromOrder: 0, expectedStart: 0, expectedRow: 0 },
    { label: "a reader past the first match starts at the next match below", fromOrder: 1, expectedStart: 2, expectedRow: 2 },
    { label: "a reader on a later match row starts there", fromOrder: 2, expectedStart: 2, expectedRow: 2 },
    { label: "a reader below every match wraps to the first", fromOrder: 3, expectedStart: 0, expectedRow: 0 },
  ])("chatFindStartIndex: $label", ({ fromOrder, expectedStart, expectedRow }) => {
    const rows = transcriptRows(events);
    const matches = computeChatFindMatches(foldedIndex(rows).docs(), "zebra");
    const orderOf = (key: string) => {
      const position = rows.findIndex((row) => row.key === key);
      return position < 0 ? undefined : position;
    };
    const start = chatFindStartIndex(matches, fromOrder, orderOf);
    expect(matches.total).toBe(3);
    expect(start).toBe(expectedStart);
    expect(chatFindMatchAt(matches, start ?? -1)).toEqual({ key: rows[expectedRow]!.key, occurrence: 0 });
  });
});

describe("hand-off to a chat's find bar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a fresh hand-off once, to the session it was left for, and tells that transcript", () => {
    const notified: string[] = [];
    const stop = onPendingChatFind((sessionId) => notified.push(sessionId));
    setPendingChatFind("handoff-a", "zebra");
    expect(notified).toEqual(["handoff-a"]);
    expect(takePendingChatFind("handoff-b")).toBeNull();
    expect(takePendingChatFind("handoff-a")).toBe("zebra");
    expect(takePendingChatFind("handoff-a")).toBeNull();
    stop();
  });

  it.each<{ label: string; ageMs: number; taken: string | null }>([
    { label: "a hand-off nine seconds old is still taken", ageMs: 9_000, taken: "zebra" },
    { label: "a hand-off older than ten seconds is dropped, not replayed", ageMs: 10_001, taken: null },
  ])("$label", ({ ageMs, taken }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START_MS));
    const session = `ttl-${ageMs}`;
    setPendingChatFind(session, "zebra");
    vi.advanceTimersByTime(ageMs);
    expect(Date.now() - START_MS).toBe(ageMs);
    expect(takePendingChatFind(session)).toBe(taken);
    expect(takePendingChatFind(session)).toBeNull();
  });

  it("an empty query clears a pending hand-off and tells no transcript", () => {
    setPendingChatFind("clear-a", "zebra");
    const notified: string[] = [];
    const stop = onPendingChatFind((sessionId) => notified.push(sessionId));
    setPendingChatFind("clear-a", "   ");
    expect(notified).toEqual([]);
    expect(takePendingChatFind("clear-a")).toBeNull();
    expect(takePendingChatFind("clear-a")).toBeNull();
    stop();
  });
});
