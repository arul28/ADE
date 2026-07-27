import { describe, expect, it } from "vitest";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";
import {
  CHAT_TIMELINE_ROW_GAP_PX,
  CHAT_USER_MINIMAP_HIT_STRIP_MAX_WIDTH_PX,
  collectUserMessageMinimapSourceEntries,
  computeActiveFullUserOrdinal,
  computeRowStartOffsets,
  computeScrollTopForRow,
  isTimelineUserMessageRow,
  minimapHasPersistentGutter,
  minimapRailInert,
  resolveMinimapHitStripWidth,
  resolveMinimapIndexFromPointer,
  resolveMinimapPreviewTranslateY,
  resolveMinimapRailHeightStyle,
  resolveMinimapRailTopInset,
  resolveMinimapSideGutter,
  resolveMinimapTopPercent,
  resolveRowAnchorAtScrollTop,
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

function doneRow(status: "completed" | "interrupted" | "failed", key: string): ChatTranscriptGroupedEnvelope {
  return {
    key,
    timestamp: "2026-01-01T00:00:02.000Z",
    event: { type: "done", turnId: "t1", status },
  };
}

function statusRow(
  turnStatus: "started" | "completed" | "interrupted" | "failed",
  key: string,
): ChatTranscriptGroupedEnvelope {
  return {
    key,
    timestamp: "2026-01-01T00:00:02.000Z",
    event: { type: "status", turnStatus, turnId: "t1" },
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

  it("uses display text for hidden handoff prompts and skips empty hidden prompts", () => {
    const rows: ChatTranscriptGroupedEnvelope[] = [
      {
        key: "handoff-display",
        timestamp: "2026-01-01T00:00:00.000Z",
        event: {
          type: "user_message",
          text: "Internal handoff prompt that should not appear in the minimap.",
          displayText: "Chat handoff from previous session",
          metadata: { kind: "handoff", hideFullPrompt: true },
        },
      },
      {
        key: "handoff-hidden",
        timestamp: "2026-01-01T00:00:01.000Z",
        event: {
          type: "user_message",
          text: "Internal handoff prompt without display text.",
          metadata: { kind: "handoff", hideFullPrompt: true },
        },
      },
      userRow("normal prompt", "normal"),
    ];

    const entries = collectUserMessageMinimapSourceEntries(rows);

    expect(entries.map((entry) => entry.preview)).toEqual([
      "Chat handoff from previous session",
      "normal prompt",
    ]);
  });

  describe("assistantPreview", () => {
    it("takes the last assistant text before the next user row", () => {
      const rows: ChatTranscriptGroupedEnvelope[] = [
        userRow("ask", "u1"),
        textRow("first reply", "a1"),
        textRow("final reply", "a2"),
        doneRow("completed", "d1"),
        userRow("ask again", "u2"),
        textRow("second turn reply", "a3"),
        doneRow("completed", "d2"),
      ];
      const entries = collectUserMessageMinimapSourceEntries(rows);
      expect(entries.map((entry) => entry.assistantPreview)).toEqual([
        "final reply",
        "second turn reply",
      ]);
    });

    it("does not leak a later turn's reply into an earlier entry", () => {
      const rows: ChatTranscriptGroupedEnvelope[] = [
        userRow("ask", "u1"),
        userRow("ask again", "u2"),
        textRow("only reply", "a1"),
      ];
      const entries = collectUserMessageMinimapSourceEntries(rows);
      expect(entries[0]!.assistantPreview).toBeNull();
      expect(entries[1]!.assistantPreview).toBe("only reply");
    });

    it("collapses whitespace and truncates long replies", () => {
      const rows: ChatTranscriptGroupedEnvelope[] = [
        userRow("ask", "u1"),
        textRow(`  spread   over\nlines ${"x".repeat(300)}  `, "a1"),
      ];
      const preview = collectUserMessageMinimapSourceEntries(rows)[0]!.assistantPreview!;
      expect(preview.startsWith("spread over lines ")).toBe(true);
      expect(preview.endsWith("...")).toBe(true);
      expect(preview.length).toBe(223);
    });

    it("is null while the turn has produced no assistant text", () => {
      const rows: ChatTranscriptGroupedEnvelope[] = [userRow("ask", "u1")];
      expect(collectUserMessageMinimapSourceEntries(rows)[0]!.assistantPreview).toBeNull();
    });
  });

  describe("turnOutcome", () => {
    it("uses the last done row's status", () => {
      const failed = collectUserMessageMinimapSourceEntries([
        userRow("ask", "u1"),
        doneRow("completed", "d1"),
        doneRow("failed", "d2"),
      ]);
      expect(failed[0]!.turnOutcome).toBe("failed");

      const interrupted = collectUserMessageMinimapSourceEntries([
        userRow("ask", "u1"),
        doneRow("interrupted", "d1"),
      ]);
      expect(interrupted[0]!.turnOutcome).toBe("interrupted");
    });

    it("falls back to the last status row when no done row exists", () => {
      const entries = collectUserMessageMinimapSourceEntries([
        userRow("ask", "u1"),
        statusRow("started", "s1"),
        statusRow("interrupted", "s2"),
      ]);
      expect(entries[0]!.turnOutcome).toBe("interrupted");
    });

    it("prefers done over a trailing status row", () => {
      const entries = collectUserMessageMinimapSourceEntries([
        userRow("ask", "u1"),
        statusRow("completed", "s1"),
        doneRow("failed", "d1"),
      ]);
      expect(entries[0]!.turnOutcome).toBe("failed");
    });

    it("is null while the turn is still running", () => {
      const noSignal = collectUserMessageMinimapSourceEntries([
        userRow("ask", "u1"),
        textRow("thinking out loud", "a1"),
      ]);
      expect(noSignal[0]!.turnOutcome).toBeNull();

      const started = collectUserMessageMinimapSourceEntries([
        userRow("ask", "u1"),
        statusRow("started", "s1"),
      ]);
      expect(started[0]!.turnOutcome).toBeNull();
    });
  });

  describe("gutter geometry", () => {
    it("halves the leftover space around the measured column", () => {
      expect(resolveMinimapSideGutter(1200, 832)).toBe(184);
      expect(resolveMinimapSideGutter(900, 832)).toBe(34);
    });

    it("returns zero when the column fills or exceeds the list", () => {
      expect(resolveMinimapSideGutter(700, 832)).toBe(0);
      expect(resolveMinimapSideGutter(832, 832)).toBe(0);
      expect(resolveMinimapSideGutter(0, 832)).toBe(0);
      expect(resolveMinimapSideGutter(Number.NaN, 832)).toBe(0);
      expect(resolveMinimapSideGutter(1200, 0)).toBe(0);
      expect(resolveMinimapSideGutter(1200, Number.POSITIVE_INFINITY)).toBe(0);
    });

    it("clamps the hit strip to the gutter and to the max width", () => {
      // 184px gutter -> 172 uncapped, capped at 40.
      expect(resolveMinimapHitStripWidth(1200, 832)).toBe(CHAT_USER_MINIMAP_HIT_STRIP_MAX_WIDTH_PX);
      // 34px gutter -> 34 - 12 = 22.
      expect(resolveMinimapHitStripWidth(900, 832)).toBe(22);
    });

    it("returns 0 (inert rail) when there is no usable gutter", () => {
      expect(resolveMinimapHitStripWidth(700, 832)).toBe(0);
      // Gutter narrower than the 12px left offset must not go negative.
      expect(resolveMinimapHitStripWidth(844, 832)).toBe(0);
      expect(resolveMinimapHitStripWidth(0, 832)).toBe(0);
    });

    it("reports a persistent gutter only at/above 48px", () => {
      expect(minimapHasPersistentGutter(928, 832)).toBe(true);
      expect(minimapHasPersistentGutter(927, 832)).toBe(false);
      expect(minimapHasPersistentGutter(700, 832)).toBe(false);
    });
  });

  describe("resolveMinimapTopPercent", () => {
    it("spreads ticks across the rail", () => {
      expect(resolveMinimapTopPercent(0, 5)).toBe(0);
      expect(resolveMinimapTopPercent(2, 5)).toBe(50);
      expect(resolveMinimapTopPercent(4, 5)).toBe(100);
    });

    it("clamps out-of-range indexes and guards a single item", () => {
      expect(resolveMinimapTopPercent(9, 5)).toBe(100);
      expect(resolveMinimapTopPercent(-3, 5)).toBe(0);
      expect(resolveMinimapTopPercent(0, 1)).toBe(0);
      expect(resolveMinimapTopPercent(3, 1)).toBe(0);
    });
  });

  describe("resolveMinimapIndexFromPointer", () => {
    const rail = { railTop: 100, railHeight: 200 };

    it("rounds the pointer to the nearest tick", () => {
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 5, pointerY: 100 })).toBe(0);
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 5, pointerY: 200 })).toBe(2);
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 5, pointerY: 220 })).toBe(2);
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 5, pointerY: 300 })).toBe(4);
    });

    it("clamps above and below the rail", () => {
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 5, pointerY: -400 })).toBe(0);
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 5, pointerY: 5000 })).toBe(4);
    });

    it("returns null without a rail or items, and 0 for a single item", () => {
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 5, railHeight: 0, pointerY: 150 })).toBeNull();
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 0, pointerY: 150 })).toBeNull();
      expect(resolveMinimapIndexFromPointer({ ...rail, itemCount: 1, pointerY: 5000 })).toBe(0);
    });
  });

  it("resolveMinimapPreviewTranslateY anchors the first and last previews on-screen", () => {
    expect(resolveMinimapPreviewTranslateY(0, 5)).toBe("0%");
    expect(resolveMinimapPreviewTranslateY(2, 5)).toBe("-50%");
    expect(resolveMinimapPreviewTranslateY(4, 5)).toBe("-100%");
    expect(resolveMinimapPreviewTranslateY(0, 1)).toBe("0%");
  });

  describe("rail sizing", () => {
    it("caps the natural height to the available space", () => {
      // 21 ticks -> 160px natural, well under the 400 - 32 budget.
      expect(resolveMinimapRailHeightStyle(21, 400)).toBe("160px");
      // Same rail in a short column is capped at availablePx - 32.
      expect(resolveMinimapRailHeightStyle(21, 150)).toBe("118px");
      // Never collapses to zero.
      expect(resolveMinimapRailHeightStyle(1, 400)).toBe("1px");
      expect(resolveMinimapRailHeightStyle(21, 10)).toBe("1px");
    });

    it("minimapRailInert flips below 140px", () => {
      expect(minimapRailInert(140)).toBe(false);
      expect(minimapRailInert(139)).toBe(true);
      expect(minimapRailInert(0)).toBe(true);
    });

    it("resolveMinimapRailTopInset is 0 with no floating PR pane", () => {
      expect(resolveMinimapRailTopInset(null, 200)).toBe(0);
    });

    it("resolveMinimapRailTopInset subtracts the two viewport rects", () => {
      // REGRESSION: the pane is positioned against the chat surface and the rail
      // against the message-list root, which sits ~200px lower (header +
      // hairline). The inset is the RECT DELTA plus the gap — never
      // `pane top constant + pane height + gap`, which would read 12 + 260 + 12
      // = 284 here and push the rail a whole header-height too far down.
      expect(resolveMinimapRailTopInset(300, 200)).toBe(112);
      // Same pane, taller header: the inset shrinks by exactly the extra chrome.
      expect(resolveMinimapRailTopInset(300, 260)).toBe(52);
    });

    it("resolveMinimapRailTopInset never goes negative or NaN", () => {
      // Pane bottom above the list root (short pane under a tall header).
      expect(resolveMinimapRailTopInset(100, 200)).toBe(0);
      expect(resolveMinimapRailTopInset(Number.NaN, 200)).toBe(0);
      expect(resolveMinimapRailTopInset(300, Number.NaN)).toBe(0);
    });
  });

  describe("resolveRowAnchorAtScrollTop", () => {
    const offsets = computeRowStartOffsets(3, () => 40, 10); // [0, 50, 100]

    it("is the inverse of computeScrollTopForRow", () => {
      for (let index = 0; index < offsets.length; index += 1) {
        const anchor = resolveRowAnchorAtScrollTop(offsets, computeScrollTopForRow(index, offsets));
        expect(anchor).toEqual({ index, offsetPx: 0 });
      }
    });

    it("reports how far into the row the scroll position sits", () => {
      expect(resolveRowAnchorAtScrollTop(offsets, 20)).toEqual({ index: 0, offsetPx: 20 });
      expect(resolveRowAnchorAtScrollTop(offsets, 49)).toEqual({ index: 0, offsetPx: 49 });
      expect(resolveRowAnchorAtScrollTop(offsets, 51)).toEqual({ index: 1, offsetPx: 1 });
    });

    it("clamps past the end to the last row so a tail reader is restored there", () => {
      expect(resolveRowAnchorAtScrollTop(offsets, 500)).toEqual({ index: 2, offsetPx: 400 });
    });

    it("returns null with no rows", () => {
      expect(resolveRowAnchorAtScrollTop([], 0)).toBeNull();
    });
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

  it("computeScrollTopForRow returns offset for index", () => {
    const offsets = computeRowStartOffsets(4, (i) => 10 + i, 0);
    expect(computeScrollTopForRow(2, offsets)).toBe(offsets[2]);
  });
});
