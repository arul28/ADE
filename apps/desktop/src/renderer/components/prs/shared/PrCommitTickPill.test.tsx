// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PR_COMMIT_TICK_COLUMN_WIDTH_PX,
  PR_COMMIT_TICK_EMPHASIS_EXTRA_HEIGHT_PX,
  PR_COMMIT_TICK_EMPHASIS_WIDTH_PX,
  PR_COMMIT_TICK_LENS_WIDTHS_PX,
  PR_COMMIT_TICK_MAX_HEIGHT_PX,
  PR_COMMIT_TICK_MAX_SPAN_PX,
  PR_COMMIT_TICK_MIN_COMMITS,
  PR_COMMIT_TICK_MIN_HEIGHT_PX,
  PR_COMMIT_TICK_PAGE_STEP,
  PR_COMMIT_TICK_PILL_CHROME_PX,
  PR_COMMIT_TICK_PILL_MIN_HEIGHT_PX,
  PR_COMMIT_TICK_PILL_WIDTH_PX,
  PR_COMMIT_TICK_PITCH_PX,
  clampCommitIndex,
  commitTickAccessibleLabel,
  commitTickSubject,
  findCommitIndexBySha,
  resolveCommitIndexForKey,
  resolveCommitIndexFromPointer,
  resolveCommitTickHeightPx,
  resolveCommitTickLensWidthPx,
  resolveCommitTickPillHeightPx,
  resolveCommitTickPitchPx,
  resolveCommitTickSpanPx,
  resolveCommitTickTopPercent,
  shouldRenderCommitTickPill,
  type PrCommitTick,
} from "./prCommitTickPill.logic";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrCommitTickPill } from "./PrCommitTickPill";

afterEach(cleanup);

function commits(count: number): PrCommitTick[] {
  return Array.from({ length: count }, (_, i) => ({
    sha: `sha${i}`,
    shortSha: `sha${i}`,
    subject: `commit ${i}`,
    author: "arul",
    authoredAt: "2026-08-29T00:00:00.000Z",
  }));
}

function renderPill(count: number, activeSha: string | null = null, onSelect = vi.fn()) {
  render(
    <PrCommitTickPill
      commits={commits(count)}
      activeSha={activeSha}
      onSelectCommit={onSelect}
      className="absolute"
    />,
  );
  return onSelect;
}

function pillBox(): { width: number; height: number } {
  const style = screen.getByTestId("pr-commit-tick-pill-strip").style;
  return {
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height),
  };
}

