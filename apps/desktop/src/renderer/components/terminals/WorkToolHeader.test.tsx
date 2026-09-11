/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkToolHeader,
  WORK_TOOL_TAB_LABEL_MIN_PX,
  workToolStripBudget,
  workToolTabLayout,
} from "./WorkToolHeader";
import type { WorkToolContext } from "./workTools";
import type { WorkToolStatusMap } from "./useWorkToolStatuses";

const LOCAL: WorkToolContext = {
  isRemoteProject: false,
  supportsIosSimulator: true,
  isWebClient: false,
};

function renderHeader(overrides: Partial<Parameters<typeof WorkToolHeader>[0]> = {}) {
  const props = {
    activeTool: "browser" as const,
    openTools: ["terminal", "browser"] as const,
    context: LOCAL,
    contextLabel: "example.com",
    statuses: {} as WorkToolStatusMap,
    onShowPicker: vi.fn(),
    onPick: vi.fn(),
    onCloseTool: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<WorkToolHeader {...props} />), props };
}

describe("WorkToolHeader tab strip", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** Forces the strip below its label threshold, so the tabs are 24px glyphs. */
  function measureNarrow(px: number): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: px,
      height: 36,
      top: 0,
      left: 0,
      right: px,
      bottom: 36,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  /** Header and dot group measured separately, as the real ResizeObservers do. */
  function measureGroup(headerPx: number, groupPx: number): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const px = this.getAttribute("aria-label") === "Other active tools" ? groupPx : headerPx;
      return {
        width: px,
        height: 36,
        top: 0,
        left: 0,
        right: px,
        bottom: 36,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
  }

  it("draws one tab per open tool and lights the one on screen", () => {
    renderHeader();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("data-tool-tab")).toBe("terminal");
    expect(tabs[1].getAttribute("data-tool-tab")).toBe("browser");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
  });

  it("carries the active tool's one fact in its tab, never as a header line", () => {
    renderHeader();
    // The context string is the active tab's accessible name/tooltip…
    expect(screen.getByRole("tab", { selected: true }).getAttribute("aria-label"))
      .toBe("Browser · example.com");
    // …and nothing in the bar spells it out as a title.
    expect(screen.queryByText("example.com")).toBeNull();
  });

  it("switches tabs and closes them through their own controls", () => {
    const { props } = renderHeader();
    fireEvent.click(screen.getByRole("tab", { name: /^Terminal/ }));
    expect(props.onPick).toHaveBeenCalledWith("terminal");

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));
    expect(props.onCloseTool).toHaveBeenCalledWith("terminal");
  });

  it("offers a + that opens the picker, and drops it once the picker is up", () => {
    const { props, rerender } = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Open another tool" }));
    expect(props.onShowPicker).toHaveBeenCalled();

    rerender(<WorkToolHeader {...props} activeTool={null} />);
    // Two controls opening one page is one too many; the grid button lights
    // instead and keeps the strip visible behind the picker.
    expect(screen.queryByRole("button", { name: "Open another tool" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to tools" }).getAttribute("data-state"))
      .toBe("open");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("tab", { selected: true })).toBeNull();
  });

  it("keeps a dot for a live tool that has no tab, and none for one that does", () => {
    const statuses: WorkToolStatusMap = {
      terminal: { line: "2 shells", live: true },
      git: { line: "3 changes", live: true },
    };
    renderHeader({ statuses });
    // Terminal is a tab, so its state rides on the tab.
    expect(document.querySelector('[data-tool-dot="terminal"]')).toBeNull();
    expect(document.querySelector('[data-tool-dot="git"]')).toBeTruthy();
  });

  it("keeps the centre of an icon-only tab a select target, never a close one", () => {
    measureNarrow(WORK_TOOL_TAB_LABEL_MIN_PX - 120);
    const { props } = renderHeader();

    const tab = screen.getByRole("tab", { name: /^Terminal/ });
    const close = document.querySelector<HTMLElement>('[data-tool-tab-close="terminal"]');
    expect(close).toBeTruthy();
    // The contract, not the class string: on a 24px tab the ✕ is a corner
    // badge, because a full-size target over the middle means the obvious
    // click — dead centre, on the glyph — closes the tool instead of opening
    // it. One style smoke check for the part CSS alone enforces: `opacity-0`
    // still hit-tests, so the badge must also be untouchable at rest.
    expect(close?.getAttribute("data-tool-tab-close-mode")).toBe("corner");
    expect(close?.className).toContain("pointer-events-none");

    fireEvent.click(tab);
    expect(props.onPick).toHaveBeenCalledWith("terminal");
    expect(props.onCloseTool).not.toHaveBeenCalled();
  });

  it("reserves the ✕ inside a labelled tab instead of badging its corner", () => {
    renderHeader();
    const close = document.querySelector<HTMLElement>('[data-tool-tab-close="terminal"]');
    expect(close?.getAttribute("data-tool-tab-close-mode")).toBe("inline");
  });

  it("budgets the strip around the activity dots it is standing beside", () => {
    // Four live tools with no tab, in a 200px row: the dot group is a measured
    // sibling of the strip, so the space it stands in is not the strip's to
    // spend. Same row, same tabs, dots or no dots:
    const statuses: WorkToolStatusMap = {
      git: { line: "3 changes", live: true },
      files: { line: "open", live: true },
      ios: { line: "booted", live: true },
      "app-control": { line: "attached", live: true },
    };
    const strip = ["terminal", "browser"] as const;

    measureNarrow(200);
    renderHeader({ openTools: strip, activeTool: "browser" });
    // Nothing beside the strip: both glyphs fit and there is no menu.
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /more open tools/ })).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    measureGroup(200, 120);
    renderHeader({ statuses, openTools: strip, activeTool: "browser" });
    expect(screen.getByRole("group", { name: "Other active tools" })).toBeTruthy();
    // 200 − 120 dots − 4 gap: the second tab goes to the menu instead of being
    // drawn into space the dots are already occupying.
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /more open tools/ })).toBeTruthy();
    // The tool on screen is still the one drawn.
    expect(screen.getByRole("tab").getAttribute("data-tool-tab")).toBe("browser");
  });

  it("keeps an unmeasured row unmeasured and never budgets the strip to nothing", () => {
    expect(workToolStripBudget(360, 120)).toBe(236);
    expect(workToolStripBudget(360, 0)).toBe(360);
    // Zero reads as "not measured yet, show everything", so a dot group wider
    // than the row must still leave a measured budget.
    expect(workToolStripBudget(0, 120)).toBe(0);
    expect(workToolStripBudget(100, 400)).toBe(1);
    expect(workToolTabLayout(["terminal", "browser"], "browser", 1).overflow)
      .toEqual(["terminal"]);
  });

  it("keeps the overflow menu button out of the tablist", () => {
    measureNarrow(180);
    renderHeader({
      openTools: ["terminal", "browser", "git", "files"],
      activeTool: "terminal",
    });

    const trigger = screen.getByRole("button", { name: /more open tools/ });
    // A tablist whose children are not all tabs is a broken tablist.
    expect(trigger.closest('[role="tablist"]')).toBeNull();
    const tablist = screen.getByRole("tablist");
    for (const child of Array.from(tablist.children)) {
      expect(child.querySelector('[role="tab"]')).toBeTruthy();
    }
  });

  it("gives the strip one tab stop and moves between tabs with the arrows", () => {
    const { props } = renderHeader();
    const tabs = screen.getAllByRole("tab");
    // Roving tabindex: Tab lands on the tool you are looking at, not on the
    // first of six.
    expect(tabs[0].getAttribute("tabindex")).toBe("-1");
    expect(tabs[1].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("aria-controls")).toBe("work-tool-panel-browser");
    expect(tabs[0].getAttribute("aria-controls")).toBeNull();

    tabs[1].focus();
    fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[0]);
    // Manual activation: arrowing past a tool must not attach its terminal.
    expect(props.onPick).not.toHaveBeenCalled();

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("keeps the close ✕ out of the tab order and closes with Delete instead", () => {
    // Six open tools would otherwise put six extra stops between the strip and
    // the panel, which is exactly what the roving tabindex above exists to
    // avoid. The keyboard closes from the tab itself.
    const { props } = renderHeader();
    const closes = Array.from(document.querySelectorAll('[data-tool-tab-close]'));
    expect(closes.length).toBeGreaterThan(0);
    for (const close of closes) expect(close.getAttribute("tabindex")).toBe("-1");

    const tabs = screen.getAllByRole("tab");
    tabs[1].focus();
    fireEvent.keyDown(tabs[1], { key: "Delete" });
    expect(props.onCloseTool).toHaveBeenCalledWith("browser");

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "Backspace" });
    expect(props.onCloseTool).toHaveBeenCalledWith("terminal");
  });

  it("renders the strip with no tabs at all", () => {
    renderHeader({ activeTool: null, openTools: [] });
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Back to tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Tools sidebar" })).toBeTruthy();
  });
});

