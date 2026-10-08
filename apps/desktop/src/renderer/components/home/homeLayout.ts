import { create } from "zustand";

/**
 * The home page's widget layout: which widgets, in what order, at what size,
 * plus the page's card look. Per computer, like Appearance: it describes one
 * screen, so it lives in this machine's localStorage (the same durable store
 * the app's other screen-shaped preferences use) and never syncs.
 *
 * The default preset is the home page as it shipped before widgets existed:
 * Projects as a tall column with Working now stacked under it, Activity &
 * usage across the top right, Limits & machines and Pull requests below.
 *
 * Saved layouts: the page keeps named presets ("Default" first) and shows the
 * active one; every edit lands in the active preset. Version 2 storage holds
 * the presets. Version 1 held one layout; it loads as the "Default" preset,
 * and the active layout is still mirrored there so an older build keeps
 * opening the page the user last saw.
 */

/** Version 1: one layout. Read for migration and kept in step with the active preset. */
export const HOME_LAYOUT_STORAGE_KEY = "ade.home.layout.v1";
/** Version 2: named presets and which one is showing. */
export const HOME_LAYOUTS_STORAGE_KEY = "ade.home.layouts.v2";

/** Cycles saved layouts while the home page shows; rebindable in keybindings. */
export const HOME_LAYOUT_KEYBINDING = { id: "home.layout.next", fallback: "Mod+Shift+L" } as const;

export type HomeWidgetType =
  | "projects"
  | "running"
  | "activity"
  | "limits"
  | "prs"
  | "clock"
  | "pomodoro"
  | "clipboard"
  | "machine"
  | "heatmap"
  | "shipped"
  | "feed"
  | "nowPlaying";

/**
 * The stored size: S is Compact, M and W are Regular (stored as the shape the
 * widget's Regular class has, tall or wide, which is what older builds read),
 * L is Large. The layout engine reads it as a size class (`homeGridPack.ts`).
 */
export type HomeWidgetSize = "s" | "m" | "l" | "w";

export const HOME_WIDGET_SIZES: readonly HomeWidgetSize[] = ["s", "m", "l", "w"];

export type HomeLayoutItem = {
  id: string;
  type: HomeWidgetType;
  /** Its size class (see HomeWidgetSize). */
  size: HomeWidgetSize;
  /** Shares the previous widget's cell, below it (Working now under Projects). */
  stacked?: boolean;
  /** Widget-owned options (a weather place, a timer length). */
  settings?: Record<string, unknown>;
};

export type HomeAppearance = {
  /** Card fill strength, 0–100 (% of the theme background). Null follows the theme. */
  cardOpacity: number | null;
  /** Backdrop blur in px, 0–40. Null follows the theme (none on a gradient, 20 over a picture). */
  cardBlur: number | null;
};

export type HomeLayout = {
  items: HomeLayoutItem[];
  columns: 3 | 4;
  appearance: HomeAppearance;
};

const WIDGET_TYPES = new Set<HomeWidgetType>([
  "projects", "running", "activity", "limits", "prs", "clock", "pomodoro", "clipboard", "machine", "heatmap", "shipped", "feed", "nowPlaying",
]);

export function defaultHomeLayout(): HomeLayout {
  return {
    items: [
      { id: "projects", type: "projects", size: "m" },
      { id: "running", type: "running", size: "s", stacked: true },
      { id: "activity", type: "activity", size: "w" },
      { id: "limits", type: "limits", size: "s" },
      { id: "prs", type: "prs", size: "s" },
    ],
    columns: 3,
    appearance: { cardOpacity: null, cardBlur: null },
  };
}

function clampOrNull(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function normalizeHomeLayout(value: unknown): HomeLayout {
  const fallback = defaultHomeLayout();
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const seen = new Set<string>();
  const items: HomeLayoutItem[] = [];
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const type = item.type as HomeWidgetType;
    const id = typeof item.id === "string" && item.id ? item.id.slice(0, 64) : null;
    if (!id || !WIDGET_TYPES.has(type) || seen.has(id)) continue;
    seen.add(id);
    let size = HOME_WIDGET_SIZES.includes(item.size as HomeWidgetSize) ? (item.size as HomeWidgetSize) : "s";
    // A build with free resizing stored cells; they read as the class of that area.
    const cells = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6 ? value : null);
    const w = cells(item.w);
    const h = cells(item.h);
    if (w != null && h != null) size = w * h <= 1 ? "s" : w * h >= 4 ? "l" : w >= 2 ? "w" : "m";
    items.push({
      id,
      type,
      size,
      ...(item.stacked === true && items.length > 0 ? { stacked: true } : {}),
      ...(item.settings && typeof item.settings === "object" ? { settings: item.settings as Record<string, unknown> } : {}),
    });
  }
  const appearance = (raw.appearance && typeof raw.appearance === "object" ? raw.appearance : {}) as Record<string, unknown>;
  return {
    items: Array.isArray(raw.items) ? items : fallback.items,
    columns: raw.columns === 4 ? 4 : 3,
    appearance: {
      cardOpacity: clampOrNull(appearance.cardOpacity, 0, 100),
      cardBlur: clampOrNull(appearance.cardBlur, 0, 40),
    },
  };
}

