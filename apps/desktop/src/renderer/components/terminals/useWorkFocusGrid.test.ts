/* @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { focusEvenPages, focusFit, focusPageColumns } from "./WorkFocusGrid";
import { useWorkFocusGrid } from "./useWorkFocusGrid";
import type { WorkFocusQueueItem } from "./useWorkFocusQueueReport";

function chat(id: string): TerminalSessionSummary {
  return { id, laneId: "lane-1", title: id, status: "running", toolType: "claude-chat" } as unknown as TerminalSessionSummary;
}

function queue(...ids: string[]): WorkFocusQueueItem[] {
  return ids.map((id) => ({ session: chat(id), binding: null }));
}

describe("Focus grid page math", () => {
  it.each([
    // [chats, capacity, page sizes]: as few pages as fit, spread evenly, earlier pages take the remainder.
    [8, 6, [4, 4]],
    [7, 6, [4, 3]],
    [3, 6, [3]],
    [5, 2, [2, 2, 1]],
    [0, 6, []],
  ])("splits %i chats with room for %i into pages of %j", (count, capacity, sizes) => {
    const items = Array.from({ length: count }, (_, index) => index);
    const pages = focusEvenPages(items, capacity);
    expect(pages.map((page) => page.length)).toEqual(sizes);
    expect(pages.flat()).toEqual(items);
  });

  it.each([
    // [tiles on the page, columns that fit, tiles per row]: side by side first.
    [4, 3, 2],
    [3, 3, 3],
    [6, 3, 3],
    [2, 1, 1],
    [1, 4, 1],
  ])("lays %i tiles out %i-wide-at-most as rows of %i", (count, columnsThatFit, columns) => {
    expect(focusPageColumns(count, columnsThatFit)).toBe(columns);
  });

  it("holds one tile before the grid is measured, never more than the cap, and never fewer for a bigger box", () => {
    expect(focusFit(0, 0, 6)).toEqual({ columns: 1, rows: 1, capacity: 1 });
    let previous = focusFit(300, 200, 6);
    for (const [width, height] of [[600, 400], [1200, 800], [2400, 1600], [4800, 3200]]) {
      const next = focusFit(width, height, 6);
      expect(next.capacity).toBeGreaterThanOrEqual(Math.max(1, previous.capacity));
      expect(next.capacity).toBeLessThanOrEqual(6);
      expect(next.columns).toBeGreaterThanOrEqual(previous.columns);
      expect(next.rows).toBeGreaterThanOrEqual(previous.rows);
      previous = next;
    }
  });

  it("gives a laptop-height grid one row of side-by-side tiles, not two short rows", () => {
    // Product decision: a short tile is mostly composer, so this window pages
    // two tiles side by side instead of stacking a 2 × 2.
    expect(focusFit(936, 836, 6)).toEqual({ columns: 2, rows: 1, capacity: 2 });
  });
});

describe("useWorkFocusGrid", () => {
  let resize: () => void = () => {};
  const size = { width: 900, height: 600 };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function setup(sidebarIsRoster = false) {
    const hook = renderHook(
      ({ roster }: { roster: boolean }) => useWorkFocusGrid({
        enabled: true,
        sidebarIsRoster: roster,
        projectStateKey: "project-1",
        rememberSessionPin: () => {},
      }),
      { initialProps: { roster: sidebarIsRoster } },
    );
    const node = document.createElement("div");
    node.getBoundingClientRect = () => ({ width: size.width, height: size.height }) as DOMRect;
    act(() => hook.result.current.pageProps.ref(node));
    const report = (items: WorkFocusQueueItem[]) => act(() => hook.result.current.setQueueItems(items));
    const resizeTo = (width: number) => {
      size.width = width;
      act(() => resize());
    };
    return { hook, report, resizeTo };
  }

  it("keeps the tile the user is in on screen when the pages re-spread", () => {
    size.width = 900; // two tiles per page
    const { hook, report, resizeTo } = setup();
    report(queue("a", "b", "c", "d"));
    expect(hook.result.current.members.map((s) => s.id)).toEqual(["a", "b"]);

    act(() => { expect(hook.result.current.focusSession("d")).toBe(true); });
    expect(hook.result.current.members.map((s) => s.id)).toEqual(["c", "d"]);
    expect(hook.result.current.activeId).toBe("d");

    // The user is in "b" on the first page. A narrower window holds one tile
    // per page, which moves "b" to the second page: the view goes with it.
    act(() => { hook.result.current.focusSession("b"); });
    resizeTo(500);
    expect(hook.result.current.members.map((s) => s.id)).toEqual(["b"]);
    expect(hook.result.current.selectedSessionId).toBe("b");
    resizeTo(900);
    expect(hook.result.current.members.map((s) => s.id)).toEqual(["a", "b"]);
    // A chat with no tile is not focusable.
    act(() => { expect(hook.result.current.focusSession("zz")).toBe(false); });
  });

  it("lets go of a focused chat that left, so its return does not pull the view away", () => {
    size.width = 900;
    const { hook, report } = setup();
    report(queue("a", "b", "c", "d"));
    act(() => { hook.result.current.focusSession("a"); });

    // The user replies in "a": it starts working and leaves the grid.
    report(queue("b", "c", "d"));
    expect(hook.result.current.members.map((s) => s.id)).toEqual(["b", "c"]);
    expect(hook.result.current.activeId).toBe("b");

    // It comes back on the next page; the page the user is reading stays.
    report(queue("b", "c", "d", "a"));
    expect(hook.result.current.members.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("marks a chat that arrives on another page until the user goes there, but not the ones already waiting", () => {
    size.width = 900;
    const { hook, report } = setup(true);
    report(queue("a", "b", "c", "d"));
    // The chats waiting when the grid opened are the baseline, not arrivals.
    expect(hook.result.current.pager).toMatchObject({ page: 0, pageCount: 2, newAfter: false });
    expect(hook.result.current.marks?.get("c")).toEqual({ page: 1, onScreen: false, unseen: false });

    report(queue("a", "b", "c", "d", "e", "f"));
    expect(hook.result.current.marks?.get("f")).toMatchObject({ unseen: true, onScreen: false });
    expect(hook.result.current.pager?.newAfter).toBe(true);
    // The sidebar is the roster, so the bottom strip stays away.
    expect(hook.result.current.rosterProps).toBeNull();

    act(() => hook.result.current.pager?.onPage(2));
    expect(hook.result.current.marks?.get("f")).toEqual({ page: 2, onScreen: true, unseen: false });
    expect(hook.result.current.pager?.newAfter).toBe(false);
  });
});
