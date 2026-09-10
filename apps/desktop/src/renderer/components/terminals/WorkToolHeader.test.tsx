/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkToolHeader,
  WORK_TOOL_TAB_LABEL_MIN_PX,
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
    // The 24px square: no room for a label, and none for a centred ✕ either.
    expect(tab.className).toContain("w-6");

    const close = document.querySelector<HTMLElement>('[data-tool-tab-close="terminal"]');
    expect(close).toBeTruthy();
    // `opacity-0` alone still hit-tests, which is how a click dead centre on
    // the glyph used to close the tool instead of opening it.
    expect(close?.className).toContain("pointer-events-none");
    expect(close?.className).toContain("group-hover/tab:pointer-events-auto");
    // A corner badge, not a full-size target laid over the tab's middle.
    expect(close?.className).not.toContain("mx-auto");
    expect(close?.className).toContain("right-0");
    expect(close?.className).toContain("top-0");

    fireEvent.click(tab);
    expect(props.onPick).toHaveBeenCalledWith("terminal");
    expect(props.onCloseTool).not.toHaveBeenCalled();
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
