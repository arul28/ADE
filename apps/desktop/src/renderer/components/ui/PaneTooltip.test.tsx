/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTooltip } from "./PaneTooltip";

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
