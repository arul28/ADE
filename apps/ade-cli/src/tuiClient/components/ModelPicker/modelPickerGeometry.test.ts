import { describe, expect, it } from "vitest";
import {
  MODEL_ENTRY_HEIGHT,
  MODEL_LIST_BODY_LINES,
  MODEL_LIST_ROWS,
  PROVIDER_MODEL_ENTRY_HEIGHT,
  PROVIDER_MODEL_LIST_ROWS,
  RAIL_WIDTH,
  RAIL_TO_LIST_GAP,
  headerLineCount,
  hasSubProviderSelector,
  isSearching,
  modelPickerGeometry,
  providerTabSegments,
  rowWindow,
  settingsChipWidth,
} from "./modelPickerGeometry";
import type { ModelPickerEntry, ModelPickerState, ModelPickerProviderTab } from "./types";

// Derive the settings-row shape from the picker state itself so the test does
// not need a second specifier for ../../types (importing the same physical file
// via two paths trips a Vite resolution quirk).
type SetupPaneRow = ModelPickerState["settingsRows"][number];

function entry(overrides: Partial<ModelPickerEntry> & { modelId: string }): ModelPickerEntry {
  return {
    runtimeModelId: overrides.modelId,
    displayName: overrides.modelId,
    family: "claude",
    isFavorite: false,
    isAvailable: true,
    authStatus: "ready",
    ...overrides,
  };
}

function settingRow(kind: SetupPaneRow["kind"], label: string = kind): SetupPaneRow {
  return { kind, label, value: "" };
}

function makeState(overrides: Partial<ModelPickerState>): ModelPickerState {
  return {
    query: "",
    searchMode: false,
    railEntries: [
      { kind: "favorites", label: "Favorites" },
      { kind: "recents", label: "Recents" },
      { kind: "provider", provider: "claude", label: "Anthropic", authStatus: "ready", signInHint: null },
    ],
    railIndex: 0,
    entries: [],
    providerTabs: [],
    providerTabIndex: 0,
    focusedIndex: 0,
    activeModelId: null,
    activeProviderAuthStatus: "ready",
    activeProviderSignInHint: null,
    settingsRows: [],
    footerFocus: null,
    laneLabel: null,
    ...overrides,
  };
}

const PANE_LEFT = 100;
const PANE_TOP = 5;
const PANE_WIDTH = 38;
const ROWS = 60;

function geo(state: ModelPickerState) {
  return modelPickerGeometry({ paneLeft: PANE_LEFT, paneTop: PANE_TOP, paneWidth: PANE_WIDTH, state, rows: ROWS });
}

// Indexed access under noUncheckedIndexedAccess yields T | undefined; this
// asserts presence so the assertions below read cleanly.
function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`expected element at index ${index}`);
  return value;
}

describe("rowWindow", () => {
  it("returns the whole list when it fits the capacity", () => {
    expect(rowWindow(5, 0, MODEL_LIST_ROWS)).toEqual({ start: 0, end: 5 });
  });

  it("centers the focused row once the list overflows", () => {
    // 20 entries, capacity 5, focus 10 -> half=2 -> start=8, end=13.
    expect(rowWindow(20, 10, MODEL_LIST_ROWS)).toEqual({ start: 8, end: 13 });
  });

  it("clamps the window to the end of the list", () => {
    // focus at the last index pins the window to the tail.
    expect(rowWindow(20, 19, MODEL_LIST_ROWS)).toEqual({ start: 15, end: 20 });
  });
});

describe("headerLineCount", () => {
  it("counts only the models line by default", () => {
    expect(headerLineCount(makeState({}))).toBe(1);
  });

  it("does not add a header line for the active model (the '● now' line was removed)", () => {
    const state = makeState({
      entries: [entry({ modelId: "anthropic/claude-opus-4-8" })],
      activeModelId: "anthropic/claude-opus-4-8",
    });
    expect(headerLineCount(state)).toBe(1);
  });

  it("adds a sign-in line when the provider is unavailable", () => {
    const state = makeState({
      activeProviderAuthStatus: "unavailable",
      activeProviderSignInHint: "/login claude",
    });
    expect(headerLineCount(state)).toBe(2);
  });
});

