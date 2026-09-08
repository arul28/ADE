/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTooltip } from "./PaneTooltip";
import {
  computeTooltipPosition,
  rectsOverlap,
  resolveTooltipSide,
  type TooltipRect,
} from "./tooltipPosition";

function widths(node: HTMLElement, scroll: number, client: number): void {
  Object.defineProperty(node, "scrollWidth", { configurable: true, value: scroll });
  Object.defineProperty(node, "clientWidth", { configurable: true, value: client });
}

describe("PaneTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("waits out the hover intent before it appears, and portals out of the pane", () => {
    const { container } = render(
      <PaneTooltip label="Close Tools sidebar">
        <button type="button">x</button>
      </PaneTooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;

    fireEvent.pointerEnter(wrapper);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => { vi.advanceTimersByTime(500); });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("Close Tools sidebar");
    // Portalled, so a pane with `overflow: hidden` can never clip it.
    expect(wrapper.contains(tooltip)).toBe(false);
    expect(document.body.contains(tooltip)).toBe(true);
    // And it can never eat the click it is describing.
    expect((tooltip as HTMLElement).style.pointerEvents).toBe("none");
  });

  it("stays away when the trigger already shows the whole string", () => {
    const { container } = render(
      <PaneTooltip label="Terminal — No shells" onlyWhenClipped>
        <button type="button"><span>Terminal</span><span>No shells</span></button>
      </PaneTooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    for (const node of [wrapper, ...Array.from(wrapper.querySelectorAll<HTMLElement>("*"))]) {
      widths(node, 120, 120);
    }

    fireEvent.pointerEnter(wrapper);
    act(() => { vi.advanceTimersByTime(500); });
    // Nothing to add, so nothing appears over the next row.
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("appears once the trigger's text is actually cut off", () => {
    const { container } = render(
      <PaneTooltip label="Browser — localhost:3000/a/very/long/path · agent" onlyWhenClipped>
        <button type="button"><span>Browser</span><span id="line">localhost…</span></button>
      </PaneTooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    widths(wrapper, 120, 120);
    widths(wrapper.querySelector<HTMLElement>("#line")!, 260, 120);

    fireEvent.pointerEnter(wrapper);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole("tooltip").textContent).toContain("localhost:3000/a/very/long/path");
  });

  it("does not pop open on a mouse click of the control it describes", () => {
    // A `<button>` takes focus AFTER `pointerdown`, so `onPointerDown={hide}`
    // followed by an unguarded `onFocus={show}` ran in exactly the wrong order
    // and the tooltip appeared on the click meant to dismiss it.
    const { container } = render(
      <PaneTooltip label="Back to tools">
        <button type="button">tools</button>
      </PaneTooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    const button = screen.getByRole("button");
    // jsdom has no `:focus-visible`; a mouse focus is one that does not match.
    button.matches = ((selector: string) => selector !== ":focus-visible") as HTMLElement["matches"];

    fireEvent.pointerDown(wrapper);
    fireEvent.focus(button);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("still appears on keyboard focus, immediately", () => {
    render(
      <PaneTooltip label="Back to tools">
        <button type="button">tools</button>
      </PaneTooltip>,
    );
    const button = screen.getByRole("button");
    button.matches = (() => true) as HTMLElement["matches"];

    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("describes the focusable control, not the layout wrapper", () => {
    const { container } = render(
      <PaneTooltip label="Back to tools">
        <button type="button" aria-describedby="own-hint">tools</button>
      </PaneTooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;

    fireEvent.pointerEnter(wrapper);
    act(() => { vi.advanceTimersByTime(500); });
    const tooltip = screen.getByRole("tooltip");
    const described = screen.getByRole("button").getAttribute("aria-describedby") ?? "";
    expect(described.split(" ")).toContain(tooltip.id);
    // The caller's own description survives.
    expect(described.split(" ")).toContain("own-hint");
    expect(wrapper.getAttribute("aria-describedby")).toBeNull();
  });

  it("leaves with the pointer", () => {
    const { container } = render(
      <PaneTooltip label="Back to tools" shortcut="Escape">
        <button type="button">tools</button>
      </PaneTooltip>,
    );
    const wrapper = container.firstElementChild as HTMLElement;

    fireEvent.pointerEnter(wrapper);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole("tooltip")).toBeTruthy();

    fireEvent.pointerLeave(wrapper);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

const VIEWPORT = { width: 1000, height: 800 };

function trigger(partial: Partial<TooltipRect> & { top: number; left: number; width: number; height: number }): TooltipRect {
  return {
    ...partial,
    right: partial.right ?? partial.left + partial.width,
    bottom: partial.bottom ?? partial.top + partial.height,
  };
}

describe("computeTooltipPosition", () => {
  it("keeps the preferred side when it fits", () => {
    const placement = computeTooltipPosition({
      preferredSide: "bottom",
      trigger: trigger({ top: 100, left: 400, width: 24, height: 24 }),
      tooltip: { width: 120, height: 26 },
      viewport: VIEWPORT,
    });
    expect(placement.side).toBe("bottom");
    expect(placement.y).toBeGreaterThanOrEqual(124);
  });

  it("flips to the opposite side rather than hanging off the window", () => {
    // A header dot 8px from the top: "top" has no room, "bottom" does.
    const box = trigger({ top: 8, left: 400, width: 20, height: 20 });
    expect(resolveTooltipSide({
      preferredSide: "top",
      trigger: box,
      tooltip: { width: 140, height: 30 },
      viewport: VIEWPORT,
    })).toBe("bottom");
  });

  it("shifts along the cross axis to stay inside the window — the clipped 'Clos' case", () => {
    // The pane's close button, hard against the right edge of a 1000px window.
    const closeButton = trigger({ top: 40, left: 964, width: 36, height: 36 });
    const placement = computeTooltipPosition({
      preferredSide: "bottom",
      trigger: closeButton,
      tooltip: { width: 150, height: 26 },
      viewport: VIEWPORT,
    });
    // Fully inside, both edges.
    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.x + 150).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("flips a bottom tooltip up when the trigger sits on the window's bottom edge", () => {
    // A picker card on the last row: "bottom" would put the tooltip below the
    // window, and shifting it up would land it on top of the card.
    const card = trigger({ top: 742, left: 300, width: 160, height: 48 });
    const tooltip = { width: 200, height: 30 };
    const placement = computeTooltipPosition({
      preferredSide: "bottom",
      trigger: card,
      tooltip,
      viewport: VIEWPORT,
    });
    expect(placement.side).toBe("top");
    expect(placement.y + tooltip.height).toBeLessThanOrEqual(card.top);
    expect(rectsOverlap({ x: placement.x, y: placement.y, ...tooltip }, card)).toBe(false);
  });

  it("shifts a right-edge tooltip inward and keeps an 8px margin", () => {
    // The pane's ✕ against the right edge of the window.
    const closeButton = trigger({ top: 40, left: 972, width: 28, height: 28 });
    const tooltip = { width: 180, height: 26 };
    const placement = computeTooltipPosition({
      preferredSide: "bottom",
      trigger: closeButton,
      tooltip,
      viewport: VIEWPORT,
    });
    expect(placement.x).toBeGreaterThanOrEqual(8);
    expect(placement.x + tooltip.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it("never overlaps the control it describes, on any side", () => {
    const box = trigger({ top: 300, left: 480, width: 40, height: 24 });
    const tooltip = { width: 160, height: 28 };
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const placement = computeTooltipPosition({ preferredSide: side, trigger: box, tooltip, viewport: VIEWPORT });
      expect(rectsOverlap({ x: placement.x, y: placement.y, ...tooltip }, box)).toBe(false);
    }
  });

  it("still clears the trigger when the window is too small for any side to fit", () => {
    // A 60px-tall window: nothing "fits", but the tooltip must not land on top
    // of the control — that is the failure the clamp used to produce.
    const tinyViewport = { width: 200, height: 60 };
    const box = trigger({ top: 20, left: 90, width: 20, height: 20 });
    const tooltip = { width: 150, height: 40 };
    const placement = computeTooltipPosition({
      preferredSide: "top",
      trigger: box,
      tooltip,
      viewport: tinyViewport,
    });
    expect(rectsOverlap({ x: placement.x, y: placement.y, ...tooltip }, box)).toBe(false);
  });

  it("falls back to the roomiest side when neither axis fits", () => {
    const box = trigger({ top: 10, left: 10, width: 20, height: 20 });
    const side = resolveTooltipSide({
      preferredSide: "top",
      trigger: box,
      tooltip: { width: 400, height: 400 },
      viewport: { width: 300, height: 300 },
    });
    // Right (300 - 30 = 270) and bottom (300 - 30 = 270) tie; either is honest,
    // but it must not stay on the 10px-deep "top".
    expect(side).not.toBe("top");
    expect(side).not.toBe("left");
  });
});
