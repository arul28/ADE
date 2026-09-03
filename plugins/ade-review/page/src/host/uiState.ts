/**
 * The reader's place in the page, in the plugin's own collections.
 *
 * The compiled Review kept both of these in `localStorage` — the sidebar width
 * under `ade.review.sidebarWidth`, and the selected run in the route's query
 * string. A guest's partition is NON-PERSISTENT: it dies with the placement, and
 * every placement is destroyed when it hides, so `localStorage` in a page is a
 * value that is always empty by the time anybody reads it back. And a guest has
 * no route to put a query string on. The collection is the replacement:
 * budgeted, synced, visible in the usage meter, and the same everywhere.
 *
 * `ui-state` is declared in `plugin.json` with `sync: false`. Which run a reader
 * last had open, and how wide they dragged their sidebar, are per-machine
 * preferences rather than workspace data; syncing them would make one machine's
 * scroll position arrive on another.
 */

import { bridge } from "../bridge";

const COLLECTION = "ui-state";

/** The compiled page's own clamps, kept so a stored width still means the same. */
export const SIDEBAR_MIN_PX = 280;
export const SIDEBAR_MAX_PX = 520;
export const SIDEBAR_DEFAULT_PX = 360;

function keyFor(name: string, projectRoot: string | null | undefined): string {
  const root = (projectRoot ?? "").trim() || "__project__";
  // The root is hashed into the key rather than used raw so a Windows path with
  // its own separators cannot look like a nested key.
  return `${name}:${encodeURIComponent(root)}`;
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
    // Losing a preference must never block reading a review — the same rule the
    // compiled page's `persistReviewSidebarPx` kept with its bare `try`.
  }
}

export async function loadSidebarPx(projectRoot: string | null | undefined): Promise<number> {
  const stored = await read(keyFor("sidebar", projectRoot));
  const value = Number(stored);
  if (Number.isFinite(value) && value >= SIDEBAR_MIN_PX && value <= SIDEBAR_MAX_PX) return value;
  return SIDEBAR_DEFAULT_PX;
}

export async function saveSidebarPx(
  projectRoot: string | null | undefined,
  px: number,
): Promise<void> {
  if (!Number.isFinite(px)) return;
  await write(keyFor("sidebar", projectRoot), Math.round(px));
}

/**
 * The run the reader last had open.
 *
 * `null` reads back as "none chosen", which is what a first open is, and the
 * browser then selects the newest run exactly as the compiled page did.
 */
export async function loadSelectedRunId(
  projectRoot: string | null | undefined,
): Promise<string | null> {
  const stored = await read(keyFor("run", projectRoot));
  return typeof stored === "string" && stored.trim().length > 0 ? stored : null;
}

export async function saveSelectedRunId(
  projectRoot: string | null | undefined,
  runId: string | null,
): Promise<void> {
  // The page bridge has no `collections.delete`, deliberately, so "no run" is
  // stored as an empty string and read back through the same guard above.
  await write(keyFor("run", projectRoot), runId ?? "");
}
