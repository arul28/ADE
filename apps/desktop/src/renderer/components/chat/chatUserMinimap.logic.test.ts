import { describe, expect, it } from "vitest";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";
import {
  CHAT_TIMELINE_ROW_GAP_PX,
  CHAT_USER_MINIMAP_MAX_MARKERS,
  buildMinimapDisplayEntries,
  collectUserMessageMinimapSourceEntries,
  computeActiveDisplayIndex,
  computeActiveFullUserOrdinal,
  computeRowStartOffsets,
  computeScrollTopForRow,
  isTimelineUserMessageRow,
  sampleMinimapSourceEntries,
} from "./chatUserMinimap.logic";

function userRow(text: string, key: string, steerQueued = false): ChatTranscriptGroupedEnvelope {
  return {
    key,
    timestamp: "2026-01-01T00:00:00.000Z",
    event: steerQueued
      ? {
          type: "user_message",
          text,
          steerId: "s1",
          deliveryState: "queued",
        }
      : {
          type: "user_message",
          text,
          deliveryState: "delivered",
        },
  };
}

function textRow(text: string, key: string): ChatTranscriptGroupedEnvelope {
  return {
    key,
    timestamp: "2026-01-01T00:00:01.000Z",
    event: { type: "text", text, itemId: key, turnId: "t1" },
  };
}

describe("chatUserMinimap.logic", () => {
  it("skips queued steer-only user rows", () => {
    const rows: ChatTranscriptGroupedEnvelope[] = [
      userRow("hi", "u1", true),
      userRow("real", "u2", false),
    ];
    expect(isTimelineUserMessageRow(rows[0]!)).toBe(false);
    expect(isTimelineUserMessageRow(rows[1]!)).toBe(true);
    const entries = collectUserMessageMinimapSourceEntries(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.rowIndex).toBe(1);
  });

  it("collects user rows in order with ordinals", () => {
    const rows: ChatTranscriptGroupedEnvelope[] = [
      userRow("a", "u1"),
      textRow("assistant", "a1"),
      userRow("b", "u2"),
    ];
    const entries = collectUserMessageMinimapSourceEntries(rows);
    expect(entries.map((e) => e.rowIndex)).toEqual([0, 2]);
    expect(entries.map((e) => e.fullUserOrdinal)).toEqual([0, 1]);
  });

  it("samples when above max markers", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      rowIndex: i,
      key: `k${i}`,
      preview: `${i}`,
      fullUserOrdinal: i,
    }));
    const sampled = sampleMinimapSourceEntries(entries, CHAT_USER_MINIMAP_MAX_MARKERS);
    expect(sampled.length).toBeLessThanOrEqual(CHAT_USER_MINIMAP_MAX_MARKERS);
    expect(sampled[0]!.fullUserOrdinal).toBe(0);
    expect(sampled[sampled.length - 1]!.fullUserOrdinal).toBe(99);
  });

  it("computeRowStartOffsets matches fixed heights", () => {
    const h = () => 40;
    const offsets = computeRowStartOffsets(3, h, CHAT_TIMELINE_ROW_GAP_PX);
    expect(offsets).toEqual([0, 40 + CHAT_TIMELINE_ROW_GAP_PX, 2 * (40 + CHAT_TIMELINE_ROW_GAP_PX)]);
  });

  it("computeActiveFullUserOrdinal tracks scrollTop", () => {
    const rows: ChatTranscriptGroupedEnvelope[] = [userRow("a", "u1"), userRow("b", "u2")];
    const full = collectUserMessageMinimapSourceEntries(rows);
    const offsets = computeRowStartOffsets(2, () => 50, CHAT_TIMELINE_ROW_GAP_PX);
    expect(computeActiveFullUserOrdinal(0, full, offsets)).toBe(0);
    const secondTop = offsets[1] ?? 0;
    expect(computeActiveFullUserOrdinal(secondTop, full, offsets)).toBe(1);
  });

  it("computeActiveDisplayIndex clamps to sampled markers", () => {
    const display = [
      { rowIndex: 0, key: "0", preview: "", fullUserOrdinal: 0, displayOrdinal: 0 },
      { rowIndex: 10, key: "10", preview: "", fullUserOrdinal: 10, displayOrdinal: 1 },
      { rowIndex: 20, key: "20", preview: "", fullUserOrdinal: 20, displayOrdinal: 2 },
    ];
    expect(computeActiveDisplayIndex(5, display)).toBe(0);
    expect(computeActiveDisplayIndex(10, display)).toBe(1);
    expect(computeActiveDisplayIndex(99, display)).toBe(2);
  });

  it("buildMinimapDisplayEntries wires sampling", () => {
    const rows: ChatTranscriptGroupedEnvelope[] = Array.from({ length: 120 }, (_, i) =>
      userRow(`msg ${i}`, `u${i}`),
    );
    const display = buildMinimapDisplayEntries(rows, 80);
    expect(display.length).toBeLessThanOrEqual(80);
    const source = collectUserMessageMinimapSourceEntries(rows);
    expect(source.length).toBe(120);
  });

  it("computeScrollTopForRow returns offset for index", () => {
    const offsets = computeRowStartOffsets(4, (i) => 10 + i, 0);
    expect(computeScrollTopForRow(2, offsets)).toBe(offsets[2]);
  });
});
