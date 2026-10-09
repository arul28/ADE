/* @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { sanitizeProductAnalyticsProperties } from "../../../main/services/analytics/productAnalyticsPolicy";
import {
  HOME_LAYOUTS_STORAGE_KEY,
  HOME_LAYOUT_PRESETS_MAX,
  defaultHomeLayout,
  layoutCells,
  normalizeHomeLayouts,
  useHomeLayoutStore,
  type HomeLayoutItem,
  type HomeWidgetType,
} from "./homeLayout";
import { GRID_GAP, gridMetrics, packLayout } from "./homeGridPack";
import { HOME_WIDGET_CATALOG, widgetShape } from "./homeWidgetCatalog";
import { useHomeAppEffects } from "./useHomeAppEffects";

const layoutWith = (items: HomeLayoutItem[]) => ({ ...defaultHomeLayout(), items });
const preset = (id: string, name: string, items: HomeLayoutItem[] = [{ id: "clock", type: "clock", size: "s" }]) => ({ id, name, layout: layoutWith(items) });

describe("stored home layouts", () => {
  const legacy = layoutWith([{ id: "feed", type: "feed", size: "l" }]);

  it.each([
    ["nothing stored", null, null, ["default"], "default", ["projects", "running", "activity", "limits", "prs"]],
    ["only a version 1 layout (migrates as Default)", null, legacy, ["default"], "default", ["feed"]],
    ["an unreadable version 2 next to version 1", { presets: "nope" }, legacy, ["default"], "default", ["feed"]],
    ["a version 2 with no usable preset", { activeId: "x", presets: [null, { id: "" }] }, legacy, ["default"], "default", ["feed"]],
    ["a version 2 whose active id is gone", { activeId: "gone", presets: [preset("a", "A"), preset("b", "B")] }, legacy, ["a", "b"], "a", ["clock"]],
    ["a version 2 with duplicate ids", { activeId: "b", presets: [preset("a", "A"), preset("a", "Again"), preset("b", "B")] }, null, ["a", "b"], "b", ["clock"]],
    [
      "more presets than the limit",
      { activeId: "p0", presets: Array.from({ length: HOME_LAYOUT_PRESETS_MAX + 5 }, (_, i) => preset(`p${i}`, `P${i}`)) },
      null,
      Array.from({ length: HOME_LAYOUT_PRESETS_MAX }, (_, i) => `p${i}`),
      "p0",
      ["clock"],
    ],
  ])("reads %s", (_label, stored, legacyLayout, presetIds, activeId, activeTypes) => {
    const layouts = normalizeHomeLayouts(stored, legacyLayout);
    expect(layouts.presets.map((entry) => entry.id)).toEqual(presetIds);
    expect(layouts.activeId).toBe(activeId);
    const active = layouts.presets.find((entry) => entry.id === layouts.activeId)!;
    expect(active.layout.items.map((item) => item.type)).toEqual(activeTypes);
  });

  it("drops unknown widgets and repeated ids inside a layout, and reads old free-resize cells as size classes", () => {
    const layouts = normalizeHomeLayouts(null, {
      items: [
        { id: "a", type: "clock", w: 2, h: 2 },
        { id: "a", type: "feed", size: "l" },
        { id: "b", type: "spreadsheet", size: "m" },
        { id: "c", type: "machine", w: 2, h: 1, stacked: true },
        { id: "d", type: "pomodoro", w: 1, h: 1 },
      ],
    });
    expect(layouts.presets[0]!.layout.items).toEqual([
      { id: "a", type: "clock", size: "l" },
      { id: "c", type: "machine", size: "w", stacked: true },
      { id: "d", type: "pomodoro", size: "s" },
    ]);
  });

  it("follows another window's save instead of keeping its own older copy", () => {
    renderHook(() => useHomeAppEffects());
    useHomeLayoutStore.getState().setEditing(true);
    const saved = { version: 2, activeId: "focus", presets: [preset("default", "Default"), preset("focus", "Focus", [{ id: "pomodoro", type: "pomodoro", size: "m" }])] };

    window.localStorage.setItem(HOME_LAYOUTS_STORAGE_KEY, JSON.stringify(saved));
    window.dispatchEvent(new StorageEvent("storage", { key: HOME_LAYOUTS_STORAGE_KEY }));

    const state = useHomeLayoutStore.getState();
    expect(state.activeId).toBe("focus");
    expect(state.presets.map((entry) => entry.name)).toEqual(["Default", "Focus"]);
    expect(state.layout.items.map((item) => item.type)).toEqual(["pomodoro"]);
    // Editing here is this window's own state.
    expect(state.editing).toBe(true);
  });
});

describe("editing the home grid", () => {
  const order = () => useHomeLayoutStore.getState().layout.items.map((item) => `${item.id}${item.stacked ? "^" : ""}`);

  it("moves a widget with the widgets stacked under it, and hands its cell to the first of them when it goes", () => {
    const store = useHomeLayoutStore.getState();
    store.reset();
    // Default: projects with running stacked under it, then activity, limits, prs.
    expect(order()).toEqual(["projects", "running^", "activity", "limits", "prs"]);

    useHomeLayoutStore.getState().moveCell("projects", "prs", "after");
    expect(order()).toEqual(["activity", "limits", "prs", "projects", "running^"]);
    useHomeLayoutStore.getState().nudgeCell("projects", -1);
    expect(order()).toEqual(["activity", "limits", "projects", "running^", "prs"]);

    useHomeLayoutStore.getState().remove("projects");
    expect(order()).toEqual(["activity", "limits", "running", "prs"]);
    // It takes the removed host's size, too.
    expect(useHomeLayoutStore.getState().layout.items.find((item) => item.id === "running")?.size).toBe("m");
  });
});

describe("adding home widgets", () => {
  it("reports which widget was added, by a name the analytics allowlist keeps, for every widget there is", () => {
    // A widget type added to the catalog and not to the allowlist would ship
    // anonymous; this is the failure it pins.
    const capture = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", { configurable: true, writable: true, value: { analytics: { capture } } });
    const types = Object.keys(HOME_WIDGET_CATALOG) as HomeWidgetType[];

    for (const type of types) useHomeLayoutStore.getState().add(type, "s");

    expect(capture).toHaveBeenCalledTimes(types.length);
    const outcomes = new Set<unknown>();
    for (const [payload] of capture.mock.calls as unknown as Array<[{ properties: Record<string, unknown>; dedupeKey: string }]>) {
      expect(payload.properties).toMatchObject({ feature: "home", action: "widget_added" });
      expect(sanitizeProductAnalyticsProperties("ade_feature_used", payload.properties as Parameters<typeof sanitizeProductAnalyticsProperties>[1])).toEqual(payload.properties);
      expect(payload.dedupeKey).toBe(`home_widget_added:${payload.properties.outcome}`);
      outcomes.add(payload.properties.outcome);
    }
    expect(outcomes.size).toBe(types.length);
    expect(outcomes.has("widget_now_playing")).toBe(true);
    useHomeLayoutStore.getState().reset();
  });
});

describe("packing the home grid", () => {
  const ALL: HomeWidgetType[] = ["projects", "running", "activity", "limits", "prs", "clock", "pomodoro", "clipboard", "machine", "heatmap", "shipped", "feed", "nowPlaying"];
  const items = (types: HomeWidgetType[], size: HomeLayoutItem["size"] = "m"): HomeLayoutItem[] =>
    types.map((type, index) => ({ id: `${type}-${index}`, type, size }));

  /** Every placement is inside the grid and no two overlap; returns the cells covered. */
  function coverage(result: ReturnType<typeof packLayout>, columns: number): number {
    const owner = new Map<string, string>();
    for (const placement of result.placed) {
      expect(placement.x + placement.w).toBeLessThanOrEqual(columns);
      expect(placement.y + placement.h).toBeLessThanOrEqual(result.rows);
      for (let y = placement.y; y < placement.y + placement.h; y += 1) {
        for (let x = placement.x; x < placement.x + placement.w; x += 0.5) {
          expect(owner.has(`${x},${y}`)).toBe(false);
          owner.set(`${x},${y}`, placement.cell.host.id);
        }
      }
    }
    return owner.size / 2;
  }

  it.each([
    ["the default layout on a laptop", defaultHomeLayout().items, 1_180, 760],
    ["the default layout on a wide monitor", defaultHomeLayout().items, 2_400, 1_300],
    ["every widget at Regular on a wide monitor", items(ALL), 2_400, 1_300],
    ["four widgets on a short window", items(["clock", "feed", "machine", "prs"], "s"), 1_180, 420],
  ])("lays out %s the same way every time, with no overlaps and no holes", (_label, layoutItems, width, height) => {
    const metrics = gridMetrics(width, height);
    const cells = layoutCells(layoutItems);
    const first = packLayout(cells, metrics, widgetShape);
    const second = packLayout(layoutCells(layoutItems.map((item) => ({ ...item }))), metrics, widgetShape);

    expect(second).toEqual(first);
    expect(first.holes).toBe(0);
    expect(coverage(first, first.columns) + first.trailing).toBe(first.columns * first.rows);
    expect(first.columns).toBeLessThanOrEqual(metrics.columns);
    if (first.trailing > 0) {
      const lastCard = first.placed.filter((placement) => placement.y + placement.h === first.rows)
        .sort((a, b) => (b.x + b.w) - (a.x + a.w))[0]!;
      expect(lastCard.w).toBeLessThanOrEqual(widgetShape(lastCard.cell.host.type).classes[lastCard.cls]!.w);
    }
    expect(Math.min(...first.placed.map((placement) => placement.y))).toBe(0);
    if (width === 2_400) {
      expect(first.rows * first.rowPx + (first.rows - 1) * GRID_GAP).toBeLessThan(metrics.height);
      for (const placement of first.placed) {
        const shape = widgetShape(placement.cell.host.type);
        const stackedHeight = placement.cell.stacked.reduce((sum, item) =>
          sum + GRID_GAP + Math.round((widgetShape(item.type).minHeight.compact ?? 160) * 0.75), 0);
        const cardHeight = placement.h * first.rowPx + (placement.h - 1) * GRID_GAP - stackedHeight;
        expect(cardHeight).toBeGreaterThanOrEqual(shape.minHeight[placement.cls]!);
        expect(cardHeight).toBeLessThanOrEqual(shape.maxHeight[placement.cls]!);
      }
      if (_label === "the default layout on a wide monitor") expect(first.columns).toBeLessThan(metrics.columns);
    }
    expect(first.placed.length + first.hidden.length).toBe(cells.length);
  });

  it("hides nothing when every widget fits, and shrinks a widget before it hides one", () => {
    const roomy = gridMetrics(2_400, 1_300);
    const fits = packLayout(layoutCells(defaultHomeLayout().items), roomy, widgetShape);
    expect(fits.hidden).toEqual([]);
    expect(fits.shrunk).toBe(0);

    // Two columns, one row, a clock in the first: a widget asked at Large
    // (two columns wide) has no room at that size, but does one size down.
    const big = ALL.find((type) => {
      const shape = widgetShape(type);
      return shape.classes.large?.w === 2 && shape.classes.regular?.w === 1 && (shape.minHeight.regular ?? 0) <= 250;
    })!;
    const oneRow = gridMetrics(2 * 360 + 12, 250);
    expect([oneRow.columns, oneRow.maxRows]).toEqual([2, 1]);
    const tight = packLayout(layoutCells([{ id: "clock", type: "clock", size: "s" }, { id: "big", type: big, size: "l" }]), oneRow, widgetShape);
    expect(tight.hidden).toEqual([]);
    expect(tight.placed.find((placement) => placement.cell.host.id === "big")?.cls).toBe("regular");
    expect(tight.shrunk).toBe(1);
  });
});
