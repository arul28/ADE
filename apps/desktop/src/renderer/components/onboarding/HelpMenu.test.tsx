/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetHostedWebZoomForTests, applyHostedWebZoom } from "../../lib/webZoom";
import { HelpMenu } from "./HelpMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetHostedWebZoomForTests();
  delete (document.body as unknown as { offsetWidth?: number }).offsetWidth;
  delete (document.body as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

describe("HelpMenu placement under the hosted web zoom", () => {
  it("opens under its button in layout pixels, not screen pixels (fails before the fix)", () => {
    // The body is 1000 layout px, rendered 1.1 times wider. The button is a 22px box at screen (880, 66).
    Object.defineProperty(document.body, "offsetWidth", { configurable: true, value: 1000 });
    document.body.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1100, height: 880, right: 1100, bottom: 880, x: 0, y: 0, toJSON: () => ({}) });
    applyHostedWebZoom(1.1);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = this.getAttribute("aria-label") === "Help menu"
        ? { left: 880, top: 66, width: 22, height: 22 }
        : { left: 0, top: 0, width: 0, height: 0 };
      return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect;
    });
    render(<HelpMenu align="start" />);
    fireEvent.click(screen.getByRole("button", { name: "Help menu" }));
    const menu = screen.getByRole("menu", { name: "Help" });
    // In layout px the button is at (800, 60), 20 x 20, so the menu opens at left 800 and 6px below its bottom (80).
    expect(parseFloat(menu.style.left)).toBeCloseTo(800, 6);
    expect(parseFloat(menu.style.top)).toBeCloseTo(86, 6);
  });
});
