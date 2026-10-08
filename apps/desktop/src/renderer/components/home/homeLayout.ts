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
 */

export const HOME_LAYOUT_STORAGE_KEY = "ade.home.layout.v1";

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
  | "nowPlaying";

/** S 1×1 · M 1×2 (tall) · L 2×2 · W 2×1 (wide), in grid columns × rows. */
export type HomeWidgetSize = "s" | "m" | "l" | "w";

export const HOME_WIDGET_SIZES: readonly HomeWidgetSize[] = ["s", "m", "l", "w"];

export type HomeLayoutItem = {
  id: string;
  type: HomeWidgetType;
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
  "projects", "running", "activity", "limits", "prs", "clock", "pomodoro", "clipboard", "machine", "heatmap", "shipped", "nowPlaying",
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
    const size = HOME_WIDGET_SIZES.includes(item.size as HomeWidgetSize) ? (item.size as HomeWidgetSize) : "s";
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

function readStoredLayout(): HomeLayout {
  try {
    const raw = window.localStorage.getItem(HOME_LAYOUT_STORAGE_KEY);
    return raw ? normalizeHomeLayout(JSON.parse(raw)) : defaultHomeLayout();
  } catch {
    return defaultHomeLayout();
  }
}

function writeStoredLayout(layout: HomeLayout) {
  try {
    window.localStorage.setItem(HOME_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // localStorage can be full or unavailable; the layout still works this session.
  }
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

type HomeLayoutStore = {
  layout: HomeLayout;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  moveCell: (fromId: string, toId: string, side: "before" | "after") => void;
  nudgeCell: (id: string, delta: -1 | 1) => void;
  resize: (id: string, size: HomeWidgetSize) => void;
  remove: (id: string) => void;
  add: (type: HomeWidgetType, size: HomeWidgetSize) => string;
  setStacked: (id: string, stacked: boolean) => void;
  updateSettings: (id: string, patch: Record<string, unknown>) => void;
  setAppearance: (patch: Partial<HomeAppearance>) => void;
  setColumns: (columns: 3 | 4) => void;
  reset: () => void;
};

export const useHomeLayoutStore = create<HomeLayoutStore>((set, get) => {
  const commit = (layout: HomeLayout) => {
    writeStoredLayout(layout);
    set({ layout });
  };
  const withItems = (items: HomeLayoutItem[]) => commit({ ...get().layout, items });
  return {
    layout: typeof window === "undefined" ? defaultHomeLayout() : readStoredLayout(),
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
    add: (type, size) => {
      const id = newItemId(type);
      withItems([...get().layout.items, { id, type, size }]);
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
  };
});

/** Grid span for a size: columns × rows, clamped to the grid's width. */
export function sizeSpan(size: HomeWidgetSize, columns: number, narrow: boolean): { cols: number; rows: number } {
  const base = size === "s" ? { cols: 1, rows: 1 } : size === "m" ? { cols: 1, rows: 2 } : size === "w" ? { cols: 2, rows: 1 } : { cols: 2, rows: 2 };
  // Two columns: a tall widget lies down across the top, as the narrow page always did.
  if (narrow && size === "m") return { cols: Math.min(2, columns), rows: 1 };
  return { cols: Math.min(base.cols, columns), rows: base.rows };
}

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
