import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import {
  advanceOlderHistoryCursor,
  captureTuiHistoryArrivalWatermark,
  mergeDetachedTuiHistoryTail,
  mergeHydratedTuiHistory,
  prependOlderTuiHistory,
  resolveSnapshotHistoryCursor,
  shouldRequestOlderTuiHistory,
  splitSnapshotForDisplay,
  takeNewestChunk,
  TUI_LOADED_EVENT_CAP,
  TUI_SNAPSHOT_DISPLAY_CAP,
} from "../olderHistory";

function envelope(
  sequence: number | null,
  overrides: Partial<AgentChatEventEnvelope> = {},
): AgentChatEventEnvelope {
  return {
    sessionId: "s1",
    timestamp: `2026-01-01T12:00:${String((sequence ?? 0) % 60).padStart(2, "0")}.000Z`,
    ...(sequence != null ? { sequence } : {}),
    event: { type: "text", text: `event ${String(sequence)}` },
    ...overrides,
  };
}

describe("prependOlderTuiHistory", () => {
  it("prepends an older page in front of the loaded transcript", () => {
    const existing = [envelope(10), envelope(11), envelope(12)];
    const older = [envelope(7), envelope(8), envelope(9)];

    const next = prependOlderTuiHistory(existing, older);

    expect(next.map((entry) => entry.sequence)).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it("returns the same array reference when the page is empty", () => {
    const existing = [envelope(10)];
    expect(prependOlderTuiHistory(existing, [])).toBe(existing);
  });

  it("dedupes exact duplicate seam events", () => {
    const existing = [envelope(9), envelope(10)];
    const older = [envelope(7), envelope(8), envelope(9)];

    const next = prependOlderTuiHistory(existing, older);

    expect(next.map((entry) => entry.sequence)).toEqual([7, 8, 9, 10]);
  });

  it("preserves distinct older events when provider-run sequences restart", () => {
    const existing = [
      envelope(0, {
        timestamp: "2026-01-01T12:10:00.000Z",
        event: { type: "text", text: "new run first message" },
      }),
      envelope(1, {
        timestamp: "2026-01-01T12:10:01.000Z",
        event: { type: "text", text: "new run second message" },
      }),
    ];
    const older = [
      envelope(0, {
        timestamp: "2026-01-01T11:59:00.000Z",
        event: { type: "text", text: "older run first message" },
      }),
      envelope(1, {
        timestamp: "2026-01-01T11:59:01.000Z",
        event: { type: "text", text: "older run second message" },
      }),
    ];

    const next = prependOlderTuiHistory(existing, older);

    expect(next.map((entry) => entry.event.type === "text" ? entry.event.text : "")).toEqual([
      "older run first message",
      "older run second message",
      "new run first message",
      "new run second message",
    ]);
  });

  it("returns the same array reference when every page event collides at the seam", () => {
    const existing = [envelope(9), envelope(10)];
    const older = [envelope(9)];

    expect(prependOlderTuiHistory(existing, older)).toBe(existing);
  });

  it("requires full event identity when sequences are missing", () => {
    const seamTwin = envelope(null, {
      timestamp: "2026-01-01T12:00:09.000Z",
      event: { type: "text", text: "tail copy" },
    });
    const existing = [seamTwin, envelope(10)];
    const older = [
      envelope(null, {
        timestamp: "2026-01-01T12:00:08.000Z",
        event: { type: "text", text: "older" },
      }),
      envelope(null, {
        timestamp: "2026-01-01T12:00:09.000Z",
        event: { type: "text", text: "tail copy" },
      }),
    ];

    const next = prependOlderTuiHistory(existing, older);

    // The 12:00:09 text event already exists at the seam; only the 12:00:08
    // event is prepended.
    expect(next).toHaveLength(3);
    expect(next[0]!.timestamp).toBe("2026-01-01T12:00:08.000Z");
  });

  it("dedupes repeated lines inside the page itself", () => {
    const existing = [envelope(10)];
    const older = [envelope(7), envelope(7), envelope(8)];

    const next = prependOlderTuiHistory(existing, older);

    expect(next.map((entry) => entry.sequence)).toEqual([7, 8, 10]);
  });

  it("keeps the newly loaded oldest window when the cap is exceeded", () => {
    const existing = [envelope(5), envelope(6), envelope(7)];
    const older = [envelope(1), envelope(2), envelope(3), envelope(4)];

    const next = prependOlderTuiHistory(existing, older, 5);

    expect(next.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(next).toHaveLength(5);
    expect(next.at(-1)?.sequence).toBe(5);
  });
});

describe("shouldRequestOlderTuiHistory", () => {
  it("backfills an underfilled viewport without waiting for a scroll gesture", () => {
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 0,
      scrollOffset: 0,
      bufferedEventCount: 0,
      cursor: { hasMore: true, loading: false },
      status: "available",
    })).toBe(true);
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 0,
      scrollOffset: 0,
      bufferedEventCount: 3,
      cursor: null,
      status: null,
    })).toBe(true);
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 0,
      scrollOffset: 0,
      bufferedEventCount: 0,
      cursor: null,
      status: "exhausted",
    })).toBe(false);
  });

  it("prefetches only near the loaded top and coalesces loading/error states", () => {
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 100,
      scrollOffset: 97,
      bufferedEventCount: 0,
      cursor: { hasMore: true, loading: false },
      status: "available",
    })).toBe(true);
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 100,
      scrollOffset: 50,
      bufferedEventCount: 0,
      cursor: { hasMore: true, loading: false },
      status: "available",
    })).toBe(false);
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 100,
      scrollOffset: 100,
      bufferedEventCount: 0,
      cursor: { hasMore: true, loading: true },
      status: "loading",
    })).toBe(false);
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 100,
      scrollOffset: 100,
      bufferedEventCount: 3,
      cursor: { hasMore: true, loading: false },
      status: "error",
    })).toBe(true);
    expect(shouldRequestOlderTuiHistory({
      scrollMaxOffset: 100,
      scrollOffset: 100,
      bufferedEventCount: 0,
      cursor: { hasMore: true, loading: false },
      status: "error",
    })).toBe(false);
  });
});