describe("modelPickerGeometry — list rows", () => {
  it("places each entry in a two-line block below the header + search", () => {
    const state = makeState({
      entries: [
        entry({ modelId: "a" }),
        entry({ modelId: "b" }),
        entry({ modelId: "c" }),
      ],
      focusedIndex: 0,
    });
    const g = geo(state);
    // header(1) -> +1 marginBottom -> search row -> +1 marginBottom -> region.
    // no selector (single/zero provider tabs), so listTop == modelRegionTop.
    const headerLines = 1;
    const searchY = PANE_TOP + headerLines + 1;
    const listTop = searchY + 2;
    expect(g.search).toEqual({ x: PANE_LEFT, y: searchY, w: PANE_WIDTH, h: 1 });
    g.entries.forEach((e, index) => {
      expect(e.rect.h).toBe(MODEL_ENTRY_HEIGHT);
      expect(e.rect.y).toBe(listTop + (index * MODEL_ENTRY_HEIGHT));
      // not searching -> list sits to the right of the rail.
      expect(e.rect.x).toBe(PANE_LEFT + RAIL_WIDTH + RAIL_TO_LIST_GAP);
    });
    // y increments by exactly the rendered row height.
    expect(at(g.entries, 1).rect.y - at(g.entries, 0).rect.y).toBe(MODEL_ENTRY_HEIGHT);
    expect(at(g.entries, 2).rect.y - at(g.entries, 1).rect.y).toBe(MODEL_ENTRY_HEIGHT);
  });

  it("keeps fixed-height rows even for sub-provider / unavailable entries", () => {
    const state = makeState({
      entries: [
        entry({ modelId: "x", subProvider: "anthropic via OpenCode", isAvailable: true }),
        entry({ modelId: "y", isAvailable: false }),
      ],
      focusedIndex: 0,
    });
    const g = geo(state);
    expect(g.entries.every((e) => e.rect.h === MODEL_ENTRY_HEIGHT)).toBe(true);
    expect(at(g.entries, 1).rect.y - at(g.entries, 0).rect.y).toBe(MODEL_ENTRY_HEIGHT);
  });

  it("windows a long scrolled list using MODEL_LIST_ROWS, mapping screen rows to true indices", () => {
    const entries: ModelPickerEntry[] = Array.from({ length: 25 }, (_v, i) =>
      entry({ modelId: `m${i}` }),
    );
    const focusedIndex = 18;
    const state = makeState({ entries, focusedIndex });
    const g = geo(state);
    const window = rowWindow(entries.length, focusedIndex, MODEL_LIST_ROWS);
    expect(g.window).toEqual(window);
    // Exactly MODEL_LIST_ROWS visible rects.
    expect(g.entries.length).toBe(MODEL_LIST_ROWS);
    // First visible rect carries the windowed flat index, NOT 0.
    expect(at(g.entries, 0).index).toBe(window.start);
    expect(at(g.entries, 0).modelId).toBe(`m${window.start}`);
    // The focused row's screen y equals listTop + (focusedIndex - window.start).
    const headerLines = 1;
    const listTop = PANE_TOP + headerLines + 1 + 2;
    const focusRect = g.entries.find((e) => e.index === focusedIndex);
    expect(focusRect).toBeDefined();
    expect(focusRect!.rect.y).toBe(listTop + ((focusedIndex - window.start) * MODEL_ENTRY_HEIGHT));
  });

  it("uses one-line rows and a taller window inside a selected provider family", () => {
    const entries: ModelPickerEntry[] = Array.from({ length: 12 }, (_v, i) =>
      entry({ modelId: `m${i}` }),
    );
    const focusedIndex = 9;
    const state = makeState({ railIndex: 2, entries, focusedIndex });
    const g = geo(state);
    const window = rowWindow(entries.length, focusedIndex, PROVIDER_MODEL_LIST_ROWS);
    expect(g.window).toEqual(window);
    expect(g.entries.length).toBe(PROVIDER_MODEL_LIST_ROWS);
    g.entries.forEach((e, index) => {
      expect(e.rect.h).toBe(PROVIDER_MODEL_ENTRY_HEIGHT);
      expect(e.rect.y).toBe(at(g.entries, 0).rect.y + index);
    });
  });
});

describe("modelPickerGeometry — rail vs search mode", () => {
  it("registers a rail rect per entry in the leftmost RAIL_WIDTH cols when not searching", () => {
    const state = makeState({ entries: [entry({ modelId: "a" })] });
    const g = geo(state);
    expect(g.rail.length).toBe(state.railEntries.length);
    g.rail.forEach((r, index) => {
      expect(r.rect.x).toBe(PANE_LEFT);
      expect(r.rect.w).toBe(RAIL_WIDTH);
      expect(r.rect.h).toBe(1);
      // rail rows start at the model region top:
      // header(1) + marginBottom(1) + search(1) + marginBottom(1) = +4.
      expect(r.rect.y).toBe(PANE_TOP + 1 + 3 + index);
      expect(r.id).toBe(`right:model-picker:rail:${index}`);
    });
  });

  it("hides the rail and uses the full body width for the list while searching", () => {
    const state = makeState({
      query: "opus",
      searchMode: true,
      entries: [entry({ modelId: "a" }), entry({ modelId: "b" })],
    });
    expect(isSearching(state)).toBe(true);
    const g = geo(state);
    expect(g.rail).toEqual([]);
    g.entries.forEach((e) => {
      expect(e.rect.x).toBe(PANE_LEFT);
      expect(e.rect.w).toBe(PANE_WIDTH);
    });
  });
});

