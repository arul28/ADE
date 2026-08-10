import { describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope, AgentChatEventHistoryPage } from "../../../shared/types";
import { readOlderHistoryBatch } from "./chatHistoryWindow";

const SESSION_ID = "session-1";

function envelope(type: string, index: number): AgentChatEventEnvelope {
  return {
    sessionId: SESSION_ID,
    timestamp: `2026-03-17T10:00:${String(index).padStart(2, "0")}.000Z`,
    event: { type, text: `e${index}`, turnId: "turn-1" },
  } as never;
}

/** Pages are keyed by the cursor they are requested with. */
function pager(pages: Record<number, Partial<AgentChatEventHistoryPage>>) {
  return vi.fn(async (beforeOffset: number): Promise<AgentChatEventHistoryPage> => ({
    sessionId: SESSION_ID,
    sessionFound: true,
    events: [],
    startOffset: 0,
    hasMore: false,
    ...pages[beforeOffset],
  } as AgentChatEventHistoryPage));
}

describe("readOlderHistoryBatch turn anchoring", () => {
  const isCurrent = () => true;

  it("keeps paging until the span starts on a user turn", async () => {
    // Byte-cut pages mean a page can be nothing but superseded deltas of one
    // streamed reply. Returning at the first non-empty page left the reader
    // staring at a load that added no visible content.
    const readPage = pager({
      300: { events: [envelope("text", 3)], startOffset: 200, hasMore: true },
      200: { events: [envelope("text", 2)], startOffset: 100, hasMore: true },
      100: { events: [envelope("user_message", 1)], startOffset: 50, hasMore: true },
    });

    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent,
    });

    expect(readPage).toHaveBeenCalledTimes(3);
    expect(batch?.events.map((entry) => entry.event.type)).toEqual([
      "user_message",
      "text",
      "text",
    ]);
    expect(batch?.nextCursor).toBe(50);
  });

  it("stops immediately when the first page already starts on a turn", async () => {
    const readPage = pager({
      300: { events: [envelope("user_message", 1), envelope("text", 2)], startOffset: 100, hasMore: true },
    });

    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent,
    });

    expect(readPage).toHaveBeenCalledTimes(1);
    expect(batch?.events).toHaveLength(2);
  });

  it("stops at the head of the transcript", async () => {
    const readPage = pager({
      300: { events: [envelope("text", 3)], startOffset: 0, hasMore: false },
    });

    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent,
    });

    expect(readPage).toHaveBeenCalledTimes(1);
    expect(batch).toEqual({ events: [envelope("text", 3)], nextCursor: 0 });
  });

  it("gives up after the page budget rather than reading unboundedly", async () => {
    // A transcript with no user turn in reach must not turn one scroll into an
    // unbounded read; the next scroll continues from the returned cursor.
    const readPage = vi.fn(async (beforeOffset: number): Promise<AgentChatEventHistoryPage> => ({
      sessionId: SESSION_ID,
      sessionFound: true,
      events: [envelope("text", beforeOffset)],
      startOffset: beforeOffset - 10,
      hasMore: true,
    } as AgentChatEventHistoryPage));

    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent,
      maxPages: 3,
    });

    expect(readPage).toHaveBeenCalledTimes(3);
    expect(batch?.events).toHaveLength(3);
    expect(batch?.nextCursor).toBe(270);
  });

  it("stops extending once enough events are loaded without a turn boundary", async () => {
    const readPage = vi.fn(async (beforeOffset: number): Promise<AgentChatEventHistoryPage> => ({
      sessionId: SESSION_ID,
      sessionFound: true,
      events: [envelope("text", 1), envelope("text", 2)],
      startOffset: beforeOffset - 10,
      hasMore: true,
    } as AgentChatEventHistoryPage));

    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent,
      maxAnchorEvents: 3,
    });

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(batch?.events).toHaveLength(4);
  });

  it("still skips empty pages that only advance the cursor", async () => {
    const readPage = pager({
      300: { events: [], startOffset: 200, hasMore: true },
      200: { events: [], startOffset: 100, hasMore: true },
      100: { events: [envelope("user_message", 1)], startOffset: 0, hasMore: false },
    });

    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent,
    });

    expect(batch?.events).toHaveLength(1);
    expect(batch?.nextCursor).toBe(0);
  });

  it("drops events belonging to another session", async () => {
    const foreign = { ...envelope("text", 9), sessionId: "other" } as AgentChatEventEnvelope;
    const readPage = pager({
      300: { events: [envelope("user_message", 1), foreign], startOffset: 100, hasMore: true },
    });

    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent,
    });

    expect(batch?.events).toHaveLength(1);
  });

  it("aborts when the request is no longer current", async () => {
    const readPage = pager({ 300: { events: [envelope("text", 1)], startOffset: 100, hasMore: true } });
    const batch = await readOlderHistoryBatch({
      sessionId: SESSION_ID,
      beforeOffset: 300,
      readPage,
      isCurrent: () => false,
    });
    expect(batch).toBeNull();
  });

  it("throws when the cursor fails to advance", async () => {
    const readPage = pager({ 300: { events: [], startOffset: 300, hasMore: true } });
    await expect(
      readOlderHistoryBatch({ sessionId: SESSION_ID, beforeOffset: 300, readPage, isCurrent }),
    ).rejects.toThrow(/cursor did not advance/);
  });
});
