/**
 * The launch form, in the plugin's own collections.
 *
 * The compiled pane kept this in `window.sessionStorage`, behind a module-level
 * `Map` that survived a remount inside one window. A guest's partition is
 * NON-PERSISTENT — it dies with the placement, and every placement is destroyed
 * when it hides — so `sessionStorage` in a page is a value that is always empty
 * by the time anybody reads it back. The collection is the replacement:
 * budgeted, synced, visible in the usage meter.
 *
 * `ui-state` is declared in `plugin.json` with `sync: false`, and the reason is
 * the compiled key's own comment: a launch command and a CDP port describe a
 * process on ONE machine. Syncing them would arrive on a second machine as a
 * command that does not exist there and a port nothing is listening on.
 */

import { bridge } from "../bridge";
import type { ControlPanelUiState } from "../types";

const COLLECTION = "ui-state";

export const DEFAULT_UI_STATE: ControlPanelUiState = {
  launchCommand: "",
  launchCwd: "",
  cdpPort: "",
  mode: "control",
};

/**
 * The key one reader's form is stored under.
 *
 * The compiled `panelUiStateKey` mixed in the chat session, the lane and the
 * machine as well as the project root, because one window could hold several of
 * these panes at once. A page is opened per placement with one project context,
 * so the root is the whole key — and it is encoded rather than used raw so a
 * Windows path with its own separators cannot look like a nested key.
 */
function keyFor(projectRoot: string | null | undefined): string {
  const root = (projectRoot ?? "").trim() || "__project__";
  return `form:${encodeURIComponent(root)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read a stored form back, narrowed to the four fields the panel draws. */
export function normalizeUiState(raw: Partial<ControlPanelUiState> | null): ControlPanelUiState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_UI_STATE };
  return {
    launchCommand: text(raw.launchCommand),
    launchCwd: text(raw.launchCwd),
    cdpPort: text(raw.cdpPort),
    mode: raw.mode === "inspect" ? "inspect" : "control",
  };
}

export async function loadUiState(
  projectRoot: string | null | undefined,
): Promise<ControlPanelUiState> {
  const api = bridge();
  if (!api) return { ...DEFAULT_UI_STATE };
  try {
    const stored = await api.collections.get(COLLECTION, keyFor(projectRoot));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { ...DEFAULT_UI_STATE };
    return normalizeUiState(stored as Partial<ControlPanelUiState>);
  } catch {
    // Losing a remembered command must never block launching one.
    return { ...DEFAULT_UI_STATE };
  }
}

export async function saveUiState(
  projectRoot: string | null | undefined,
  state: ControlPanelUiState,
): Promise<void> {
  const api = bridge();
  if (!api) return;
  try {
    await api.collections.put(COLLECTION, keyFor(projectRoot), state);
  } catch {
    // As above — the same rule the compiled `writePanelUiState` kept with its
    // own swallowed `try`.
  }
}