describe("PrCommitTickPill", () => {
  // The hard rule of the redesign, proven on the component and not just the
  // predicate: below two commits there is no pill in the DOM at all — not a
  // hidden one, not an empty one.
  it("renders nothing at all below two commits", () => {
    renderPill(0);
    expect(screen.queryByTestId("pr-commit-tick-pill")).toBeNull();
    cleanup();

    renderPill(1);
    expect(screen.queryByTestId("pr-commit-tick-pill")).toBeNull();
  });

  it("is one vertical listbox tab stop carrying one option per commit", () => {
    renderPill(12);
    const strip = screen.getByRole("listbox");
    expect(strip.getAttribute("aria-label")).toBe("Commits, newest first (12)");
    expect(strip.getAttribute("aria-orientation")).toBe("vertical");
    expect(strip.tabIndex).toBe(0);
    expect(screen.getAllByRole("option")).toHaveLength(12);
  });

  // The correction the owner made twice: the ticks stack DOWN like the chat
  // minimap's, so the commit count drives HEIGHT and the width never moves.
  it("grows in height, not width, and then stops at the cap", () => {
    renderPill(2);
    const two = pillBox();
    cleanup();

    renderPill(10);
    const ten = pillBox();
    cleanup();

    renderPill(300);
    const many = pillBox();

    expect(two.height).toBe(PR_COMMIT_TICK_PILL_MIN_HEIGHT_PX);
    expect(ten.height).toBeGreaterThan(two.height);
    expect(many.height).toBeGreaterThan(ten.height);
    expect(many.height).toBe(PR_COMMIT_TICK_MAX_SPAN_PX + PR_COMMIT_TICK_PILL_CHROME_PX);

    // Fixed cross axis at every count — a wider pill would mean the axis flipped
    // back.
    for (const box of [two, ten, many]) {
      expect(box.width).toBe(PR_COMMIT_TICK_PILL_WIDTH_PX);
    }
  });

  // "Clumped together and closely, not spread fully vertically": the ticks are
  // positioned down the strip, and the whole cluster stays badge-sized.
  it("stacks the ticks vertically and keeps the cluster clumped", () => {
    renderPill(6);
    const tops = screen.getAllByRole("option").map((o) => Number.parseFloat(o.style.top));
    expect(tops).toEqual([0, 20, 40, 60, 80, 100]);
    // Every tick is on the same horizontal centre line — a vertical stack, not a row.
    expect(screen.getAllByRole("option").every((o) => o.style.left === "")).toBe(true);
    expect(pillBox().height).toBeLessThan(60);
  });

  it("walks commits with the arrow keys and selects as it goes", () => {
    const onSelect = renderPill(5);
    const strip = screen.getByRole("listbox");

    fireEvent.focus(strip);
    fireEvent.keyDown(strip, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("sha1");

    fireEvent.keyDown(strip, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("sha4");
    expect(strip.getAttribute("aria-activedescendant")).toBe("pr-commit-tick-4");
  });

  it("marks the active commit for assistive tech and for the eye", () => {
    renderPill(4, "sha2");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    // Colour is never the only signal: the active tick is taller and wider.
    const active = options[2]!;
    const resting = options[0]!;
    expect(Number.parseFloat(active.style.height)).toBeGreaterThan(
      Number.parseFloat(resting.style.height),
    );
    expect(Number.parseFloat(active.style.width)).toBeGreaterThan(
      Number.parseFloat(resting.style.width),
    );
  });
});

/* -- Folded in from `prCommitTickPill.logic.test.ts` -----------------------
   `prCommitTickPill.logic.ts` has exactly one consumer: the component above.
   Its pure geometry belongs in the same suite as the component that renders
   from it, so a change to one cannot pass while the other is broken. */

function makeCommit(overrides: Partial<PrCommitTick> = {}): PrCommitTick {
  return {
    sha: "abc1234def",
    shortSha: "abc1234",
    subject: "Fix the thing",
    author: "arul",
    authoredAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

/** The count at which the span cap bites: (n - 1) * pitch === MAX_SPAN. */
const CAP_COMMIT_COUNT = PR_COMMIT_TICK_MAX_SPAN_PX / PR_COMMIT_TICK_PITCH_PX + 1;

describe("shouldRenderCommitTickPill", () => {
  // The whole point of the redesign: one commit is a dot with no axis, no
  // spacing and nothing to scrub, so the pill must not exist at all.
  it("renders nothing below two commits", () => {
    expect(shouldRenderCommitTickPill(0)).toBe(false);
    expect(shouldRenderCommitTickPill(1)).toBe(false);
    expect(shouldRenderCommitTickPill(-4)).toBe(false);
  });

  it("renders from two commits up", () => {
    expect(PR_COMMIT_TICK_MIN_COMMITS).toBe(2);
    expect(shouldRenderCommitTickPill(2)).toBe(true);
    expect(shouldRenderCommitTickPill(300)).toBe(true);
  });

  it("gives a suppressed pill zero geometry, not a collapsed sliver", () => {
    for (const count of [0, 1]) {
      expect(resolveCommitTickPitchPx(count)).toBe(0);
      expect(resolveCommitTickSpanPx(count)).toBe(0);
      expect(resolveCommitTickPillHeightPx(count)).toBe(0);
    }
  });
});

describe("pill growth and its cap", () => {
  it("keeps the natural pitch while the strip fits", () => {
    expect(resolveCommitTickPitchPx(2)).toBe(PR_COMMIT_TICK_PITCH_PX);
    expect(resolveCommitTickPitchPx(10)).toBe(PR_COMMIT_TICK_PITCH_PX);
    expect(resolveCommitTickPitchPx(CAP_COMMIT_COUNT)).toBe(PR_COMMIT_TICK_PITCH_PX);
  });

  it("grows downward with the commit count until the cap", () => {
    expect(resolveCommitTickSpanPx(2)).toBe(5);
    expect(resolveCommitTickSpanPx(10)).toBe(45);
    expect(resolveCommitTickSpanPx(CAP_COMMIT_COUNT)).toBe(PR_COMMIT_TICK_MAX_SPAN_PX);
  });

  it("floors a two-commit pill so it is not a 19px speck", () => {
    expect(resolveCommitTickPillHeightPx(2)).toBe(PR_COMMIT_TICK_PILL_MIN_HEIGHT_PX);
    // 10 commits clear the floor and size to their own span.
    expect(resolveCommitTickPillHeightPx(10)).toBe(45 + PR_COMMIT_TICK_PILL_CHROME_PX);
  });

  it("compresses spacing instead of growing past the cap", () => {
    const capped = PR_COMMIT_TICK_MAX_SPAN_PX + PR_COMMIT_TICK_PILL_CHROME_PX;
    expect(resolveCommitTickPillHeightPx(CAP_COMMIT_COUNT)).toBe(capped);
    expect(resolveCommitTickPillHeightPx(60)).toBe(capped);
    expect(resolveCommitTickPillHeightPx(300)).toBe(capped);
    // Same box, tighter ticks.
    expect(resolveCommitTickPitchPx(300)).toBeLessThan(resolveCommitTickPitchPx(60));
    expect(resolveCommitTickPitchPx(300)).toBeCloseTo(PR_COMMIT_TICK_MAX_SPAN_PX / 299, 6);
  });

  it("never grows the pill beyond the cap at any count", () => {
    const cap = PR_COMMIT_TICK_MAX_SPAN_PX + PR_COMMIT_TICK_PILL_CHROME_PX;
    for (const count of [2, 3, 8, 25, 26, 100, 1000, 5000]) {
      expect(resolveCommitTickPillHeightPx(count)).toBeLessThanOrEqual(cap);
    }
  });

  // "Clumped together, not spread fully vertically": the cluster must stay a
  // badge, an order of magnitude shorter than the thread column it floats over.
  it("keeps even a 300-commit cluster far shorter than the column it indexes", () => {
    expect(resolveCommitTickPillHeightPx(300)).toBeLessThan(150);
    // A 2-commit cluster is barely taller than it is wide — a speck-proof dot pair.
    expect(resolveCommitTickPillHeightPx(2)).toBeLessThan(40);
  });
});

describe("resolveCommitTickTopPercent", () => {
  it("spans oldest at 0% to newest at 100%", () => {
    expect(resolveCommitTickTopPercent(0, 5)).toBe(0);
    expect(resolveCommitTickTopPercent(1, 5)).toBe(25);
    expect(resolveCommitTickTopPercent(4, 5)).toBe(100);
  });

  it("clamps out-of-range indices to the strip ends", () => {
    expect(resolveCommitTickTopPercent(-3, 4)).toBe(0);
    expect(resolveCommitTickTopPercent(99, 4)).toBe(100);
  });

  it("keeps 300 ticks inside 0..100 so the pill can never overflow", () => {
    const percents = Array.from({ length: 300 }, (_, i) => resolveCommitTickTopPercent(i, 300));
    expect(Math.min(...percents)).toBe(0);
    expect(Math.max(...percents)).toBe(100);
    expect(percents.every((p) => p >= 0 && p <= 100)).toBe(true);
  });
});

describe("resolveCommitIndexFromPointer", () => {
  const base = { stripTop: 100, stripHeight: 200 };

  it("returns null when the pill is suppressed or unmeasured", () => {
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 1, pointerY: 150 })).toBeNull();
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 0, pointerY: 150 })).toBeNull();
    expect(
      resolveCommitIndexFromPointer({ commitCount: 5, stripTop: 100, stripHeight: 0, pointerY: 150 }),
    ).toBeNull();
  });

  it("maps pointer Y to the nearest tick", () => {
    // 5 commits over 200px => ticks at y = 100, 150, 200, 250, 300.
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 5, pointerY: 100 })).toBe(0);
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 5, pointerY: 152 })).toBe(1);
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 5, pointerY: 198 })).toBe(2);
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 5, pointerY: 300 })).toBe(4);
  });

  // The pill's padding is outside the strip: clamping is what turns it into a
  // forgiving hit area rather than dead space that drops the preview.
  it("clamps a pointer in the pill padding to the first / last commit", () => {
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 5, pointerY: 94 })).toBe(0);
    expect(resolveCommitIndexFromPointer({ ...base, commitCount: 5, pointerY: 306 })).toBe(4);
  });

  it("inverts resolveCommitTickTopPercent exactly", () => {
    for (const count of [2, 7, 25, 300]) {
      for (let index = 0; index < count; index += 1) {
        const y = base.stripTop + (resolveCommitTickTopPercent(index, count) / 100) * base.stripHeight;
        expect(resolveCommitIndexFromPointer({ ...base, commitCount: count, pointerY: y })).toBe(index);
      }
    }
  });

  it("keeps every one of 300 ticks reachable at ~0.4px pitch", () => {
    const strip = { stripTop: 0, stripHeight: PR_COMMIT_TICK_MAX_SPAN_PX };
    const seen = new Set<number>();
    for (let y = 0; y <= PR_COMMIT_TICK_MAX_SPAN_PX; y += 0.05) {
      const index = resolveCommitIndexFromPointer({ ...strip, commitCount: 300, pointerY: y });
      if (index !== null) seen.add(index);
    }
    expect(seen.size).toBe(300);
  });
});

