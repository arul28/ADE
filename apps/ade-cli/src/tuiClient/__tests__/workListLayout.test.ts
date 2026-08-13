import { describe, expect, it } from "vitest";
import {
  WORK_LIST_HEADER_ROWS,
  computeWorkListLayout,
  workListHitRects,
  workListMouseHitForLayout,
  workListRowHeight,
  workListRowMarginTop,
} from "../workListLayout";
import type { WorkListRow, WorkListSessionRow } from "../workListModel";

function laneHeader(id: string): WorkListRow {
  return {
    kind: "lane-header",
    key: `lane:${id}`,
    laneId: id,
    label: id,
    color: null,
    icon: null,
    tier: "active",
    machine: null,
    sessionCount: 1,
    lastSeenLabel: null,
    worktreeAvailable: true,
  };
}

function sessionRow(id: string, overrides: Partial<WorkListSessionRow> = {}): WorkListSessionRow {
  return {
    kind: "session",
    key: `session:${id}`,
    sessionId: id,
    laneId: "lane-1",
    laneName: "Feature",
    machine: null,
    title: id,
    status: { label: "Working", tone: "blue", glyph: "working", showsElapsed: true, prominent: false },
    tone: "blue",
    glyph: "working",
    elapsedLabel: "3m",
    timestampLabel: null,
    preview: { text: "building", linkify: false, source: "output" },
    ageLabel: "2m",
    activityAt: "2026-05-12T11:58:00.000Z",
    provider: "claude",
    hasDraft: false,
    filing: "running",
    isActiveSession: false,
    marker: null,
    showLaneIdentity: false,
    laneColor: null,
    laneIcon: null,
    ...overrides,
  };
}

const newChat: WorkListRow = { kind: "new-chat", key: "new-chat:lane-1", laneId: "lane-1" };
const shelf: WorkListRow = { kind: "shelf", key: "shelf:settled", shelf: "settled", count: 2, expanded: false };

describe("workListRowHeight", () => {
  it("charges a session card three lines, matching the desktop SessionCard", () => {
    expect(workListRowHeight(sessionRow("full"))).toBe(3);
    expect(workListRowHeight(sessionRow("no-preview", { preview: null }))).toBe(3);
    expect(workListRowHeight(sessionRow("bare", {
      preview: null,
      ageLabel: "",
      provider: null,
      hasDraft: false,
      machine: null,
    }))).toBe(3);
  });

  it("gives every non-session entry exactly one line", () => {
    expect(workListRowHeight(laneHeader("lane-1"))).toBe(1);
    expect(workListRowHeight(newChat)).toBe(1);
    expect(workListRowHeight(shelf)).toBe(1);
  });

  it("breathes above every row except the first", () => {
    expect(workListRowMarginTop(laneHeader("lane-1"), true)).toBe(0);
    expect(workListRowMarginTop(laneHeader("lane-2"), false)).toBe(1);
    expect(workListRowMarginTop(shelf, false)).toBe(1);
    expect(workListRowMarginTop(sessionRow("a"), false)).toBe(1);
    expect(workListRowMarginTop(sessionRow("solo", { showLaneIdentity: true }), false)).toBe(1);
    expect(workListRowMarginTop(newChat, false)).toBe(1);
  });
});

describe("computeWorkListLayout", () => {
  const rows: WorkListRow[] = [
    laneHeader("lane-1"),
    sessionRow("a"),
    sessionRow("b"),
    newChat,
    laneHeader("lane-2"),
    sessionRow("c"),
  ];

  it("places rows under the pane chrome with the margins it charged for", () => {
    const layout = computeWorkListLayout({ panelHeight: 40, rows });

    expect(layout.placements.map((entry) => [entry.key, entry.y, entry.height])).toEqual([
      ["lane:lane-1", WORK_LIST_HEADER_ROWS + 1, 1],
      ["session:a", WORK_LIST_HEADER_ROWS + 3, 3],
      ["session:b", WORK_LIST_HEADER_ROWS + 7, 3],
      ["new-chat:lane-1", WORK_LIST_HEADER_ROWS + 11, 1],
      ["lane:lane-2", WORK_LIST_HEADER_ROWS + 13, 1],
      ["session:c", WORK_LIST_HEADER_ROWS + 15, 3],
    ]);
    expect(layout.hiddenBefore).toBe(0);
    expect(layout.hiddenAfter).toBe(0);
  });

  it("stops placing rows once the body is full and reports the remainder", () => {
    const layout = computeWorkListLayout({ panelHeight: 9, rows });

    expect(layout.bodyRows).toBe(6);
    // A third entry would need line 7 of a 6-line body, so it is not placed.
    expect(layout.placements.map((entry) => entry.key)).toEqual(["lane:lane-1", "session:a"]);
    expect(layout.hiddenAfter).toBe(4);
  });

  it("never leaves the selected row outside the window", () => {
    const above = computeWorkListLayout({ panelHeight: 9, rows, scrollOffsetRows: 3, selectedIndex: 0 });
    expect(above.placements[0]!.key).toBe("lane:lane-1");

    const below = computeWorkListLayout({ panelHeight: 9, rows, scrollOffsetRows: 0, selectedIndex: 5 });
    expect(below.placements.some((entry) => entry.index === 5)).toBe(true);
    expect(below.hiddenBefore).toBeGreaterThan(0);
  });

  it("still renders one row when the body is shorter than a single card", () => {
    const layout = computeWorkListLayout({ panelHeight: 4, rows: [sessionRow("tall")] });
    expect(layout.placements).toHaveLength(1);
    expect(layout.placements[0]!.height).toBeGreaterThanOrEqual(1);
  });

  it("shifts placements down by the scroll hint so mouse hits stay on the painted card", () => {
    const layout = computeWorkListLayout({ panelHeight: 40, rows, scrollOffsetRows: 1 });
    expect(layout.hiddenBefore).toBe(1);
    expect(layout.placements[0]!.key).toBe("session:a");
    expect(layout.placements[0]!.y).toBe(WORK_LIST_HEADER_ROWS + 2);
  });

  it("handles an empty list without inventing a placement", () => {
    const layout = computeWorkListLayout({ panelHeight: 20, rows: [] });
    expect(layout.placements).toEqual([]);
    expect(layout.hiddenAfter).toBe(0);
  });
});

