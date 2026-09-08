import { describe, expect, it } from "vitest";
import {
  browserLetterboxFrame,
  clampBrowserViewBounds,
  emulationCaption,
  isBrowserOverlayCandidate,
  isBrowserOverlayCandidateVisible,
  rectIntersection,
  type BrowserOverlayCandidate,
} from "./browserViewGeometry";

describe("browserLetterboxFrame", () => {
  it("fills the stage inside the hairline when nothing is emulated", () => {
    expect(browserLetterboxFrame({ width: 600, height: 400 }, null)).toEqual({
      left: 1,
      top: 1,
      width: 598,
      height: 398,
      scale: 1,
    });
  });

  it("centres the exact CSS size of the emulated device", () => {
    expect(browserLetterboxFrame({ width: 800, height: 1000 }, { width: 393, height: 852 })).toEqual({
      left: 1 + Math.floor((798 - 393) / 2),
      top: 1 + Math.floor((998 - 852) / 2),
      width: 393,
      height: 852,
      scale: 1,
    });
  });

  it("scales a device that does not fit instead of cropping one edge of it", () => {
    const frame = browserLetterboxFrame({ width: 300, height: 400 }, { width: 393, height: 852 });
    // 398/852 is the binding constraint, so both axes shrink by it and the
    // whole phone stays on screen rather than losing its right-hand side.
    expect(frame.scale).toBeCloseTo(398 / 852, 5);
    expect(frame.width).toBe(Math.round(393 * (398 / 852)));
    expect(frame.height).toBe(398);
    expect(frame.width).toBeLessThanOrEqual(298);
    expect(frame.left).toBeGreaterThan(1);
  });

  it("keeps a landscape phone inside a narrow pane", () => {
    const frame = browserLetterboxFrame({ width: 578, height: 700 }, { width: 852, height: 393 });
    expect(frame.width).toBeLessThanOrEqual(576);
    expect(frame.height / frame.width).toBeCloseTo(393 / 852, 2);
    expect(frame.scale).toBeLessThan(1);
  });

  it("treats a zero-sized emulation as no emulation", () => {
    expect(browserLetterboxFrame({ width: 500, height: 300 }, { width: 0, height: 0 })).toEqual({
      left: 1,
      top: 1,
      width: 498,
      height: 298,
      scale: 1,
    });
  });
});

describe("clampBrowserViewBounds", () => {
  it("trims a stale measurement back into the pane", () => {
    expect(clampBrowserViewBounds(
      { x: 1_160, y: 60, width: 640, height: 800 },
      { left: 1_160, top: 60, right: 1_460, bottom: 860 },
    )).toEqual({ x: 1_160, y: 60, width: 300, height: 800 });
  });

  it("collapses to nothing rather than reporting a negative size", () => {
    // A frame entirely outside the box reads as zero-width, which is what the
    // panel treats as "not visible" — never as a negative rectangle.
    expect(clampBrowserViewBounds(
      { x: 900, y: 10, width: 200, height: 200 },
      { left: 0, top: 0, right: 400, bottom: 400 },
    )).toEqual({ x: 900, y: 10, width: 0, height: 200 });
  });
});

describe("emulationCaption", () => {
  it("reads as the device's CSS size", () => {
    expect(emulationCaption({ width: 393, height: 852 })).toBe("393 × 852");
    expect(emulationCaption(null)).toBeNull();
    expect(emulationCaption({ width: 0, height: 0 })).toBeNull();
  });

  it("admits when the pane was too small to show the device at 1:1", () => {
    expect(emulationCaption({ width: 393, height: 852 }, 0.82)).toBe("393 × 852 · fit 82%");
    // A rounding-error scale is not a fit, and saying "fit 100%" would read as
    // a warning about nothing.
    expect(emulationCaption({ width: 393, height: 852 }, 0.999)).toBe("393 × 852");
    expect(emulationCaption({ width: 393, height: 852 }, 1)).toBe("393 × 852");
  });
});

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe("rectIntersection", () => {
  it("returns the overlapping box of two crossing rects", () => {
    expect(rectIntersection(rect(0, 0, 100, 100), rect(60, 40, 100, 100)))
      .toEqual({ left: 60, top: 40, right: 100, bottom: 100, width: 40, height: 60 });
  });

  it("returns the inner rect when one fully contains the other", () => {
    const inner = rect(20, 30, 10, 10);
    expect(rectIntersection(rect(0, 0, 100, 100), inner)).toEqual(inner);
    // Containment is symmetric: the surface may be the smaller of the two.
    expect(rectIntersection(inner, rect(0, 0, 100, 100))).toEqual(inner);
  });

  it("returns the rect itself when both are identical", () => {
    const same = rect(5, 5, 50, 50);
    expect(rectIntersection(same, same)).toEqual(same);
  });

  it("treats a shared edge as no overlap rather than a zero-area rect", () => {
    // A pane flush against the browser surface must not hide the native view:
    // zero-area contact would blank the page for a rectangle nobody can see.
    expect(rectIntersection(rect(0, 0, 100, 100), rect(100, 0, 40, 100))).toBeNull();
    expect(rectIntersection(rect(0, 0, 100, 100), rect(0, 100, 100, 40))).toBeNull();
  });

  it("treats a zero-sized rect inside another as no overlap", () => {
    expect(rectIntersection(rect(0, 0, 100, 100), rect(50, 50, 0, 0))).toBeNull();
  });

  it("returns null for disjoint rects on either axis", () => {
    expect(rectIntersection(rect(0, 0, 100, 100), rect(200, 0, 50, 50))).toBeNull();
    expect(rectIntersection(rect(0, 0, 100, 100), rect(0, 200, 50, 50))).toBeNull();
    expect(rectIntersection(rect(200, 200, 50, 50), rect(0, 0, 100, 100))).toBeNull();
  });
});