export type HomeLayoutPreset = { id: string; name: string; layout: HomeLayout };

export type HomeLayouts = { version: 2; activeId: string; presets: HomeLayoutPreset[] };

export const DEFAULT_PRESET_ID = "default";
const PRESET_NAME_MAX = 40;
const PRESETS_MAX = 12;

function defaultLayouts(layout: HomeLayout = defaultHomeLayout()): HomeLayouts {
  return { version: 2, activeId: DEFAULT_PRESET_ID, presets: [{ id: DEFAULT_PRESET_ID, name: "Default", layout }] };
}

export function cleanPresetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, PRESET_NAME_MAX);
  return name || null;
}

/**
 * Reads stored layouts: version 2 when present and usable, else a version 1
 * layout as the "Default" preset, else the shipped default. Bad entries are
 * dropped one by one; there is always at least one preset and the active id
 * always names one of them.
 */
export function normalizeHomeLayouts(stored: unknown, legacy: unknown): HomeLayouts {
  if (stored && typeof stored === "object" && Array.isArray((stored as { presets?: unknown }).presets)) {
    const raw = stored as { activeId?: unknown; presets: unknown[] };
    const seen = new Set<string>();
    const presets: HomeLayoutPreset[] = [];
    for (const entry of raw.presets) {
      if (!entry || typeof entry !== "object" || presets.length >= PRESETS_MAX) continue;
      const preset = entry as Record<string, unknown>;
      const id = typeof preset.id === "string" && preset.id ? preset.id.slice(0, 64) : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      presets.push({ id, name: cleanPresetName(preset.name) ?? "Untitled", layout: normalizeHomeLayout(preset.layout) });
    }
    if (presets.length > 0) {
      const activeId = typeof raw.activeId === "string" && seen.has(raw.activeId) ? raw.activeId : presets[0]!.id;
      return { version: 2, activeId, presets };
    }
  }
  return legacy != null ? defaultLayouts(normalizeHomeLayout(legacy)) : defaultLayouts();
}

