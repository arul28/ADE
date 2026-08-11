import { describe, expect, it, vi } from "vitest";

import type { PluginMenuEntry } from "./contributionModel";
import { PLUGIN_MENU_SECTION_LABEL, pluginContextMenuItems } from "./pluginContextMenuItems";

/**
 * The adapter's job is one rule the four surfaces used to each decide for
 * themselves: a contributed row says whose it is, and it only gets to wear the
 * product's destructive colour where it does.
 */

function entry(overrides: Partial<PluginMenuEntry> = {}): PluginMenuEntry {
  return {
    kind: "action",
    key: "graph:row-menu-item:open",
    label: "Open graph",
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe("contributed menu rows", () => {
  it("puts every entry under one attributed section", () => {
    const items = pluginContextMenuItems([entry(), entry({ key: "b", label: "Prune" })]);

    expect(items[0]).toEqual({ type: "separator" });
    expect(items[1]).toEqual({ type: "header", label: PLUGIN_MENU_SECTION_LABEL });
    expect(items.slice(2).map((item) => (item.type === "item" ? item.label : item.type)))
      .toEqual(["Open graph", "Prune"]);
  });

  it("never emits a destructive row without the attribution above it", () => {
    const items = pluginContextMenuItems([entry({ danger: true })]);

    const danger = items.findIndex((item) => item.type === "item" && item.danger === true);
    const header = items.findIndex((item) => item.type === "header");
    expect(danger).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    expect(header).toBeLessThan(danger);
  });

  it("adds nothing at all when a surface has no contributed rows", () => {
    // Not a lone separator or an empty heading: a menu with no plugin section
    // must look exactly as it did before plugins existed.
    expect(pluginContextMenuItems([])).toEqual([]);
  });

  it("keeps each entry's own handler", () => {
    const onSelect = vi.fn();
    const items = pluginContextMenuItems([entry({ onSelect })]);

    const row = items.find((item) => item.type === "item");
    if (row?.type !== "item") throw new Error("expected a contributed row");
    row.onClick();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
