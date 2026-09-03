/**
 * Filters, the archived reveal and the selected row, in the plugin's own
 * collections.
 *
 * The compiled modal kept all three in React state and lost them on every
 * close. A page cannot even do that much with `localStorage`: a guest's
 * partition is NON-PERSISTENT — it dies with the placement, and every placement
 * is destroyed when it hides — so `localStorage` in a page is a value that is
 * always empty by the time anybody reads it back. The collection is the
 * replacement: budgeted, synced, visible in the usage meter, and the same on
 * the phone.
 *
 * `ui-state` is declared in `plugin.json` with `sync: false`. A reader's chosen
 * status filter is a per-machine preference, not workspace data, and syncing it
 * would make one machine's filter arrive on another mid-scroll.
 */

import { bridge } from "../bridge";

const COLLECTION = "ui-state";

function keyFor(name: string, projectRoot: string | null | undefined): string {
  const root = (projectRoot ?? "").trim() || "__project__";
  // The root is encoded into the key rather than used raw so a Windows path
  // with its own separators cannot look like a nested key.
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
    // Losing a preference must never block reading the fleet — the same rule
    // the compiled `safeSaveFilters` kept.
  }
}

export async function loadFilters<T>(
  projectRoot: string | null | undefined,
  fallback: T,
  normalize: (raw: Partial<T>) => T,
): Promise<T> {
  const stored = await read(keyFor("filters", projectRoot));
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return fallback;
  return normalize(stored as Partial<T>);
}

export async function saveFilters<T>(
  projectRoot: string | null | undefined,
  filters: T,
  isDefault: boolean,
): Promise<void> {
  // A default filter set is stored as an empty object rather than deleted: the
  // page bridge has no `collections.delete`, deliberately, and an empty record
  // reads back as "nothing chosen" through the same `normalize`.
  await write(keyFor("filters", projectRoot), isDefault ? {} : filters);
}

/**
 * The row the reader last opened.
 *
 * Stored apart from the filters because it changes far more often, and a
 * filter write that carried the selection with it would rewrite the whole
 * record on every click through the list.
 */
export async function loadSelectedAgentId(
  projectRoot: string | null | undefined,
): Promise<string | null> {
  const stored = await read(keyFor("selected-agent", projectRoot));
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

export async function saveSelectedAgentId(
  projectRoot: string | null | undefined,
  agentId: string | null,
): Promise<void> {
  await write(keyFor("selected-agent", projectRoot), agentId ?? "");
}
