/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppControlMenu, AppControlMenuItem } from "./AppControlMenu";

/**
 * The pane clips this menu, not the viewport.
 *
 * jsdom lays nothing out, so the two rects the measurement reads — the
 * trigger's bottom and the clipping ancestor's bottom — are supplied here.
 */
function stubLayout(options: { triggerBottom: number; paneBottom: number }): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const bottom = this.dataset.testid === "pane"
      ? options.paneBottom
      : this.tagName === "BUTTON" ? options.triggerBottom : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, height: 0, bottom, toJSON: () => ({}) } as DOMRect;
  });
}

function renderMenu() {
  return render(
    <div data-testid="pane" style={{ overflowX: "hidden", overflowY: "hidden" }}>
      <AppControlMenu ariaLabel="Tools">
        {(close) => <AppControlMenuItem label="Stop" onSelect={close} />}
      </AppControlMenu>
    </div>,
  );
}

describe("AppControlMenu", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("sizes itself against the pane that clips it, not the viewport", () => {
    // `max-h-[min(70vh,480px)]` measures the WINDOW, and this menu is anchored
    // inside an `overflow-hidden` pane — so on a short pane the last item was
    // cut off with no scrollbar to say it was there.
    stubLayout({ triggerBottom: 40, paneBottom: 300 });
    renderMenu();

    fireEvent.click(screen.getByLabelText("Tools"));
    const menu = screen.getByRole("menu");
    // 300 (pane bottom) − 40 (trigger) − 4 (anchor offset) − 8 (gutter).
    expect(menu.style.maxHeight).toBe("248px");
    expect(menu.className).toContain("overflow-y-auto");
  });

  it("stops shrinking at a height a menu can still be used at", () => {
    stubLayout({ triggerBottom: 40, paneBottom: 100 });
    renderMenu();

    fireEvent.click(screen.getByLabelText("Tools"));
    // Below the floor a scrolling menu is worse than a clipped one.
    expect(screen.getByRole("menu").style.maxHeight).toBe("160px");
  });

  it("re-measures when the window changes size", () => {
    stubLayout({ triggerBottom: 40, paneBottom: 300 });
    renderMenu();
    fireEvent.click(screen.getByLabelText("Tools"));
    expect(screen.getByRole("menu").style.maxHeight).toBe("248px");

    stubLayout({ triggerBottom: 40, paneBottom: 500 });
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("menu").style.maxHeight).toBe("448px");
  });
});
