import { describe, expect, it } from "vitest";

import {
  applyPluginToolbarOrder,
  movePluginToolbarItem,
  parsePluginToolbarOrder,
  pluginToolbarOrderStorageKey,
  sanitizeToolbarOrderUserId,
  visiblePluginToolbarCount,
} from "./pluginToolbarOrder";

describe("plugin toolbar order", () => {
  it("keeps a user-scoped key path-safe on Windows", () => {
    expect(sanitizeToolbarOrderUserId("User/A:1")).toBe("user_a_1");
    expect(sanitizeToolbarOrderUserId("User\\A")).toBe("user_a");
    expect(sanitizeToolbarOrderUserId("A*B?C")).toBe("a_b_c");
    expect(sanitizeToolbarOrderUserId("  ")).toBe("local");
    expect(sanitizeToolbarOrderUserId(null)).toBe("local");
    expect(pluginToolbarOrderStorageKey("Alice")).toBe("ade.plugin.toolbarOrder.v1:alice");
    expect(pluginToolbarOrderStorageKey("alice")).toBe("ade.plugin.toolbarOrder.v1:alice");
  });

  it("applies the saved order and appends anything new at the end", () => {
    const items = [
      { pluginId: "a", id: "one" },
      { pluginId: "b", id: "two" },
      { pluginId: "c", id: "three" },
    ];
    expect(applyPluginToolbarOrder(items, [
      { pluginId: "c", id: "three" },
      { pluginId: "a", id: "one" },
    ])).toEqual([
      { pluginId: "c", id: "three" },
      { pluginId: "a", id: "one" },
      { pluginId: "b", id: "two" },
    ]);
  });

  it("ignores saved ids that are no longer published", () => {
    expect(applyPluginToolbarOrder(
      [{ pluginId: "a", id: "one" }],
      [{ pluginId: "gone", id: "x" }, { pluginId: "a", id: "one" }],
    )).toEqual([{ pluginId: "a", id: "one" }]);
  });

  it("parses only well-formed { pluginId, id } rows", () => {
    expect(parsePluginToolbarOrder(JSON.stringify([
      { pluginId: "a", id: "one" },
      { pluginId: "a" },
      null,
      { pluginId: "a", id: "one" },
    ]))).toEqual([{ pluginId: "a", id: "one" }]);
    expect(parsePluginToolbarOrder("not-json")).toEqual([]);
  });

  it("shows every button when the container has no layout width", () => {
    expect(visiblePluginToolbarCount([40, 40, 40], 0, 20, 6)).toBe(3);
  });

  it("reserves the chevron only when something would hide", () => {
    expect(visiblePluginToolbarCount([40, 40], 90, 20, 6)).toBe(2);
    expect(visiblePluginToolbarCount([40, 40, 40], 90, 20, 6)).toBe(1);
  });

  it("moves an item and no-ops an out-of-range drop", () => {
    expect(movePluginToolbarItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(movePluginToolbarItem(["a", "b"], 0, 9)).toEqual(["a", "b"]);
  });
});