describe("workToolTabLayout", () => {
  const strip = ["terminal", "browser", "git", "files"] as const;

  it("shows everything before it has been measured", () => {
    const layout = workToolTabLayout(strip, "git", 0);
    expect(layout.visible).toEqual([...strip]);
    expect(layout.overflow).toEqual([]);
    expect(layout.showLabels).toBe(true);
  });

  it("drops labels before it drops tabs", () => {
    const wide = workToolTabLayout(["terminal", "browser"], "browser", 900);
    expect(wide.showLabels).toBe(true);
    expect(wide.overflow).toEqual([]);

    const narrow = workToolTabLayout(["terminal", "browser"], "browser", WORK_TOOL_TAB_LABEL_MIN_PX - 1);
    expect(narrow.showLabels).toBe(false);
    // Two glyphs still fit in a 419px pane; only the words are gone.
    expect(narrow.visible).toEqual(["terminal", "browser"]);

    // Wide enough for words, but not for six of them: glyphs, not a menu.
    const crowded = workToolTabLayout(
      ["terminal", "browser", "git", "files", "ios", "app-control"],
      "git",
      WORK_TOOL_TAB_LABEL_MIN_PX + 40,
    );
    expect(crowded.showLabels).toBe(false);
    expect(crowded.overflow).toEqual([]);
  });

  it("overflows the extra tabs into the menu and never the one on screen", () => {
    // Narrower than the pane splitter allows, so the "…" is provably reachable.
    const layout = workToolTabLayout(strip, "files", 180);
    expect(layout.showLabels).toBe(false);
    expect(layout.visible.length + layout.overflow.length).toBe(strip.length);
    expect(layout.overflow.length).toBeGreaterThan(0);
    // The tool being looked at is always drawn, whatever its place in the strip.
    expect(layout.visible).toContain("files");
    expect(layout.overflow).not.toContain("files");
  });

  it("always draws at least one tab", () => {
    const layout = workToolTabLayout(strip, "browser", 96);
    expect(layout.visible).toEqual(["browser"]);
    expect(layout.overflow).toHaveLength(strip.length - 1);
  });
});
