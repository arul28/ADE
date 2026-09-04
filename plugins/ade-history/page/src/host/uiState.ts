/**
 * The reader's place in the page, in the plugin's own collections.
 *
 * The compiled History kept the selected surface, lane, commit and event in the
 * renderer ROUTE (`useSearchParams`). A guest has no route, and a guest's
 * `localStorage` is a non-persistent partition that dies with the placement.
 * The collection is the replacement: budgeted, visible in the usage meter, and
 * the same everywhere.
 *
 * `ui-state` is declared in `plugin.json` with `sync: false`. Which commit a
 * reader last had open is a per-machine preference; syncing it would make one
 * machine's scroll position arrive on another.
 */

import { bridge, type PluginWebviewPlacement } from "../bridge";

const COLLECTION = "ui-state";

/**
 * Which placement's memory this is.
 *
 * Three placements can draw History at once — the rail tab, a pane beside a
 * chat, an overlay from the palette — and they were all reading and writing one
 * row keyed by the project root. Opening the pane snapped the tab to the pane's
 * commit, and the last one to move a divider resized the others. A placement is
 * a separate window onto the same history and remembers its own place, so the
 * placement is part of the key.
 *
 * An envelope with no placement (an older host, or the page opened outside a
 * guest) reads and writes the `tab` row, which is what the sole placement such
 * a host can draw actually is.
 */
export const DEFAULT_PLACEMENT: PluginWebviewPlacement = "tab";

export const DETAIL_MIN_PX = 280;
export const DETAIL_MAX_PX = 720;
export const DETAIL_DEFAULT_PX = 420;

export type HistoryUiState = {
  surface: "commits" | "activity";
  focusLaneId: string | null;
  selectedCommitSha: string | null;
  selectedEventId: string | null;
  detailPx: number;
};

const DEFAULT_STATE: HistoryUiState = {
  surface: "commits",
  focusLaneId: null,
  selectedCommitSha: null,
  selectedEventId: null,
  detailPx: DETAIL_DEFAULT_PX,
};

function keyFor(
  projectRoot: string | null | undefined,
  placement: PluginWebviewPlacement | null | undefined,
): string {
  const root = (projectRoot ?? "").trim() || "__project__";
  const where = (placement ?? DEFAULT_PLACEMENT).trim() || DEFAULT_PLACEMENT;
  return `history:${encodeURIComponent(root)}:${encodeURIComponent(where)}`;
}

async function read(key: string): Promise<unknown> {
  const api = bridge();
  if (!api) return null;
  try {
    return await api.collections.get(COLLECTION, key);
  } catch {
    return null;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  const api = bridge();
  if (!api) return;
  try {
    await api.collections.put(COLLECTION, key, value);
  } catch {
    // Losing a preference must never block reading history.
  }
}

function asState(value: unknown): HistoryUiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_STATE };
  const row = value as Record<string, unknown>;
  const surface = row.surface === "activity" ? "activity" : "commits";
  const focusLaneId = typeof row.focusLaneId === "string" && row.focusLaneId.trim()
    ? row.focusLaneId
    : null;
  const selectedCommitSha = typeof row.selectedCommitSha === "string" && row.selectedCommitSha.trim()
    ? row.selectedCommitSha
    : null;
  const selectedEventId = typeof row.selectedEventId === "string" && row.selectedEventId.trim()
    ? row.selectedEventId
    : null;
  const detailPxRaw = Number(row.detailPx);
  const detailPx = Number.isFinite(detailPxRaw)
    ? Math.min(DETAIL_MAX_PX, Math.max(DETAIL_MIN_PX, Math.round(detailPxRaw)))
    : DETAIL_DEFAULT_PX;
  return { surface, focusLaneId, selectedCommitSha, selectedEventId, detailPx };
}

export async function loadHistoryUiState(
  projectRoot: string | null | undefined,
  placement?: PluginWebviewPlacement | null,
): Promise<HistoryUiState> {
  return asState(await read(keyFor(projectRoot, placement)));
}

export async function saveHistoryUiState(
  projectRoot: string | null | undefined,
  placement: PluginWebviewPlacement | null | undefined,
  state: HistoryUiState,
): Promise<void> {
  await write(keyFor(projectRoot, placement), state);
}

/** The row one placement reads and writes. Exported for the seam test. */
export function historyUiStateKey(
  projectRoot: string | null | undefined,
  placement?: PluginWebviewPlacement | null,
): string {
  return keyFor(projectRoot, placement);
}
