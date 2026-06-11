import { describe, expect, it } from "vitest";
import {
  computeDrawerLayout,
  drawerLaneWindow,
  drawerMouseHitForLayout,
  type DrawerLaneInput,
} from "../drawerLayout";

function laneInput(laneId: string, chatCount: number, overrides: Partial<DrawerLaneInput> = {}): DrawerLaneInput {
  return { laneId, chatCount, worktreeAvailable: true, hasDiffRow: false, ...overrides };
}

describe("computeDrawerLayout", () => {
  it("expands the selected lane's chat block and previews chats under every other lane", () => {
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 2), laneInput("b", 5), laneInput("c", 0)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.laneStart).toBe(0);
    expect(layout.lanes[0]).toMatchObject({ expanded: true, visibleChatCount: 2, moreCount: 0 });
    // Lane b gets a compact preview capped at 3 with a "+2 more" row.
    expect(layout.lanes[1]).toMatchObject({ expanded: false, visibleChatCount: 3, moreCount: 2 });
    // Empty lanes get no preview rows.
    expect(layout.lanes[2]).toMatchObject({ expanded: false, visibleChatCount: 0, moreCount: 0 });
  });

  it("drops compact previews when the panel has no leftover rows", () => {
    // 5 lanes at base cost 5 rows on a 31-row panel: zero leftover.
    const layout = computeDrawerLayout({
      panelHeight: 31,
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

  it("only reserves the diff row when the selected lane has diff stats", () => {
    const withDiff = computeDrawerLayout({
      panelHeight: 40,
      lanes: [laneInput("a", 0, { hasDiffRow: true }), laneInput("b", 0)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(withDiff.lanes[0]!.hasDiffRow).toBe(true);
    const withoutDiff = computeDrawerLayout({
      panelHeight: 40,
      lanes: [laneInput("a", 0), laneInput("b", 0, { hasDiffRow: true })],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(withoutDiff.lanes[0]!.hasDiffRow).toBe(false);
    // Lane b has diff stats but is not selected → no diff row.
    expect(withoutDiff.lanes[1]!.hasDiffRow).toBe(false);
  });

  it("clamps the scroll window and keeps absolute lane indexes", () => {
    const lanes = Array.from({ length: 20 }, (_, i) => laneInput(`lane-${i}`, 0));
    const layout = computeDrawerLayout({
      panelHeight: 26, // window of (26-6)/5 = 4 lanes
      lanes,
      expandedLaneIndex: null,
      selectedLaneIndex: null,
      scrollOffsetRows: 99,
    });
    expect(drawerLaneWindow(26, 20, 99)).toEqual({ start: 16, count: 4 });
    expect(layout.laneStart).toBe(16);
    expect(layout.lanes.map((plan) => plan.laneIndex)).toEqual([16, 17, 18, 19]);
  });
});

describe("drawerMouseHitForLayout", () => {
  it("maps expanded-card rows to lane, chats, and new-chat", () => {
    // Selected lane 0 (diff row) with 6 chats, like the legacy fixture:
    //   y=3 border, y=4 name, y=5 meta, y=6 diff, y=7 chat margin,
    //   y=8 CHATS header, y=9 chat 0, y=11 chat 1, … y=19 chat 5,
    //   y=20 + new chat, y=21 bottom border, y=22 separator, y=23 lane 1 top.
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 6, { hasDiffRow: true }), laneInput("b", 0), laneInput("c", 0)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.lanes[0]!.visibleChatCount).toBe(6);
    expect(drawerMouseHitForLayout({ y: 5, layout })).toEqual({ kind: "lane", index: 0 });
    expect(drawerMouseHitForLayout({ y: 6, layout })).toEqual({ kind: "lane", index: 0 });
    expect(drawerMouseHitForLayout({ y: 9, layout })).toEqual({ kind: "chat", laneIndex: 0, chatIndex: 0 });
    expect(drawerMouseHitForLayout({ y: 11, layout })).toEqual({ kind: "chat", laneIndex: 0, chatIndex: 1 });
    expect(drawerMouseHitForLayout({ y: 20, layout })).toEqual({ kind: "new-chat" });
    expect(drawerMouseHitForLayout({ y: 24, layout })).toEqual({ kind: "lane", index: 1 });
  });

  it("does not reserve a diff row for a selected lane without diff stats", () => {
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 1), laneInput("b", 0)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    // No diff row: y=6 is the chat-block margin, chat 0 lands at y=8.
    expect(drawerMouseHitForLayout({ y: 8, layout })).toEqual({ kind: "chat", laneIndex: 0, chatIndex: 0 });
  });

  it("maps compact preview rows on non-selected lanes to their chats", () => {
    const layout = computeDrawerLayout({
      panelHeight: 60,
      lanes: [laneInput("a", 0), laneInput("b", 5)],
      expandedLaneIndex: 0,
      selectedLaneIndex: 0,
      scrollOffsetRows: 0,
    });
    expect(layout.lanes[1]).toMatchObject({ visibleChatCount: 3, moreCount: 2 });
    // Lane 0 expanded with 0 chats: y=3 border, y=4 name, y=5 meta,
    //   y=6 margin, y=7 CHATS header, y=8 + new chat, y=9 bottom border,
    //   y=10 separator, y=11 lane 1 top border, y=12 name, y=13 meta,
    //   y=14..16 preview chats, y=17 "+2 more", y=18 bottom border.
    expect(drawerMouseHitForLayout({ y: 8, layout })).toEqual({ kind: "new-chat" });
    expect(drawerMouseHitForLayout({ y: 12, layout })).toEqual({ kind: "lane", index: 1 });
    expect(drawerMouseHitForLayout({ y: 14, layout })).toEqual({ kind: "chat", laneIndex: 1, chatIndex: 0 });
    expect(drawerMouseHitForLayout({ y: 16, layout })).toEqual({ kind: "chat", laneIndex: 1, chatIndex: 2 });
    // The "+N more" row selects the lane.
    expect(drawerMouseHitForLayout({ y: 17, layout })).toEqual({ kind: "lane", index: 1 });
    expect(drawerMouseHitForLayout({ y: 18, layout })).toEqual({ kind: "lane", index: 1 });
  });
});
