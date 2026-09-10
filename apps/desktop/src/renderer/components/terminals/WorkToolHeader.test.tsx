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
  afterEach(cleanup);

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