describe("mergeDetachedTuiHistoryTail", () => {
  it("rehydrates Latest from the fresh snapshot plus buffered live events", () => {
    const duplicatedSeam = envelope(100);
    const merged = mergeDetachedTuiHistoryTail(
      [envelope(98), envelope(99), duplicatedSeam],
      [duplicatedSeam, envelope(101)],
    );

    expect(merged.map((entry) => entry.sequence)).toEqual([98, 99, 100, 101]);
    expect(merged).toHaveLength(4);
    expect(merged.filter((entry) => entry.sequence === 100)).toHaveLength(1);
    expect(merged.at(-1)?.sequence).toBe(101);
  });

  it("places delayed live output before a later terminal event", () => {
    const merged = mergeDetachedTuiHistoryTail(
      [envelope(10, { timestamp: "2026-01-01T12:10:00.000Z" })],
      [
        envelope(12, {
          timestamp: "2026-01-01T12:12:00.000Z",
          event: { type: "done", turnId: "turn-1", status: "completed" },
        }),
        envelope(11, { timestamp: "2026-01-01T12:11:00.000Z" }),
      ],
    );

    expect(merged.map((entry) => entry.sequence)).toEqual([10, 11, 12]);
  });
});

describe("mergeHydratedTuiHistory", () => {
  it("keeps scrollback ordered and drops a replayed old turn after the latest tail", () => {
    const older = envelope(10, { timestamp: "2026-01-01T12:00:00.000Z" });
    const latest = envelope(20, { timestamp: "2026-01-01T12:20:00.000Z" });
    const replayedOldTurn = envelope(11, { timestamp: "2026-01-01T12:05:00.000Z" });
    const genuinelyLive = envelope(21, { timestamp: "2026-01-01T12:21:00.000Z" });

    const merged = mergeHydratedTuiHistory(
      [{ ...latest }],
      [older, latest, replayedOldTurn],
      [genuinelyLive],
      captureTuiHistoryArrivalWatermark([older, latest, replayedOldTurn]),
    );

    expect(merged.map((entry) => entry.sequence)).toEqual([10, 20, 21]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(latest);
    expect(merged[2]).toBe(genuinelyLive);
  });

  it("uses the TUI semantic identity when a replay changes transport metadata", () => {
    const older = envelope(9, {
      timestamp: "2026-01-01T12:09:00.000Z",
      event: { type: "text", text: "older scrollback" },
    });
    const originalPrompt = envelope(10, {
      timestamp: "2026-01-01T12:10:00.000Z",
      event: { type: "user_message", text: "ship it", turnId: "turn-1", messageId: "message-1" },
    });
    const replayedPrompt = envelope(99, {
      timestamp: "2026-01-01T12:10:05.000Z",
      event: { type: "user_message", text: "ship it", turnId: "turn-1", messageId: "message-1" },
    });

    const merged = mergeHydratedTuiHistory(
      [replayedPrompt],
      [older, originalPrompt],
      [],
      captureTuiHistoryArrivalWatermark([older, originalPrompt]),
    );

    expect(merged).toEqual([older, originalPrompt]);
  });

  it("preserves delayed live output flushed while hydration is in flight", () => {
    const prompt = envelope(10, {
      timestamp: "2026-01-01T12:10:00.000Z",
      event: { type: "user_message", text: "ship it", turnId: "turn-1", messageId: "message-1" },
    });
    const done = envelope(12, {
      timestamp: "2026-01-01T12:12:00.000Z",
      event: { type: "done", turnId: "turn-1", status: "completed" },
    });
    const staleReplay = envelope(9, {
      timestamp: "2026-01-01T12:09:00.000Z",
      event: { type: "text", text: "stale replay" },
    });
    const delayedPending = envelope(11, {
      timestamp: "2026-01-01T12:11:00.000Z",
      event: { type: "text", text: "delayed pending output" },
    });

    const existingAtRequestStart = [prompt, done, staleReplay];
    const arrivalWatermark = captureTuiHistoryArrivalWatermark(existingAtRequestStart);
    const pending = [delayedPending];
    const existingAtMerge = [...existingAtRequestStart, ...pending.splice(0)];

    expect(pending).toEqual([]);
    const merged = mergeHydratedTuiHistory(
      [{ ...prompt }, { ...done }],
      existingAtMerge,
      pending,
      arrivalWatermark,
    );

    expect(merged).toEqual([prompt, delayedPending, done]);
    expect(merged[1]).toBe(delayedPending);
  });

  it("caps a large hydrated merge while preserving the chronological newest tail", () => {
    const existingCount = TUI_LOADED_EVENT_CAP + 25;
    const existing = Array.from({ length: existingCount }, (_, index) => {
      const sequence = index + 1;
      return envelope(sequence, {
        timestamp: new Date(Date.UTC(2026, 0, 1) + sequence).toISOString(),
      });
    });
    const snapshotTail = existing.slice(-TUI_SNAPSHOT_DISPLAY_CAP);
    const pending = Array.from({ length: 10 }, (_, index) => {
      const sequence = existingCount + index + 1;
      return envelope(sequence, {
        timestamp: new Date(Date.UTC(2026, 0, 1) + sequence).toISOString(),
      });
    });

    const merged = mergeHydratedTuiHistory(
      snapshotTail,
      existing,
      pending,
      captureTuiHistoryArrivalWatermark(existing),
    );

    expect(merged).toHaveLength(TUI_LOADED_EVENT_CAP);
    expect(merged[0]?.sequence).toBe(existingCount + pending.length - TUI_LOADED_EVENT_CAP + 1);
    expect(merged.at(-1)?.sequence).toBe(existingCount + pending.length);
    expect(merged.every((entry, index) => (
      index === 0 || entry.sequence === (merged[index - 1]?.sequence ?? 0) + 1
    ))).toBe(true);
  });
});

describe("splitSnapshotForDisplay", () => {
  function snapshot(count: number): AgentChatEventEnvelope[] {
    return Array.from({ length: count }, (_, index) => envelope(index + 1));
  }

  it("keeps small snapshots fully displayed with an empty buffer", () => {
    const events = snapshot(120);
    const { display, buffer } = splitSnapshotForDisplay(events);
    expect(display.map((entry) => entry.sequence)).toEqual(events.map((entry) => entry.sequence));
    expect(buffer).toEqual([]);
  });

  it("treats a snapshot of exactly the display cap as fully displayed", () => {
    const events = snapshot(TUI_SNAPSHOT_DISPLAY_CAP);
    const { display, buffer } = splitSnapshotForDisplay(events);
    expect(display).toHaveLength(TUI_SNAPSHOT_DISPLAY_CAP);
    expect(buffer).toEqual([]);
  });

  it("splits an oversized snapshot contiguously with no overlap and no gap", () => {
    const events = snapshot(1_250);
    const { display, buffer } = splitSnapshotForDisplay(events);

    expect(display).toHaveLength(TUI_SNAPSHOT_DISPLAY_CAP);
    expect(buffer).toHaveLength(1_250 - TUI_SNAPSHOT_DISPLAY_CAP);
    // Sequence continuity across the buffer→display seam: the buffer's newest
    // event is exactly one older than the display's oldest event.
    expect(buffer.at(-1)!.sequence! + 1).toBe(display[0]!.sequence!);
    // No overlap, no gap end-to-end.
    expect([...buffer, ...display].map((entry) => entry.sequence)).toEqual(
      events.map((entry) => entry.sequence),
    );
  });

  it("caps the buffer at its limit, keeping the NEWEST buffered events", () => {
    const events = snapshot(20);
    const { display, buffer } = splitSnapshotForDisplay(events, 5, 10);
    expect(display.map((entry) => entry.sequence)).toEqual([16, 17, 18, 19, 20]);
    expect(buffer.map((entry) => entry.sequence)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    // Even when capped, the buffer stays contiguous at the display seam (the
    // capped-away events are the OLDEST, beyond the buffer's reach).
    expect(buffer.at(-1)!.sequence! + 1).toBe(display[0]!.sequence!);
  });
});

describe("takeNewestChunk", () => {
  it("drains the newest buffered chunk first and stays contiguous across drains", () => {
    const buffer = Array.from({ length: 1_100 }, (_, index) => envelope(index + 1));
    const display = [envelope(1_101), envelope(1_102)];

    const first = takeNewestChunk(buffer);
    expect(first.chunk).toHaveLength(TUI_SNAPSHOT_DISPLAY_CAP);
    // First drain is adjacent to the displayed oldest event.
    expect(first.chunk.at(-1)!.sequence! + 1).toBe(display[0]!.sequence!);
    const afterFirst = prependOlderTuiHistory(display, first.chunk);
    expect(afterFirst[0]!.sequence).toBe(601);
    expect(afterFirst.at(-1)!.sequence).toBe(1_102);

    const second = takeNewestChunk(first.rest);
    // Second drain is adjacent to the first drain's oldest event.
    expect(second.chunk.at(-1)!.sequence! + 1).toBe(first.chunk[0]!.sequence!);
    const afterSecond = prependOlderTuiHistory(afterFirst, second.chunk);
    expect(afterSecond.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 1_002 }, (_, index) => index + 101),
    );

    const third = takeNewestChunk(second.rest);
    expect(third.chunk).toHaveLength(100);
    expect(third.rest).toEqual([]);
    const afterThird = prependOlderTuiHistory(afterSecond, third.chunk);
    // Fully drained: display ← buffer reconstructs the entire snapshot with
    // no overlap and no gap.
    expect(afterThird.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 1_102 }, (_, index) => index + 1),
    );
  });

  it("returns the whole buffer when smaller than the chunk size", () => {
    const buffer = [envelope(1), envelope(2)];
    const { chunk, rest } = takeNewestChunk(buffer);
    expect(chunk.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(rest).toEqual([]);
  });
});

