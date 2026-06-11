import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import {
  advanceOlderHistoryCursor,
  prependOlderTuiHistory,
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

  it("dedupes the seam by sequence", () => {
    const existing = [envelope(9), envelope(10)];
    const older = [envelope(7), envelope(8), envelope(9)];

    const next = prependOlderTuiHistory(existing, older);

    expect(next.map((entry) => entry.sequence)).toEqual([7, 8, 9, 10]);
  });

  it("returns the same array reference when every page event collides at the seam", () => {
    const existing = [envelope(9), envelope(10)];
    const older = [envelope(9)];

    expect(prependOlderTuiHistory(existing, older)).toBe(existing);
  });

  it("falls back to timestamp + event type identity when sequences are missing", () => {
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
        event: { type: "text", text: "tail copy (older read)" },
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

  it("keeps the newest events when the cap is exceeded", () => {
    const existing = [envelope(5), envelope(6), envelope(7)];
    const older = [envelope(1), envelope(2), envelope(3), envelope(4)];

    const next = prependOlderTuiHistory(existing, older, 5);

    expect(next.map((entry) => entry.sequence)).toEqual([3, 4, 5, 6, 7]);
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

describe("advanceOlderHistoryCursor", () => {
  it("advances to the page's startOffset while more history remains", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 2048, hasMore: true },
      100,
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: true });
  });

  it("ends paging when the server reports no more history", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 0, hasMore: false },
      100,
    );
    expect(next).toEqual({ beforeOffset: 0, hasMore: false });
  });

  it("ends paging when the head of the transcript is reached even if hasMore lies", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 0, hasMore: true },
      100,
    );
    expect(next).toEqual({ beforeOffset: 0, hasMore: false });
  });

  it("defensively ends paging when the cursor does not strictly decrease", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 2048, hasMore: true },
      { startOffset: 2048, hasMore: true },
      100,
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: false });
  });

  it("ends paging when the session is gone", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 2048, hasMore: true },
      { startOffset: 1024, hasMore: true, sessionFound: false },
      100,
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: false });
  });

  it("ends paging once the resident event cap is reached", () => {
    const next = advanceOlderHistoryCursor(
      { beforeOffset: 4096, hasMore: true },
      { startOffset: 2048, hasMore: true },
      TUI_LOADED_EVENT_CAP,
    );
    expect(next).toEqual({ beforeOffset: 2048, hasMore: false });
  });
});
