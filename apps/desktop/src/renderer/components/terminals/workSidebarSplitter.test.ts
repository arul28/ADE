/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  beginWorkSidebarSplitterDrag,
  clampWorkSidebarWidthPct,
  MAX_WORK_SIDEBAR_WIDTH_PCT,
  MIN_WORK_SIDEBAR_PANE_PX,
  MIN_WORK_SIDEBAR_WIDTH_PCT,
  MIN_WORK_CONTENT_PANE_PX,
  nextWorkSidebarWidthPctForKey,
  workSidebarPaneWidthPx,
} from "./workSidebarSplitter";

describe("clampWorkSidebarWidthPct", () => {
  it("keeps the taste range when no container width is known", () => {
    expect(clampWorkSidebarWidthPct(10)).toBe(MIN_WORK_SIDEBAR_WIDTH_PCT);
    expect(clampWorkSidebarWidthPct(90)).toBe(MAX_WORK_SIDEBAR_WIDTH_PCT);
    expect(clampWorkSidebarWidthPct(36)).toBe(36);
  });

  it("never lets a drag take the pane under its 280px floor", () => {
    // The regression: 26% of this window is 234px, which clipped 31px of pane —
    // the ✕ and the browser's ⋮ — off the right of the window.
    const container = 900;
    const clamped = clampWorkSidebarWidthPct(MIN_WORK_SIDEBAR_WIDTH_PCT, container);
    expect(workSidebarPaneWidthPx(clamped, container)).toBeGreaterThanOrEqual(MIN_WORK_SIDEBAR_PANE_PX - 1e-6);
  });

  it("holds the floor for every width a drag can ask for", () => {
    const container = 1024;
    for (let requested = -50; requested <= 150; requested += 1) {
      const clamped = clampWorkSidebarWidthPct(requested, container);
      expect(workSidebarPaneWidthPx(clamped, container)).toBeGreaterThanOrEqual(MIN_WORK_SIDEBAR_PANE_PX - 1e-6);
    }
  });

  it("leaves the chat column a floor of its own", () => {
    const container = 1200;
    const clamped = clampWorkSidebarWidthPct(100, container);
    const paneWidth = workSidebarPaneWidthPx(clamped, container);
    expect(container - paneWidth).toBeGreaterThanOrEqual(MIN_WORK_CONTENT_PANE_PX);
  });

  it("gives the pane's floor priority when the window cannot honour both", () => {
    // 560px of window: 280 + 360 does not fit. The pane keeps its floor,
    // because a clipped close button is broken and a tight chat column is not.
    const container = 560;
    const clamped = clampWorkSidebarWidthPct(26, container);
    expect(workSidebarPaneWidthPx(clamped, container)).toBeCloseTo(MIN_WORK_SIDEBAR_PANE_PX, 6);
    // The chat column is the one that yields here.
    expect(container - workSidebarPaneWidthPx(clamped, container)).toBeLessThan(MIN_WORK_CONTENT_PANE_PX);
  });

  it("breaks the 55% ceiling rather than the pane's floor in a tiny window", () => {
    const container = 480;
    const clamped = clampWorkSidebarWidthPct(26, container);
    expect(clamped).toBeGreaterThan(MAX_WORK_SIDEBAR_WIDTH_PCT);
    expect(workSidebarPaneWidthPx(clamped, container)).toBeCloseTo(MIN_WORK_SIDEBAR_PANE_PX, 6);
  });

  it("ignores a container width it cannot trust", () => {
    expect(clampWorkSidebarWidthPct(36, 0)).toBe(36);
    expect(clampWorkSidebarWidthPct(36, Number.NaN)).toBe(36);
    expect(clampWorkSidebarWidthPct(Number.NaN, 1200)).toBe(MIN_WORK_SIDEBAR_WIDTH_PCT);
  });
});

describe("nextWorkSidebarWidthPctForKey", () => {
  const container = 1440;

  it("moves the separator, so ArrowLeft widens the right-hand pane", () => {
    expect(nextWorkSidebarWidthPctForKey("ArrowLeft", 36, container)).toBe(38);
    expect(nextWorkSidebarWidthPctForKey("ArrowRight", 36, container)).toBe(34);
  });

  it("snaps to the ends of the legal range with Home and End", () => {
    expect(nextWorkSidebarWidthPctForKey("Home", 40, container)).toBe(MIN_WORK_SIDEBAR_WIDTH_PCT);
    expect(nextWorkSidebarWidthPctForKey("End", 40, container)).toBe(MAX_WORK_SIDEBAR_WIDTH_PCT);
  });

  it("honours the pixel floors from the keyboard too", () => {
    const narrow = 900;
    const home = nextWorkSidebarWidthPctForKey("Home", 40, narrow)!;
    expect(workSidebarPaneWidthPx(home, narrow)).toBeGreaterThanOrEqual(MIN_WORK_SIDEBAR_PANE_PX - 1e-6);
    const stepped = nextWorkSidebarWidthPctForKey("ArrowRight", home, narrow)!;
    expect(stepped).toBe(home);
  });

  it("declines keys that are not the separator's", () => {
    expect(nextWorkSidebarWidthPctForKey("Enter", 36, container)).toBeNull();
    expect(nextWorkSidebarWidthPctForKey("ArrowUp", 36, container)).toBeNull();
  });
});

describe("beginWorkSidebarSplitterDrag", () => {
  it("suppresses hit testing and selection for the drag, then restores what it found", () => {
    // `user-select: none` on the body alone never worked: it is inherited, and
    // every `select-text` surface in the chat column declares its own value,
    // which wins. Dropping hit testing is what actually stops the smear.
    document.body.style.cursor = "text";
    const handle = document.createElement("div");
    document.body.appendChild(handle);

    const end = beginWorkSidebarSplitterDrag(handle);
    expect(document.documentElement.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.pointerEvents).toBe("none");
    expect(handle.style.userSelect).toBe("none");

    end();
    expect(document.documentElement.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.pointerEvents).toBe("");
    expect(handle.style.userSelect).toBe("");
    // Restored to what it was, not blanked: the drag borrowed the cursor.
    expect(document.body.style.cursor).toBe("text");
    handle.remove();
    document.body.style.cursor = "";
  });

  it("falls back to the ambient document when it is handed no handle", () => {
    const end = beginWorkSidebarSplitterDrag(null);
    expect(document.body.style.pointerEvents).toBe("none");
    end();
    expect(document.body.style.pointerEvents).toBe("");
  });
});