describe("resolveSnapshotHistoryCursor", () => {
  it("seeds the byte cursor from tailStartOffset when older history exists", () => {
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true, tailStartOffset: 4096 })).toBe(4096);
  });

  it("refuses to seed a cursor when the host says there is nothing older", () => {
    // The regression: an untruncated transcript whose first physical lines
    // carry no parent-visible event still reports tailStartOffset > 0, which
    // used to arm a "load earlier…" affordance that could only come back empty.
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: false, tailStartOffset: 4096 })).toBe(0);
  });

  it("falls back to the legacy offset-only rule when the host omits the field", () => {
    expect(resolveSnapshotHistoryCursor({ tailStartOffset: 4096 })).toBe(4096);
    expect(resolveSnapshotHistoryCursor({ tailStartOffset: 0 })).toBe(0);
    expect(resolveSnapshotHistoryCursor({ tailStartOffset: null })).toBe(0);
    expect(resolveSnapshotHistoryCursor({})).toBe(0);
  });

  it("ignores a non-finite or negative offset", () => {
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true, tailStartOffset: Number.NaN })).toBe(0);
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true, tailStartOffset: -1 })).toBe(0);
  });

  it("does not invent a cursor when older history exists but no offset was reported", () => {
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true, tailStartOffset: null })).toBe(0);
  });
});