describe("resolveCommitTickHeightPx", () => {
  it("uses the full height while ticks are far apart", () => {
    expect(resolveCommitTickHeightPx(PR_COMMIT_TICK_PITCH_PX, false)).toBe(
      PR_COMMIT_TICK_MAX_HEIGHT_PX,
    );
  });

  it("thins to a hairline as ticks crowd so they do not smear into a solid bar", () => {
    expect(resolveCommitTickHeightPx(PR_COMMIT_TICK_MAX_SPAN_PX / 299, false)).toBe(
      PR_COMMIT_TICK_MIN_HEIGHT_PX,
    );
    expect(resolveCommitTickHeightPx(0, false)).toBe(PR_COMMIT_TICK_MAX_HEIGHT_PX);
  });

  it("thickens the active / force-push tick so colour is not the only signal", () => {
    expect(resolveCommitTickHeightPx(PR_COMMIT_TICK_PITCH_PX, true)).toBe(
      PR_COMMIT_TICK_MAX_HEIGHT_PX + PR_COMMIT_TICK_EMPHASIS_EXTRA_HEIGHT_PX,
    );
  });

  // A tick taller than the pitch would overlap its neighbour and read as one bar.
  it("never renders a tick thicker than the pitch it sits at", () => {
    for (const count of [2, 10, 25, 60, 300]) {
      const pitch = resolveCommitTickPitchPx(count);
      expect(resolveCommitTickHeightPx(pitch, false)).toBeLessThanOrEqual(
        Math.max(PR_COMMIT_TICK_MIN_HEIGHT_PX, pitch),
      );
    }
  });
});

