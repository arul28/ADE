/* @vitest-environment jsdom */

import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetHostedWebZoomForTests, applyHostedWebZoom } from "../../lib/webZoom";
import { AnchoredMenu } from "./AnchoredMenu";
import { PortalContainerContext } from "./portalContainer";

function Harness() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div data-testid="clipping-parent" style={{ overflow: "hidden" }}>
      <button ref={buttonRef} type="button" onClick={() => setOpen((value) => !value)}>
        Toggle
      </button>
      <AnchoredMenu open={open} anchorRef={buttonRef} onClose={() => setOpen(false)} role="menu" aria-label="Test menu">
        <button type="button" role="menuitem">Item</button>
      </AnchoredMenu>
    </div>
  );
}

function rectOf(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

/** The hosted web client's body zoom: layout width 1000, rendered `zoom` times wider. */
function stubZoomedBody(zoom: number) {
  Object.defineProperty(document.body, "offsetWidth", { configurable: true, value: 1000 });
  document.body.getBoundingClientRect = () => rectOf(0, 0, 1000 * zoom, 800 * zoom);
}

function OpenMenu({
  anchorRect,
  onClose = () => {},
}: {
  anchorRect: { left: number; top: number; width: number; height: number };
  onClose?: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={(node) => {
          buttonRef.current = node;
          if (node) node.getBoundingClientRect = () => rectOf(anchorRect.left, anchorRect.top, anchorRect.width, anchorRect.height);
        }}
        type="button"
      >
        Trigger
      </button>
      <AnchoredMenu open anchorRef={buttonRef} onClose={onClose} role="menu" aria-label="Test menu">
        <button type="button" role="menuitem">Item</button>
      </AnchoredMenu>
    </>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  __resetHostedWebZoomForTests();
  delete (document.body as unknown as { offsetWidth?: number }).offsetWidth;
  delete (document.body as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

describe("AnchoredMenu", () => {
  it("renders outside the clipping parent as a fixed layer", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    const menu = screen.getByRole("menu", { name: "Test menu" });
    expect(screen.getByTestId("clipping-parent").contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
  });

  it("stays open for clicks inside it and on the trigger, closes on an outside click", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Toggle" });
    fireEvent.click(toggle);
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "Item" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    // The trigger's own click toggles it; its mousedown must not close it first.
    fireEvent.mouseDown(toggle);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and on window resize", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Toggle" });
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(toggle);
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("places the menu on its trigger in layout pixels under the hosted web zoom", () => {
    applyHostedWebZoom(1.1);
    stubZoomedBody(1.1);
    render(<OpenMenu anchorRect={{ left: 110, top: 55, width: 110, height: 22 }} />);
    const menu = screen.getByRole("menu", { name: "Test menu" });
    // The trigger's rect is zoomed: its left edge is 110 on screen, 100 in style px.
    expect(parseFloat(menu.style.left)).toBeCloseTo(100, 6);
    // The trigger's bottom edge is 77 on screen, 70 in layout px; the menu sits 4px below it.
    expect(parseFloat(menu.style.top)).toBeCloseTo(70 + 4, 6);
  });

  it("keeps the menu open on a scroll that does not move the trigger under zoom", () => {
    applyHostedWebZoom(1.1);
    stubZoomedBody(1.1);
    const onClose = vi.fn();
    render(<OpenMenu anchorRect={{ left: 550, top: 60, width: 110, height: 22 }} onClose={onClose} />);
    fireEvent.scroll(window);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("places into a scaled portal container's space, as a centred dialog panel does", () => {
    applyHostedWebZoom(1.1);
    stubZoomedBody(1.1);
    const panel = document.createElement("div");
    panel.style.transform = "scale(0.5)";
    document.body.appendChild(panel);
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 100 });
    panel.getBoundingClientRect = () => rectOf(300, 100, 200 * 1.1 * 0.5, 100 * 1.1 * 0.5);
    const buttonRef = { current: null as HTMLButtonElement | null };
    render(
      <PortalContainerContext.Provider value={panel}>
        <button
          ref={(node) => {
            buttonRef.current = node;
            if (node) node.getBoundingClientRect = () => rectOf(400, 150, 10, 10);
          }}
          type="button"
        >
          Trigger
        </button>
        <AnchoredMenu open anchorRef={buttonRef} onClose={() => {}} role="menu" aria-label="Test menu">
          <button type="button" role="menuitem">Item</button>
        </AnchoredMenu>
      </PortalContainerContext.Provider>,
    );
    const menu = screen.getByRole("menu", { name: "Test menu" });
    expect(menu.parentElement).toBe(panel);
    // The trigger's left edge is 400 on screen, 100 right of the panel's origin (300, 100), at 0.55 screen px per style px.
    expect(parseFloat(menu.style.left)).toBeCloseTo(100 / 0.55, 4);
    // The trigger's bottom edge is 160 on screen, 60 down the panel: 60 / 0.55 style px, plus the 4px offset.
    expect(parseFloat(menu.style.top)).toBeCloseTo(60 / 0.55 + 4, 4);
    panel.remove();
  });
});