describe("advanceOlderHistoryCursor", () => {
  it("advances to the page's startOffset while more history remains", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 2048, hasMore: true },
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: true });
  });

  it("ends paging when the server reports no more history", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 0, hasMore: false },
    );
    expect(next).toEqual({ beforeOffset: 0, hasMore: false });
  });

  it("ends paging when the head of the transcript is reached even if hasMore lies", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 0, hasMore: true },
    );
    expect(next).toEqual({ beforeOffset: 0, hasMore: false });
  });

  it("defensively ends paging when the cursor does not strictly decrease", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 2048, hasMore: true },
      { startOffset: 2048, hasMore: true },
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: false });
  });

  it("ends paging when the session is gone", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 2048, hasMore: true },
      { startOffset: 1024, hasMore: true, sessionFound: false },
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: false });
  });

  it("preserves the cursor when the runtime is temporarily unavailable", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 0, hasMore: false, sessionFound: false, unavailable: true },
    );
    expect(next).toEqual({ beforeOffset: 4096, hasMore: true });
    expect(next.beforeOffset).toBe(4096);
    expect(next.hasMore).toBe(true);
  });

  it("keeps paging with a sliding resident window once the cap is reached", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 2048, hasMore: true },
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: true });
    expect(next.beforeOffset).toBeLessThan(4096);
    expect(next.hasMore).toBe(true);
  });
});