function candidate(overrides: Partial<BrowserOverlayCandidate> = {}): BrowserOverlayCandidate {
  return {
    rect: { width: 200, height: 120 },
    role: null,
    position: "static",
    pointerEvents: "auto",
    display: "block",
    visibility: "visible",
    opacity: "1",
    hidden: false,
    ariaHidden: false,
    ariaModal: false,
    matchesOverlaySelector: false,
    ...overrides,
  };
}

describe("isBrowserOverlayCandidateVisible", () => {
  it("agrees with the full predicate on every style-only reject", () => {
    // The hook calls this first so an invisible candidate never costs a forced
    // layout or a selector match. It has to reject exactly what the full
    // predicate's opening block rejects, or the pass would start missing
    // overlays that do paint.
    for (const invisible of [
      { display: "none" },
      { visibility: "hidden" },
      { opacity: "0" },
      { pointerEvents: "none" },
      { hidden: true },
      { ariaHidden: true },
    ]) {
      expect(isBrowserOverlayCandidateVisible(candidate(invisible))).toBe(false);
      expect(isBrowserOverlayCandidate(candidate({ ...invisible, position: "fixed" }))).toBe(false);
    }
  });

  it("passes anything the full predicate would go on to measure", () => {
    expect(isBrowserOverlayCandidateVisible(candidate())).toBe(true);
    // A fading menu still paints, so it must survive the cheap gate.
    expect(isBrowserOverlayCandidateVisible(candidate({ opacity: "0.4" }))).toBe(true);
  });
});

describe("isBrowserOverlayCandidate", () => {
  it("ignores an in-flow element that is merely present", () => {
    expect(isBrowserOverlayCandidate(candidate())).toBe(false);
  });

  it("ignores anything that cannot be seen or clicked", () => {
    // Each of these is a popover that has already closed, or a decorative
    // layer: hiding the live view for one costs a frame of frozen page.
    expect(isBrowserOverlayCandidate(candidate({ display: "none", position: "fixed" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ visibility: "hidden", position: "fixed" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ opacity: "0", position: "fixed" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ pointerEvents: "none", position: "fixed" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ hidden: true, position: "fixed" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ ariaHidden: true, position: "fixed" }))).toBe(false);
  });

  it("keeps a partly transparent overlay", () => {
    // Only a fully transparent layer is invisible; a fading menu still paints.
    expect(isBrowserOverlayCandidate(candidate({ opacity: "0.4", position: "fixed" }))).toBe(true);
  });

  it("ignores anything smaller than a few pixels on either axis", () => {
    expect(isBrowserOverlayCandidate(candidate({ rect: { width: 3, height: 400 }, role: "dialog" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ rect: { width: 400, height: 3 }, role: "dialog" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ rect: { width: 4, height: 4 }, role: "dialog" }))).toBe(true);
  });

  it("accepts every overlay role, and no other role", () => {
    for (const role of ["alertdialog", "dialog", "listbox", "menu", "tooltip"]) {
      expect(isBrowserOverlayCandidate(candidate({ role }))).toBe(true);
    }
    expect(isBrowserOverlayCandidate(candidate({ role: "button" }))).toBe(false);
    expect(isBrowserOverlayCandidate(candidate({ role: "" }))).toBe(false);
  });

  it("accepts an aria-modal element whatever its role", () => {
    expect(isBrowserOverlayCandidate(candidate({ ariaModal: true }))).toBe(true);
  });

  it("accepts a popover library's content box", () => {
    expect(isBrowserOverlayCandidate(candidate({ matchesOverlaySelector: true }))).toBe(true);
  });

  it("accepts anything taken out of flow, and nothing left in it", () => {
    for (const position of ["fixed", "absolute", "sticky"]) {
      expect(isBrowserOverlayCandidate(candidate({ position }))).toBe(true);
    }
    for (const position of ["static", "relative"]) {
      expect(isBrowserOverlayCandidate(candidate({ position }))).toBe(false);
    }
  });

  it("puts invisibility ahead of every accepting branch", () => {
    // A closed Radix menu keeps its role and its data attribute; the display
    // check is what stops it from freezing the view for the rest of the page.
    expect(isBrowserOverlayCandidate(candidate({
      role: "menu",
      ariaModal: true,
      matchesOverlaySelector: true,
      position: "fixed",
      display: "none",
    }))).toBe(false);
  });
});
