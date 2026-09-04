/**
 * The reader's chosen device, target and mode, in the plugin's own collections.
 *
 * The compiled pane kept these in React state that died with the pane, and
 * its zoom in `localStorage`. A guest's partition is NON-PERSISTENT — it dies
 * with the placement, and every placement is destroyed when it hides — so
 * `localStorage` in a page is a value that is always empty by the time anybody
 * reads it back. The collection is the replacement: budgeted, synced, visible in
 * the usage meter, and readable by the child.
 *
 * `ui-state` is declared in `plugin.json` with `sync: false`. Which simulator a
 * reader picked is a per-MACHINE fact — the udid means nothing on another Mac —
 * and syncing it would put one machine's device id on another's picker.
 */

import { bridge } from "../bridge";

const COLLECTION = "ui-state";

export type SimUiState = {
  deviceUdid: string | null;
  targetId: string | null;
  previewTargetId: string | null;
  mode: "interact" | "inspect" | "preview";
  zoom: number;
};

export const DEFAULT_UI_STATE: SimUiState = {
  deviceUdid: null,
  targetId: null,
  previewTargetId: null,
  mode: "interact",
  zoom: 1,
};

/** The compiled pane's own zoom rail, kept verbatim so the two agree. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.25;

export function clampZoom(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(numeric / ZOOM_STEP) * ZOOM_STEP));
}

function keyFor(projectRoot: string | null | undefined): string {
  const root = (projectRoot ?? "").trim() || "__project__";
  // The root is encoded into the key rather than used raw so a Windows path
  // with its own separators cannot look like a nested key.
  return `sim:${encodeURIComponent(root)}`;
}

function normalize(raw: Partial<SimUiState>): SimUiState {
  const mode = raw.mode === "inspect" || raw.mode === "preview" ? raw.mode : "interact";
  return {
    deviceUdid: typeof raw.deviceUdid === "string" && raw.deviceUdid ? raw.deviceUdid : null,
    targetId: typeof raw.targetId === "string" && raw.targetId ? raw.targetId : null,
    previewTargetId:
      typeof raw.previewTargetId === "string" && raw.previewTargetId ? raw.previewTargetId : null,
    mode,
    zoom: clampZoom(raw.zoom),
  };
}

export async function loadUiState(projectRoot: string | null | undefined): Promise<SimUiState> {
  const api = bridge();
  if (!api) return DEFAULT_UI_STATE;
  try {
    const stored = await api.collections.get(COLLECTION, keyFor(projectRoot));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return DEFAULT_UI_STATE;
    return normalize(stored as Partial<SimUiState>);
  } catch {
    return DEFAULT_UI_STATE;
  }
}

export async function saveUiState(
  projectRoot: string | null | undefined,
  next: SimUiState,
): Promise<void> {
  const api = bridge();
  if (!api) return;
  try {
    await api.collections.put(COLLECTION, keyFor(projectRoot), next);
  } catch {
    // Losing a preference must never block driving the simulator.
  }
}