describe("resolveCommitTickLensWidthPx", () => {
  it("makes the focused tick widest and tapers with distance", () => {
    const widths = [0, 1, 2, 3].map((d) => resolveCommitTickLensWidthPx(d, false));
    expect(widths).toEqual([...PR_COMMIT_TICK_LENS_WIDTHS_PX]);
    expect(widths[0]).toBeGreaterThan(widths[1]!);
    expect(widths[1]).toBeGreaterThan(widths[2]!);
  });

  it("clamps far distances to the resting width", () => {
    const resting = PR_COMMIT_TICK_LENS_WIDTHS_PX[PR_COMMIT_TICK_LENS_WIDTHS_PX.length - 1];
    expect(resolveCommitTickLensWidthPx(250, false)).toBe(resting);
    expect(resolveCommitTickLensWidthPx(null, false)).toBe(resting);
  });

  it("keeps the emphasised tick wide even when the lens is elsewhere", () => {
    expect(resolveCommitTickLensWidthPx(9, true)).toBe(PR_COMMIT_TICK_EMPHASIS_WIDTH_PX);
    expect(resolveCommitTickLensWidthPx(null, true)).toBe(PR_COMMIT_TICK_EMPHASIS_WIDTH_PX);
  });

  it("never exceeds the tick column it is centred in", () => {
    for (const d of [null, 0, 1, 2, 3, 40]) {
      for (const emphasised of [true, false]) {
        expect(resolveCommitTickLensWidthPx(d, emphasised))
          .toBeLessThanOrEqual(PR_COMMIT_TICK_COLUMN_WIDTH_PX);
      }
    }
  });
});