describe("modelPickerGeometry — sub-provider selector", () => {
  it("computes visible tab segments with stable offsets", () => {
    const tabs: ModelPickerProviderTab[] = [
      { key: "alpha", label: "Alpha" },
      { key: "beta", label: "Beta" },
      { key: "gamma", label: "Gamma" },
    ];

    expect(providerTabSegments(tabs, 1, 24).filter((segment) => segment.tabKey)).toEqual([
      { index: 0, tabKey: "alpha", text: " Alpha ", active: false, x: 0, w: 7 },
      { index: 1, tabKey: "beta", text: "[Beta]", active: true, x: 8, w: 6 },
      { index: 2, tabKey: "gamma", text: " Gamma ", active: false, x: 15, w: 7 },
    ]);
  });

  it("does not reserve a selector row when there is at most one provider tab", () => {
    const oneTab: ModelPickerProviderTab[] = [{ key: "k", label: "L" }];
    const state = makeState({ providerTabs: oneTab, entries: [entry({ modelId: "a" })] });
    expect(hasSubProviderSelector(state)).toBe(false);
    const g = geo(state);
    // header(1)+mb(1)+search(1)+mb(1) = +4 region top, no selector.
    const listTop = PANE_TOP + 1 + 3;
    expect(at(g.entries, 0).rect.y).toBe(listTop);
  });

  it("reserves the selector row (2 lines) when there is more than one provider tab", () => {
    const tabs: ModelPickerProviderTab[] = [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ];
    const state = makeState({ providerTabs: tabs, entries: [entry({ modelId: "a" })] });
    expect(hasSubProviderSelector(state)).toBe(true);
    const g = geo(state);
    const regionTop = PANE_TOP + 1 + 1 + 1 + 1; // header+mb+search+mb
    const listTopWithSelector = regionTop + 2;
    expect(at(g.entries, 0).rect.y).toBe(listTopWithSelector);
  });

  it("registers clickable rects for visible provider tabs", () => {
    const tabs: ModelPickerProviderTab[] = [
      { key: "alpha", label: "Alpha" },
      { key: "beta", label: "Beta" },
    ];
    const state = makeState({ providerTabs: tabs, providerTabIndex: 0, entries: [entry({ modelId: "a" })] });
    const g = geo(state);
    const listLeft = PANE_LEFT + RAIL_WIDTH + RAIL_TO_LIST_GAP;

    expect(g.providerTabs).toEqual([
      {
        id: "right:model-picker:provider-tab:0",
        index: 0,
        tabKey: "alpha",
        rect: { x: listLeft, y: PANE_TOP + 1 + 3, w: 7, h: 1 },
      },
      {
        id: "right:model-picker:provider-tab:1",
        index: 1,
        tabKey: "beta",
        rect: { x: listLeft + 8, y: PANE_TOP + 1 + 3, w: 6, h: 1 },
      },
    ]);
  });
});

describe("modelPickerGeometry — settings footer + apply", () => {
  it("places the footer below the fixed list block and registers one rect per setting chip", () => {
    const state = makeState({
      entries: [entry({ modelId: "a" })],
      settingsRows: [settingRow("reasoning"), settingRow("permission")],
    });
    const g = geo(state);
    const listTop = PANE_TOP + 1 + 3; // header+mb+search+mb = +4, no selector.
    // footer divider: listTop + fixed list body + (no more-line) + marginTop(1).
    expect(g.footerTop).toBe(listTop + MODEL_LIST_BODY_LINES + 1);
    expect(g.settings.length).toBe(2);
    g.settings.forEach((s, index) => {
      // divider at footerTop, blank (chips Box marginTop) at footerTop+1,
      // settings painted vertically starting at footerTop+2.
      expect(s.rect.y).toBe(g.footerTop + 2 + index);
      expect(s.rect.h).toBe(1);
    });
    // provider/model rows are excluded from the footer chips.
  });

  it("excludes provider/model/apply rows from the chip list and emits a dedicated apply rect", () => {
    const state = makeState({
      entries: [entry({ modelId: "a" })],
      settingsRows: [
        settingRow("provider"),
        settingRow("model"),
        settingRow("reasoning"),
        settingRow("apply", "Apply"),
      ],
    });
    const g = geo(state);
    // Only the reasoning chip is a footer setting.
    expect(g.settings.map((s) => s.id)).toEqual(["right:model-picker:setting:reasoning"]);
    expect(g.apply).not.toBeNull();
    // settings start at footerTop+2; apply has its own margin after them.
    expect(g.apply!.y).toBe(g.footerTop + 2 + 1 + 1);
    expect(g.apply!.h).toBe(1);
  });

  it("places apply directly below the divider when there are no setting chips", () => {
    const state = makeState({
      entries: [entry({ modelId: "a" })],
      settingsRows: [settingRow("apply", "Apply")],
    });
    const g = geo(state);
    expect(g.settings).toEqual([]);
    expect(g.apply!.y).toBe(g.footerTop + 2);
  });

  it("keeps the footer stable when a long list is windowed", () => {
    const entries: ModelPickerEntry[] = Array.from({ length: 25 }, (_v, i) =>
      entry({ modelId: `m${i}` }),
    );
    const withMore = makeState({ entries, focusedIndex: 18, settingsRows: [settingRow("reasoning")] });
    const noScroll = makeState({ entries: [entry({ modelId: "a" })], settingsRows: [settingRow("reasoning")] });
    const gMore = geo(withMore);
    const gNone = geo(noScroll);
    expect(gMore.footerTop).toBe(gNone.footerTop);
  });
});
