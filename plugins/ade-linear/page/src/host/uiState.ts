/**
 * Filters and selection, in the plugin's own collections.
 *
 * The compiled browser kept both in `localStorage`. A guest's partition is
 * NON-PERSISTENT — it dies with the placement, and every placement is destroyed
 * when it hides — so `localStorage` in a page is a value that is always empty by
 * the time anybody reads it back. The collection is the replacement: budgeted,
 * synced, visible in the usage meter, and the same on the phone.
 *
 * `ui-state` is declared in `plugin.json` with `sync: false`. A reader's chosen
 * filter is a per-machine preference, not workspace data, and syncing it would
 * make one machine's sort order arrive on another.
 */

import { bridge } from "../bridge";

const COLLECTION = "ui-state";

/** Longest selection remembered, matching the compiled browser's own cap. */
export const SELECTION_MAX = 200;

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
    // Losing a preference must never block browsing issues — the same rule the
    // compiled browser's `safeSaveFilters` kept.
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

export async function loadSelection(projectRoot: string | null | undefined): Promise<Set<string>> {
  const stored = await read(keyFor("selection", projectRoot));
  if (!Array.isArray(stored)) return new Set();
  return new Set(stored.filter((id): id is string => typeof id === "string").slice(0, SELECTION_MAX));
}

export async function saveSelection(
  projectRoot: string | null | undefined,
  ids: Set<string>,
): Promise<void> {
  await write(keyFor("selection", projectRoot), [...ids].slice(0, SELECTION_MAX));
}

export async function clearSelection(projectRoot: string | null | undefined): Promise<void> {
  await write(keyFor("selection", projectRoot), []);
}