describe("clampCommitIndex", () => {
  it("returns null when there is nothing to clamp to", () => {
    expect(clampCommitIndex(0, 0)).toBeNull();
    expect(clampCommitIndex(Number.NaN, 5)).toBeNull();
  });

  it("clamps to both ends", () => {
    expect(clampCommitIndex(-4, 5)).toBe(0);
    expect(clampCommitIndex(40, 5)).toBe(4);
    expect(clampCommitIndex(2, 5)).toBe(2);
  });
});

describe("resolveCommitIndexForKey", () => {
  // Down = newer, because newest sits at the BOTTOM of a vertical cluster.
  it("moves down toward newer commits and up toward older ones", () => {
    expect(resolveCommitIndexForKey("ArrowDown", 2, 10)).toBe(3);
    expect(resolveCommitIndexForKey("ArrowUp", 2, 10)).toBe(1);
    expect(resolveCommitIndexForKey("ArrowRight", 2, 10)).toBe(3);
    expect(resolveCommitIndexForKey("ArrowLeft", 2, 10)).toBe(1);
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(resolveCommitIndexForKey("ArrowUp", 0, 10)).toBe(0);
    expect(resolveCommitIndexForKey("ArrowDown", 9, 10)).toBe(9);
    expect(resolveCommitIndexForKey("PageUp", 3, 10)).toBe(0);
    expect(resolveCommitIndexForKey("PageDown", 3, 10)).toBe(Math.min(9, 3 + PR_COMMIT_TICK_PAGE_STEP));
  });

  it("jumps to the ends with Home and End", () => {
    expect(resolveCommitIndexForKey("Home", 5, 10)).toBe(0);
    expect(resolveCommitIndexForKey("End", 5, 10)).toBe(9);
  });

  it("starts from the first commit when nothing is focused yet", () => {
    expect(resolveCommitIndexForKey("ArrowDown", null, 10)).toBe(1);
  });

  it("returns null for keys it does not own so they can bubble", () => {
    expect(resolveCommitIndexForKey("Tab", 2, 10)).toBeNull();
    expect(resolveCommitIndexForKey("Escape", 2, 10)).toBeNull();
    expect(resolveCommitIndexForKey("a", 2, 10)).toBeNull();
  });

  it("returns null with no commits", () => {
    expect(resolveCommitIndexForKey("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("commit labels", () => {
  it("leads with the short sha and carries the subject", () => {
    expect(commitTickAccessibleLabel(makeCommit())).toBe("abc1234: Fix the thing");
  });

  it("names the force-push entry as a branch action, not a sha", () => {
    expect(commitTickAccessibleLabel(makeCommit({ forcePushed: true, subject: "" })))
      .toBe("Force-push: Force-pushed branch");
  });

  it("falls back to a truncated sha when no short sha is present", () => {
    expect(commitTickAccessibleLabel(makeCommit({ shortSha: "" }))).toBe("abc1234: Fix the thing");
  });

  it("never renders an empty subject", () => {
    expect(commitTickSubject(makeCommit({ subject: "   " }))).toBe("No commit message");
  });
});

describe("findCommitIndexBySha", () => {
  const commits = [makeCommit({ sha: "a" }), makeCommit({ sha: "b" }), makeCommit({ sha: "c" })];

  it("finds a present sha", () => {
    expect(findCommitIndexBySha(commits, "b")).toBe(1);
  });

  it("returns null for a missing or absent sha", () => {
    expect(findCommitIndexBySha(commits, "zzz")).toBeNull();
    expect(findCommitIndexBySha(commits, null)).toBeNull();
    expect(findCommitIndexBySha([], "a")).toBeNull();
  });
});