describe("workListMouseHitForLayout", () => {
  const rows: WorkListRow[] = [laneHeader("lane-1"), sessionRow("a"), sessionRow("b"), newChat];
  const layout = computeWorkListLayout({ panelHeight: 40, rows });

  it("resolves every drawn line back to the entry the renderer drew there", () => {
    // The correspondence the two sides must agree on: for each placement, every
    // line it owns maps back to it and to nothing else.
    for (const placement of layout.placements) {
      for (let offset = 0; offset < placement.height; offset += 1) {
        expect(workListMouseHitForLayout({ y: placement.y + offset, layout })).toEqual({
          kind: "row",
          index: placement.index,
          key: placement.key,
          region: "body",
        });
      }
    }
  });

  it("returns null for chrome, margins, and off-pane rows", () => {
    expect(workListMouseHitForLayout({ y: null, layout })).toBeNull();
    expect(workListMouseHitForLayout({ y: 1, layout })).toBeNull();
    expect(workListMouseHitForLayout({ y: WORK_LIST_HEADER_ROWS, layout })).toBeNull();
    const last = layout.placements[layout.placements.length - 1]!;
    expect(workListMouseHitForLayout({ y: last.y + last.height + 5, layout })).toBeNull();
  });

  it("maps a click on ANY of a card's lines to that card", () => {
    const card = layout.placements.find((entry) => entry.key === "session:a")!;
    expect(card.height).toBe(3);
    const hits = [0, 1, 2].map((offset) => workListMouseHitForLayout({ y: card.y + offset, layout })?.key);
    expect(new Set(hits)).toEqual(new Set(["session:a"]));
  });

  it("treats a singleton card's first line as the lane identity", () => {
    const solo = sessionRow("solo", { showLaneIdentity: true, laneName: "Feature" });
    const soloLayout = computeWorkListLayout({ panelHeight: 20, rows: [solo] });
    const card = soloLayout.placements[0]!;
    expect(workListMouseHitForLayout({ y: card.y, layout: soloLayout })).toEqual({
      kind: "row",
      index: 0,
      key: "session:solo",
      region: "lane-identity",
    });
    expect(workListMouseHitForLayout({ y: card.y + 1, layout: soloLayout })?.region).toBe("body");
    expect(workListMouseHitForLayout({ y: card.y + 2, layout: soloLayout })?.region).toBe("body");
  });
});

describe("workListHitRects", () => {
  const rows: WorkListRow[] = [laneHeader("lane-1"), sessionRow("a")];
  const layout = computeWorkListLayout({ panelHeight: 30, rows });

  it("emits one screen rect per entry, aligned with the layout it came from", () => {
    const rects = workListHitRects({ layout, paneTopRow: 5, paneLeft: 1, paneWidth: 36 });

    expect(rects.map((entry) => [entry.key, entry.region])).toEqual([
      ["lane:lane-1", "body"],
      ["session:a", "body"],
    ]);
    expect(rects[0]!.rect).toEqual({ x: 1, y: 5 + WORK_LIST_HEADER_ROWS, w: 36, h: 1 });
    expect(rects[1]!.rect).toEqual({ x: 1, y: 5 + WORK_LIST_HEADER_ROWS + 2, w: 36, h: 3 });
  });

  it("keeps the rect and the mouse hit in agreement for every entry", () => {
    const paneTopRow = 5;
    for (const entry of workListHitRects({ layout, paneTopRow, paneLeft: 1, paneWidth: 36 })) {
      const localY = entry.rect.y - paneTopRow + 1;
      const hit = workListMouseHitForLayout({ y: localY, layout });
      expect(hit?.key).toBe(entry.key);
      expect(hit?.region).toBe(entry.region);
    }
  });

  it("splits a singleton card so the lane name is its own hit target", () => {
    const solo = sessionRow("solo", { showLaneIdentity: true });
    const soloLayout = computeWorkListLayout({ panelHeight: 20, rows: [solo] });
    const rects = workListHitRects({ layout: soloLayout, paneTopRow: 5, paneLeft: 1, paneWidth: 36 });
    expect(rects.map((entry) => [entry.region, entry.rect.h])).toEqual([
      ["lane-identity", 1],
      ["body", 2],
    ]);
  });
});
