/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetHostedWebZoomForTests, applyHostedWebZoom } from "../../lib/webZoom";
import { MenuSubmenu } from "./MenuSubmenu";

/** A DOMRect-shaped object for a stubbed `getBoundingClientRect`. */
function rectOf(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

/**
 * jsdom has no layout, so stub the two measurements the hosted-web zoom turns on:
 * the body's layout width (`offsetWidth`) and its zoomed rect width. Their ratio is
 * the CSS zoom `cssZoomOf` reads. The trigger's rect is what the panel is placed against.
 */
function stubZoomedBody(zoom: number) {
  Object.defineProperty(document.body, "offsetWidth", { configurable: true, value: 1000 });
  document.body.getBoundingClientRect = () => rectOf(0, 0, 1000 * zoom, 800 * zoom);
}

beforeEach(() => {
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

afterEach(() => {
  cleanup();
  __resetHostedWebZoomForTests();
  delete (document.body as unknown as { offsetWidth?: number }).offsetWidth;
  delete (document.body as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

function openSubmenuAt(trigger: { left: number; top: number; width: number; height: number }) {
  render(
    <MenuSubmenu label="Copy" className="row">
      <button type="button" role="menuitem">Session ID</button>
    </MenuSubmenu>,
  );
  const button = screen.getByRole("button", { name: /Copy/ });
  button.getBoundingClientRect = () => rectOf(trigger.left, trigger.top, trigger.width, trigger.height);
  fireEvent.click(button);
  return screen.getByRole("menu");
}

describe("MenuSubmenu placement under the hosted web client's body zoom", () => {
  it("attaches the panel beside its row when the body is zoomed, as in the web client", () => {
    applyHostedWebZoom(1.1);
    stubZoomedBody(1.1);
    // The row as the browser reports it: rects are zoomed, so 100px of layout is 110px on screen.
    const panel = openSubmenuAt({ left: 110, top: 55, width: 110, height: 22 });
    // A style `left` is zoomed again on screen, so the panel must be written in layout pixels:
    // the row's right edge (220 zoomed → 200 layout) less the 3px overlap.
    expect(parseFloat(panel.style.left)).toBeCloseTo(197, 1);
    expect(parseFloat(panel.style.top)).toBeCloseTo(50 - 4, 1);
  });

  it("is unchanged at zoom 1, as in Electron", () => {
    stubZoomedBody(1);
    const panel = openSubmenuAt({ left: 110, top: 55, width: 110, height: 22 });
    expect(parseFloat(panel.style.left)).toBeCloseTo(217, 1);
    expect(parseFloat(panel.style.top)).toBeCloseTo(51, 1);
  });
});
