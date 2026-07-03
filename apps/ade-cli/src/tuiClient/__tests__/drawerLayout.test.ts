import { describe, expect, it } from "vitest";
import {
  computeDrawerLayout,
  drawerLaneWindow,
  drawerMouseHitForLayout,
  type DrawerLaneInput,
} from "../drawerLayout";

function laneInput(laneId: string, chatCount: number, overrides: Partial<DrawerLaneInput> = {}): DrawerLaneInput {
  return { laneId, chatCount, worktreeAvailable: true, ...overrides };
}

describe("computeDrawerLayout", () => {
  it("expands the selected lane's chats and previews every other lane's chats", () => {
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 2), laneInput("b", 5), laneInput("c", 0)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.laneStart).toBe(0);
    expect(layout.lanes[0]).toMatchObject({ expanded: true, visibleChatCount: 2, moreCount: 0 });
    // Non-selected lanes now show all their chats too (budget permitting), not a
    // cap of 3 — so lane b shows all 5 with no "+N more".
    expect(layout.lanes[1]).toMatchObject({ expanded: false, visibleChatCount: 5, moreCount: 0 });
    // Empty lanes get no preview rows.
    expect(layout.lanes[2]).toMatchObject({ expanded: false, visibleChatCount: 0, moreCount: 0 });
  });

  it("shows a +N more row when the row budget can't fit every preview chat", () => {
    // panelHeight 20 → budget 6: the expanded lane reserves its new-chat row,
    // leaving room for only 4 of lane b's 10 chats plus a "+6 more" row.
    const layout = computeDrawerLayout({
      panelHeight: 20,
      lanes: [laneInput("a", 0), laneInput("b", 10)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.lanes[1]).toMatchObject({ visibleChatCount: 4, moreCount: 6 });
  });

  it("drops compact previews when the panel has no leftover rows", () => {
    // 5 lanes at base cost 4 rows on a 26-row panel: zero leftover.
    const layout = computeDrawerLayout({
      panelHeight: 26,
      lanes: [laneInput("a", 1), laneInput("b", 4), laneInput("c", 4), laneInput("d", 4), laneInput("e", 4)],
      expandedLaneIndex: null,
      selectedLaneIndex: null,
      scrollOffsetRows: 0,
    });
    for (const plan of layout.lanes) {
      expect(plan.visibleChatCount).toBe(0);
      expect(plan.moreCount).toBe(0);
    }
  });

  it("clamps the scroll window and keeps absolute lane indexes", () => {
    const lanes = Array.from({ length: 20 }, (_, i) => laneInput(`lane-${i}`, 0));
    const layout = computeDrawerLayout({
      panelHeight: 24, // window of (24-6)/4 = 4 lanes
      lanes,
      expandedLaneIndex: null,
      selectedLaneIndex: null,
      scrollOffsetRows: 99,
    });
    expect(drawerLaneWindow(24, 20, 99)).toEqual({ start: 16, count: 4 });
    expect(layout.laneStart).toBe(16);
    expect(layout.lanes.map((plan) => plan.laneIndex)).toEqual([16, 17, 18, 19]);
  });
});

describe("drawerMouseHitForLayout", () => {
  it("maps expanded-card rows to lane, chats, and new-chat", () => {
    // Selected lane 0 with 6 chats (single-line cards, no CHATS header):
    //   y=3 top border, y=4 lane line, y=5 chat 0, … y=10 chat 5,
    //   y=11 + new chat, y=12 bottom border, y=13 separator, y=14 lane 1 top.
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 6), laneInput("b", 0), laneInput("c", 0)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.lanes[0]!.visibleChatCount).toBe(6);
    expect(drawerMouseHitForLayout({ y: 4, layout })).toEqual({ kind: "lane", index: 0 });
    expect(drawerMouseHitForLayout({ y: 5, layout })).toEqual({ kind: "chat", laneIndex: 0, chatIndex: 0 });
    expect(drawerMouseHitForLayout({ y: 6, layout })).toEqual({ kind: "chat", laneIndex: 0, chatIndex: 1 });
    expect(drawerMouseHitForLayout({ y: 10, layout })).toEqual({ kind: "chat", laneIndex: 0, chatIndex: 5 });
    expect(drawerMouseHitForLayout({ y: 11, layout })).toEqual({ kind: "new-chat" });
    expect(drawerMouseHitForLayout({ y: 15, layout })).toEqual({ kind: "lane", index: 1 });
  });

  it("maps an expanded empty lane's new-chat row directly under its lane line", () => {
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 1), laneInput("b", 0)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    // y=3 top border, y=4 lane line, y=5 chat 0 (no header in between).
    expect(drawerMouseHitForLayout({ y: 5, layout })).toEqual({ kind: "chat", laneIndex: 0, chatIndex: 0 });
  });

  it("maps compact preview rows on non-selected lanes to their chats", () => {
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 0), laneInput("b", 5)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.lanes[1]).toMatchObject({ visibleChatCount: 5, moreCount: 0 });
    // Lane 0 expanded with 0 chats: y=3 top, y=4 lane line, y=5 + new chat,
    //   y=6 bottom border, y=7 separator, y=8 lane 1 top, y=9 lane 1 line,
    //   y=10..14 preview chats, y=15 bottom border.
    expect(drawerMouseHitForLayout({ y: 5, layout })).toEqual({ kind: "new-chat" });
    expect(drawerMouseHitForLayout({ y: 9, layout })).toEqual({ kind: "lane", index: 1 });
    expect(drawerMouseHitForLayout({ y: 10, layout })).toEqual({ kind: "chat", laneIndex: 1, chatIndex: 0 });
    expect(drawerMouseHitForLayout({ y: 14, layout })).toEqual({ kind: "chat", laneIndex: 1, chatIndex: 4 });
    expect(drawerMouseHitForLayout({ y: 15, layout })).toEqual({ kind: "lane", index: 1 });
  });

  it("maps the +N more row to its lane", () => {
    const layout = computeDrawerLayout({
      panelHeight: 20,
      lanes: [laneInput("a", 0), laneInput("b", 10)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.lanes[1]).toMatchObject({ visibleChatCount: 4, moreCount: 6 });
    // Lane 0 expanded, 0 chats: y=3 top, y=4 line, y=5 new-chat, y=6 bottom,
    //   y=7 separator, y=8 lane 1 top, y=9 lane 1 line, y=10..13 chats,
    //   y=14 "+6 more".
    expect(drawerMouseHitForLayout({ y: 13, layout })).toEqual({ kind: "chat", laneIndex: 1, chatIndex: 3 });
    expect(drawerMouseHitForLayout({ y: 14, layout })).toEqual({ kind: "lane", index: 1 });
  });

  it("maps the drawer + new lane row through the shared layout model", () => {
    const layout = computeDrawerLayout({
      panelHeight: 20,
      lanes: [laneInput("a", 0)],
      expandedLaneIndex: null,
      selectedLaneIndex: null,
      scrollOffsetRows: 0,
    });

    expect(layout.newLaneRow).toBe(19);
    expect(drawerMouseHitForLayout({ y: layout.newLaneRow, layout })).toEqual({ kind: "new-lane" });
  });
});
