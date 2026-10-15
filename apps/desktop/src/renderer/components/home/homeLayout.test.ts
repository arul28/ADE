/* @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { sanitizeProductAnalyticsProperties } from "../../../main/services/analytics/productAnalyticsPolicy";
import {
  HOME_DEFAULT_STACK_VERSION,
  HOME_LAYOUTS_STORAGE_KEY,
  HOME_LAYOUT_PRESETS_MAX,
  HOME_LAYOUT_PRESETS_STORED_MAX,
  HOME_LAYOUT_STORAGE_KEY,
  defaultHomeLayout,
  layoutCells,
  normalizeHomeLayouts,
  reloadHomeLayoutsFromStorage,
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
  /** The shipped stack, as the types the page shows. */
  const shipped = defaultHomeLayout().items.map((item) => item.type);
  /** A version 2 store this build wrote: it has already taken the shipped stack. */
  const current = { defaultStack: HOME_DEFAULT_STACK_VERSION };

  it.each([
    ["nothing stored", null, ["default"], "default", shipped],
    ["a version 2 whose active id is gone", { ...current, activeId: "gone", presets: [preset("a", "A"), preset("b", "B")] }, ["a", "b"], "a", ["clock"]],
    ["a version 2 with duplicate ids", { ...current, activeId: "b", presets: [preset("a", "A"), preset("a", "Again"), preset("b", "B")] }, ["a", "b"], "b", ["clock"]],
    [
      "more presets than a store holds",
      { ...current, activeId: "p0", presets: Array.from({ length: HOME_LAYOUT_PRESETS_STORED_MAX + 5 }, (_, i) => preset(`p${i}`, `P${i}`)) },
      Array.from({ length: HOME_LAYOUT_PRESETS_STORED_MAX }, (_, i) => `p${i}`),
      "p0",
      ["clock"],
    ],
  ])("reads %s", (_label, stored, presetIds, activeId, activeTypes) => {
    const layouts = normalizeHomeLayouts(stored);
    expect(layouts.presets.map((entry) => entry.id)).toEqual(presetIds);
    expect(layouts.activeId).toBe(activeId);
    const active = layouts.presets.find((entry) => entry.id === layouts.activeId)!;
    expect(active.layout.items.map((item) => item.type)).toEqual(activeTypes);
  });

  it.each([
    ["a store nothing has marked yet", {} as Record<string, unknown>],
    ["a store one shipped stack behind", { defaultStack: HOME_DEFAULT_STACK_VERSION - 1 } as Record<string, unknown>],
  ])("puts the shipped stack in as Default and shows it: %s", (_label, marker) => {
    const stored = {
      ...marker,
      activeId: "focus",
      presets: [preset("default", "My corner", [{ id: "feed", type: "feed", size: "m" }]), preset("focus", "Focus", [{ id: "pomodoro", type: "pomodoro", size: "m" }])],
    };
    const layouts = normalizeHomeLayouts(stored);

    expect(layouts.presets.map((entry) => entry.id)).toEqual(["default", "focus"]);
    expect(layouts.activeId).toBe("default");
    const shippedPreset = layouts.presets[0]!;
    expect(shippedPreset.name).toBe("Default");
    expect(shippedPreset.layout.items.map((item) => item.type)).toEqual(shipped);
    // The layout the user saved themselves stays, under its own name.
    expect(layouts.presets[1]!.name).toBe("Focus");
    expect(layouts.presets[1]!.layout.items.map((item) => item.type)).toEqual(["pomodoro"]);
    // Never more presets than the page keeps room for.
    expect(layouts.presets.length).toBeLessThanOrEqual(HOME_LAYOUT_PRESETS_MAX);
  });

  it("keeps every saved layout when the shipped stack takes its slot", () => {
    // A store at the user's limit with no "default" preset left (it can be
    // deleted): the shipped stack needs one slot, and it takes one the store
    // has room for — nothing the user saved is dropped.
    const full = Array.from({ length: HOME_LAYOUT_PRESETS_MAX }, (_, i) => preset(`p${i}`, `P${i}`));
    const layouts = normalizeHomeLayouts({ activeId: "p7", presets: full });

    expect(layouts.activeId).toBe("default");
    expect(layouts.presets).toHaveLength(HOME_LAYOUT_PRESETS_STORED_MAX);
    expect(layouts.presets.map((entry) => entry.id)).toEqual([
      "default", "p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11",
    ]);
    // What was written down stays: reading the migrated store again leaves it alone.
    const again = normalizeHomeLayouts({ ...layouts });
    expect(again.presets.map((entry) => entry.id)).toEqual(layouts.presets.map((entry) => entry.id));
  });

  it("gives a store from before the presets the shipped stack, and keeps its layout", () => {
    const legacy = layoutWith([{ id: "feed", type: "feed", size: "l" }]);
    const layouts = normalizeHomeLayouts(null, legacy);

    expect(layouts.presets.map((entry) => entry.id)).toEqual(["default", "previous"]);
    expect(layouts.activeId).toBe("default");
    expect(layouts.presets[0]!.layout.items.map((item) => item.type)).toEqual(shipped);
    expect(layouts.presets[1]!.layout.items.map((item) => item.type)).toEqual(["feed"]);
    // An unreadable version 2 falls back the same way.
    expect(normalizeHomeLayouts("not a store", legacy).presets[1]!.name).toBe("Previous layout");
  });

  it("writes the shipped stack down, so the migration happens once", () => {
    window.localStorage.setItem(HOME_LAYOUTS_STORAGE_KEY, JSON.stringify({
      activeId: "focus",
      presets: [preset("focus", "Focus", [{ id: "pomodoro", type: "pomodoro", size: "m" }])],
    }));
    reloadHomeLayoutsFromStorage();
    expect(useHomeLayoutStore.getState().layout.items.map((item) => item.type)).toEqual(shipped);

    // The next read sees the marker and leaves the store alone.
    const saved = JSON.parse(window.localStorage.getItem(HOME_LAYOUTS_STORAGE_KEY)!) as { defaultStack: number };
    expect(saved.defaultStack).toBe(HOME_DEFAULT_STACK_VERSION);
    useHomeLayoutStore.getState().remove("clock");
    reloadHomeLayoutsFromStorage();
    expect(useHomeLayoutStore.getState().layout.items.map((item) => item.type)).toEqual(["projects", "running", "prs", "heatmap"]);
    window.localStorage.removeItem(HOME_LAYOUTS_STORAGE_KEY);
    window.localStorage.removeItem(HOME_LAYOUT_STORAGE_KEY);
  });

  it("lets the user keep their saved layouts to the limit, with the shipped Default as one more", () => {
    const mine = Array.from({ length: HOME_LAYOUT_PRESETS_MAX - 1 }, (_, i) => preset(`p${i}`, `P${i}`));
    window.localStorage.setItem(HOME_LAYOUTS_STORAGE_KEY, JSON.stringify({
      defaultStack: HOME_DEFAULT_STACK_VERSION,
      activeId: "default",
      presets: [preset("default", "Default"), ...mine],
    }));
    reloadHomeLayoutsFromStorage();

    // Eleven of their own plus the shipped one: the twelfth saved layout fits.
    const first = useHomeLayoutStore.getState().savePresetAs("Twelfth");
    expect(first).not.toBeNull();
    expect(useHomeLayoutStore.getState().presets).toHaveLength(HOME_LAYOUT_PRESETS_STORED_MAX);
    // And that is the limit: the page keeps room for the shipped Default.
    expect(useHomeLayoutStore.getState().savePresetAs("Thirteenth")).toBeNull();
    window.localStorage.removeItem(HOME_LAYOUTS_STORAGE_KEY);
    window.localStorage.removeItem(HOME_LAYOUT_STORAGE_KEY);
  });

  it("drops unknown widgets, repeated ids and unknown app buttons inside a layout, and reads old free-resize cells as size classes", () => {
    const layouts = normalizeHomeLayouts({
      defaultStack: HOME_DEFAULT_STACK_VERSION,
      activeId: "a",
      presets: [{
        id: "a",
        name: "A",
        layout: {
          items: [
            { id: "a", type: "clock", w: 2, h: 2 },
            { id: "a", type: "feed", size: "l" },
            { id: "b", type: "spreadsheet", size: "m" },
            { id: "c", type: "machine", w: 2, h: 1, stacked: true },
            { id: "d", type: "pomodoro", w: 1, h: 1 },
          ],
          hiddenApps: ["spotify", "spotify", "tidal"],
        },
      }],
    });
    expect(layouts.presets[0]!.layout.items).toEqual([
      { id: "a", type: "clock", size: "l" },
      { id: "c", type: "machine", size: "w", stacked: true },
      { id: "d", type: "pomodoro", size: "s" },
    ]);
    // A removed app button stays removed; an unknown app name is dropped.
    expect(layouts.presets[0]!.layout.hiddenApps).toEqual(["spotify"]);
    // A layout saved before app buttons existed shows both.
    expect(normalizeHomeLayouts({ defaultStack: HOME_DEFAULT_STACK_VERSION, activeId: "a", presets: [preset("a", "A", [])] }).presets[0]!.layout.hiddenApps).toEqual([]);
  });

  it("follows another window's save instead of keeping its own older copy", () => {
    renderHook(() => useHomeAppEffects());
    useHomeLayoutStore.getState().setEditing(true);
    const saved = { ...current, activeId: "focus", presets: [preset("default", "Default"), preset("focus", "Focus", [{ id: "pomodoro", type: "pomodoro", size: "m" }])] };

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
    // Default: projects with running stacked under it, then prs, contributions
    // and the clock.
    expect(order()).toEqual(["projects", "running^", "prs", "heatmap", "clock"]);

    useHomeLayoutStore.getState().moveCell("projects", "prs", "after");
    expect(order()).toEqual(["prs", "projects", "running^", "heatmap", "clock"]);
    useHomeLayoutStore.getState().nudgeCell("projects", -1);
    expect(order()).toEqual(["projects", "running^", "prs", "heatmap", "clock"]);

    useHomeLayoutStore.getState().remove("projects");
    expect(order()).toEqual(["running", "prs", "heatmap", "clock"]);
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

  const LAST_ROW_CASES: Array<[string, HomeLayoutItem[], number, number, string, { x: number; y: number; w: number }, number]> = [
    // A wider card on the last row stretches across the room past its last card.
    [
      "a wide card on the last row fills it",
      [
        { id: "projects", type: "projects", size: "m" },
        { id: "running", type: "running", size: "s", stacked: true },
        { id: "activity", type: "activity", size: "w" },
        { id: "limits", type: "limits", size: "s" },
        { id: "nowPlaying", type: "nowPlaying", size: "m" },
      ],
      1_300,
      740,
      "nowPlaying",
      { x: 0, y: 2, w: 3 },
      0,
    ],
    // A Compact card on the last row keeps its one column; the rest of the row is wallpaper.
    [
      "a Compact card on the last row keeps its column",
      [
        { id: "activity", type: "activity", size: "w" },
        { id: "limits", type: "limits", size: "s" },
      ],
      1_000,
      740,
      "limits",
      { x: 0, y: 1, w: 1 },
      1,
    ],
  ];

  it.each(LAST_ROW_CASES)("%s", (_label, layoutItems, width, height, id, expected, trailing) => {
    const result = packLayout(layoutCells(layoutItems), gridMetrics(width, height), widgetShape);
    const placement = result.placed.find((item) => item.cell.host.id === id);
    expect(placement, "the widget is placed").toBeTruthy();
    expect({ x: placement!.x, y: placement!.y, w: placement!.w }).toEqual(expected);
    expect(result.trailing).toBe(trailing);
  });
});