function parseStored(key: string): unknown {
  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

function readStoredLayouts(): HomeLayouts {
  let stored: unknown = null;
  let legacy: unknown = null;
  try {
    stored = parseStored(HOME_LAYOUTS_STORAGE_KEY);
  } catch {
    // Unreadable version 2: fall back to version 1 below.
  }
  try {
    legacy = parseStored(HOME_LAYOUT_STORAGE_KEY);
  } catch {
    // Unreadable version 1 too: the default layout.
  }
  return normalizeHomeLayouts(stored, legacy);
}

function writeStoredLayouts(layouts: HomeLayouts) {
  try {
    window.localStorage.setItem(HOME_LAYOUTS_STORAGE_KEY, JSON.stringify(layouts));
    const active = layouts.presets.find((preset) => preset.id === layouts.activeId);
    if (active) window.localStorage.setItem(HOME_LAYOUT_STORAGE_KEY, JSON.stringify(active.layout));
  } catch {
    // localStorage can be full or unavailable; the layout still works this session.
  }
}

function activeLayout(layouts: HomeLayouts): HomeLayout {
  return (layouts.presets.find((preset) => preset.id === layouts.activeId) ?? layouts.presets[0]!).layout;
}

/** A cell: one widget, plus whatever is stacked under it. */
export type HomeLayoutCell = { host: HomeLayoutItem; stacked: HomeLayoutItem[] };

export function layoutCells(items: readonly HomeLayoutItem[]): HomeLayoutCell[] {
  const cells: HomeLayoutCell[] = [];
  for (const item of items) {
    const last = cells.at(-1);
    if (item.stacked && last) last.stacked.push(item);
    else cells.push({ host: item, stacked: [] });
  }
  return cells;
}

function flatten(cells: readonly HomeLayoutCell[]): HomeLayoutItem[] {
  const out: HomeLayoutItem[] = [];
  for (const cell of cells) {
    const { stacked: _host, ...host } = cell.host;
    out.push(host);
    for (const item of cell.stacked) out.push({ ...item, stacked: true });
  }
  return out;
}

/** Moves a whole cell (a widget and its stack) before or after another cell. */
export function moveCell(items: readonly HomeLayoutItem[], fromId: string, toId: string, side: "before" | "after"): HomeLayoutItem[] {
  const cells = layoutCells(items);
  const from = cells.findIndex((cell) => cell.host.id === fromId);
  if (from < 0 || fromId === toId) return [...items];
  const [moving] = cells.splice(from, 1);
  const to = cells.findIndex((cell) => cell.host.id === toId);
  if (to < 0 || !moving) return [...items];
  cells.splice(side === "before" ? to : to + 1, 0, moving);
  return flatten(cells);
}

/** Moves a cell one step earlier or later (keyboard reorder). */
export function nudgeCell(items: readonly HomeLayoutItem[], id: string, delta: -1 | 1): HomeLayoutItem[] {
  const cells = layoutCells(items);
  const index = cells.findIndex((cell) => cell.host.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= cells.length) return [...items];
  const [moving] = cells.splice(index, 1);
  cells.splice(target, 0, moving!);
  return flatten(cells);
}

let idCounter = 0;
function newItemId(type: HomeWidgetType): string {
  idCounter += 1;
  return `${type}-${Date.now().toString(36)}${idCounter}`;
}

function newPresetId(): string {
  idCounter += 1;
  return `layout-${Date.now().toString(36)}${idCounter}`;
}

function uniqueName(name: string, presets: readonly HomeLayoutPreset[], exceptId?: string): string {
  const taken = new Set(presets.filter((preset) => preset.id !== exceptId).map((preset) => preset.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export type HomeAddOptions = {
  replaceId?: string;
  /** Other widgets to set to a smaller size in the same commit (the gallery's "make room"). */
  shrink?: ReadonlyArray<{ id: string; size: HomeWidgetSize }>;
};

type HomeLayoutStore = {
  /** The active preset's layout: what the page shows. */
  layout: HomeLayout;
  presets: HomeLayoutPreset[];
  activeId: string;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  moveCell: (fromId: string, toId: string, side: "before" | "after") => void;
  nudgeCell: (id: string, delta: -1 | 1) => void;
  resize: (id: string, size: HomeWidgetSize) => void;
  remove: (id: string) => void;
  /**
   * Adds a widget at the end, or in place of `replaceId`. `shrink` resizes
   * other widgets first (the gallery's "make room"), in the same commit.
   */
  add: (type: HomeWidgetType, size: HomeWidgetSize, options?: HomeAddOptions) => string;
  setStacked: (id: string, stacked: boolean) => void;
  updateSettings: (id: string, patch: Record<string, unknown>) => void;
  setAppearance: (patch: Partial<HomeAppearance>) => void;
  setColumns: (columns: 3 | 4) => void;
  /** Puts the active preset back to the shipped default. */
  reset: () => void;
  switchPreset: (id: string) => void;
  /** Next (or previous) preset, wrapping; returns the one now showing. */
  cyclePreset: (delta: 1 | -1) => HomeLayoutPreset | null;
  /** Saves the current layout as a new preset and shows it; null at the preset limit. */
  savePresetAs: (name: string) => HomeLayoutPreset | null;
  renamePreset: (id: string, name: string) => void;
  /** The last preset cannot be deleted. Deleting the active one shows the first left. */
  deletePreset: (id: string) => void;
};

export const useHomeLayoutStore = create<HomeLayoutStore>((set, get) => {
  const save = (presets: HomeLayoutPreset[], activeId: string) => {
    const layouts: HomeLayouts = { version: 2, activeId, presets };
    writeStoredLayouts(layouts);
    set({ presets, activeId, layout: activeLayout(layouts) });
  };
  const commit = (layout: HomeLayout) => {
    const { presets, activeId } = get();
    save(presets.map((preset) => (preset.id === activeId ? { ...preset, layout } : preset)), activeId);
  };
  const withItems = (items: HomeLayoutItem[]) => commit({ ...get().layout, items });
  const initial = typeof window === "undefined" ? defaultLayouts() : readStoredLayouts();
  return {
    layout: activeLayout(initial),
    presets: initial.presets,
    activeId: initial.activeId,
    editing: false,
    setEditing: (editing) => set({ editing }),
    moveCell: (fromId, toId, side) => withItems(moveCell(get().layout.items, fromId, toId, side)),
    nudgeCell: (id, delta) => withItems(nudgeCell(get().layout.items, id, delta)),
    resize: (id, size) => withItems(get().layout.items.map((item) => (item.id === id ? { ...item, size } : item))),
    remove: (id) => {
      const items = get().layout.items;
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return;
      const removed = items[index]!;
      const next = items.filter((item) => item.id !== id);
      // A host's stack outlives it: the first stacked widget takes the cell.
      if (!removed.stacked && next[index]?.stacked) {
        next[index] = { ...next[index]!, size: removed.size };
        delete next[index]!.stacked;
      }
      withItems(next);
    },
    add: (type, size, options) => {
      const id = newItemId(type);
      const added: HomeLayoutItem = { id, type, size };
      let items = get().layout.items.map((item) => {
        const shrink = options?.shrink?.find((entry) => entry.id === item.id);
        return shrink ? { ...item, size: shrink.size } : item;
      });
      const replaceAt = options?.replaceId ? items.findIndex((item) => item.id === options.replaceId) : -1;
      if (replaceAt >= 0) {
        const replaced = items[replaceAt]!;
        items = items.filter((item) => item.id !== replaced.id);
        // The new widget takes the replaced one's place; its stack stays under it.
        items.splice(replaceAt, 0, replaced.stacked ? { ...added, stacked: true } : added);
      } else {
        items = [...items, added];
      }
      withItems(items);
      return id;
    },
    setStacked: (id, stacked) => {
      const items = get().layout.items;
      const index = items.findIndex((item) => item.id === id);
      if (index <= 0 && stacked) return;
      withItems(items.map((item, i) => {
        if (i !== index) return item;
        if (stacked) return { ...item, stacked: true };
        const { stacked: _drop, ...rest } = item;
        return rest;
      }));
    },
    updateSettings: (id, patch) =>
      withItems(get().layout.items.map((item) => (item.id === id ? { ...item, settings: { ...item.settings, ...patch } } : item))),
    setAppearance: (patch) => commit({ ...get().layout, appearance: { ...get().layout.appearance, ...patch } }),
    setColumns: (columns) => commit({ ...get().layout, columns }),
    reset: () => commit(defaultHomeLayout()),
    switchPreset: (id) => {
      const { presets, activeId } = get();
      if (id !== activeId && presets.some((preset) => preset.id === id)) save(presets, id);
    },
    cyclePreset: (delta) => {
      const { presets, activeId } = get();
      if (presets.length === 0) return null;
      const index = presets.findIndex((preset) => preset.id === activeId);
      const next = presets[(index + delta + presets.length) % presets.length]!;
      if (next.id !== activeId) save(presets, next.id);
      return next;
    },
    savePresetAs: (rawName) => {
      const { presets, layout } = get();
      const name = cleanPresetName(rawName);
      if (!name || presets.length >= PRESETS_MAX) return null;
      const preset: HomeLayoutPreset = { id: newPresetId(), name: uniqueName(name, presets), layout: structuredClone(layout) };
      save([...presets, preset], preset.id);
      return preset;
    },
    renamePreset: (id, rawName) => {
      const { presets, activeId } = get();
      const name = cleanPresetName(rawName);
      if (!name) return;
      save(presets.map((preset) => (preset.id === id ? { ...preset, name: uniqueName(name, presets, id) } : preset)), activeId);
    },
    deletePreset: (id) => {
      const { presets, activeId } = get();
      if (presets.length <= 1 || !presets.some((preset) => preset.id === id)) return;
      const next = presets.filter((preset) => preset.id !== id);
      save(next, id === activeId ? next[0]!.id : activeId);
    },
  };
});

/**
 * The clipboard watch in main runs only while a Clipboard widget is on the
 * layout. Removing the widget (or a reset) stops it; so does finding no
 * widget a few seconds after launch, which covers a layout lost outside the
 * store (cleared storage, another profile). One small IPC, off the boot path.
 */
function stopClipboardWatchWhenUnused() {
  if (typeof window === "undefined") return;
  const hasClipboard = (items: readonly HomeLayoutItem[]) => items.some((item) => item.type === "clipboard");
  let had = hasClipboard(useHomeLayoutStore.getState().layout.items);
  const stop = () => {
    const bridge = window.ade?.home?.clipboard;
    if (!bridge) return;
    void bridge.getState()
      .then((state) => (state.enabled ? bridge.configure({ enabled: false }) : null))
      .catch(() => {});
  };
  useHomeLayoutStore.subscribe((state) => {
    const has = hasClipboard(state.layout.items);
    if (had && !has) stop();
    had = has;
  });
  if (!had) window.setTimeout(() => {
    if (!hasClipboard(useHomeLayoutStore.getState().layout.items)) stop();
  }, 6_000);
}
stopClipboardWatchWhenUnused();
