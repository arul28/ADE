import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import type {
  SyncPluginCollectionRow,
  SyncPluginPanelDescriptor,
} from "../../../../desktop/src/shared/types/sync";

/**
 * Builds the scoped view behind `plugin_subscribe`.
 *
 * A browser peer keeps no local CRR replica, so it cannot read the plugin
 * tables itself; and a plugin may legitimately hold thousands of rows across
 * many collections, none of which a single open panel needs. This builder
 * answers the only question the subscription cares about: what does THIS panel
 * render right now.
 */

type PanelDb = Pick<AdeDb, "get" | "all">;

/** Rows one snapshot may carry. Past this the client is told it is truncated. */
export const PLUGIN_PANEL_SNAPSHOT_MAX_ROWS = 500;
/** Collections one panel may bind. A panel naming more is misusing the socket. */
export const PLUGIN_PANEL_MAX_COLLECTIONS = 16;
/** Nodes walked while extracting collection names from a panel schema. */
const SCHEMA_WALK_MAX_NODES = 4_000;
/** Depth walked while extracting collection names from a panel schema. */
const SCHEMA_WALK_MAX_DEPTH = 12;

/**
 * Collection names a panel schema binds to.
 *
 * Deliberately a structural scan for `"collection": "<name>"` rather than an
 * interpretation of the vocabulary. The host has no business knowing what a
 * `stack` or a `chart` is — that contract belongs to the renderer and will keep
 * changing — but it does need to know which rows to ship, and a data binding is
 * the one part of the schema whose shape is fixed. Bounded in both node count
 * and depth because the schema is plugin-authored input, and an unbounded walk
 * over hostile JSON is a stall on the sync event loop.
 */
export function collectionsReferencedBy(schemaJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaJson);
  } catch {
    return [];
  }
  const found = new Set<string>();
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (found.size >= PLUGIN_PANEL_MAX_COLLECTIONS) return;
    if (depth > SCHEMA_WALK_MAX_DEPTH || nodes >= SCHEMA_WALK_MAX_NODES) return;
    nodes += 1;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "collection" && typeof entry === "string" && entry.trim()) {
        found.add(entry.trim());
        if (found.size >= PLUGIN_PANEL_MAX_COLLECTIONS) return;
        continue;
      }
      walk(entry, depth + 1);
    }
  };
  walk(parsed, 0);
  return [...found].sort();
}

export function readPluginPanel(
  db: PanelDb,
  pluginId: string,
  panelId: string,
): SyncPluginPanelDescriptor | null {
  const row = db.get<{
    title: string;
    icon: string;
    surface: string;
    schema_json: string;
    vocab_version: number;
    updated_at: string;
  }>(
    `select title, icon, surface, schema_json, vocab_version, updated_at
       from plugin_panels where plugin_id = ? and panel_id = ?`,
    [pluginId, panelId],
  );
  if (!row) return null;
  return {
    pluginId,
    panelId,
    title: row.title ?? "",
    icon: row.icon ?? "",
    surface: row.surface ?? "",
    schemaJson: row.schema_json ?? "{}",
    vocabVersion: Number(row.vocab_version ?? 1),
    updatedAt: row.updated_at ?? "",
  };
}

export type PluginPanelView = {
  panel: SyncPluginPanelDescriptor | null;
  rows: SyncPluginCollectionRow[];
  truncated: boolean;
};

/**
 * The panel descriptor plus the collection rows it binds.
 *
 * A missing panel is a normal answer, not an error: the plugin may not be
 * installed on this machine, or may have been uninstalled while a client had
 * the panel open. The client renders its own empty state — plugins are supposed
 * to disappear silently on machines that do not have them.
 */
export function buildPluginPanelView(
  db: PanelDb,
  pluginId: string,
  panelId: string,
): PluginPanelView {
  const panel = readPluginPanel(db, pluginId, panelId);
  if (!panel) return { panel: null, rows: [], truncated: false };
  const collections = collectionsReferencedBy(panel.schemaJson);
  if (collections.length === 0) return { panel, rows: [], truncated: false };
  const placeholders = collections.map(() => "?").join(", ");
  // Fetch one past the cap so "there is more" is a fact rather than a guess at
  // the boundary (exactly-at-cap would otherwise always report truncated).
  const rows = db.all<{
    collection: string;
    key: string;
    value_json: string;
    updated_at: string;
  }>(
    `select collection, key, value_json, updated_at
       from plugin_collections
      where plugin_id = ? and collection in (${placeholders})
      order by collection, key
      limit ${PLUGIN_PANEL_SNAPSHOT_MAX_ROWS + 1}`,
    [pluginId, ...collections],
  );
  const truncated = rows.length > PLUGIN_PANEL_SNAPSHOT_MAX_ROWS;
  return {
    panel,
    rows: rows.slice(0, PLUGIN_PANEL_SNAPSHOT_MAX_ROWS).map((row) => ({
      collection: row.collection,
      key: row.key,
      valueJson: row.value_json ?? "null",
      updatedAt: row.updated_at ?? "",
    })),
    truncated,
  };
}

/** Stable identity for one row, used as the delta baseline key. */
export function pluginRowKey(row: Pick<SyncPluginCollectionRow, "collection" | "key">): string {
  return JSON.stringify([row.collection, row.key]);
}

/** One row's content, for the delta baseline VALUE — not its identity, its shape. */
export function serializePluginRow(row: Pick<SyncPluginCollectionRow, "valueJson" | "updatedAt">): string {
  return JSON.stringify([row.valueJson, row.updatedAt]);
}

/**
 * The delta baseline for a panel view: every row's identity mapped to its
 * serialized content, which `flushPluginPanels` diffs a later view against to
 * find what changed. Built the same way whether this is the first snapshot's
 * baseline or a later flush's comparison set, which is the point of sharing it —
 * the two call sites in `syncHostService.ts` used to build this map inline and
 * identically, one keystroke away from drifting.
 */
export function buildPluginBaseline(view: Pick<PluginPanelView, "rows">): Map<string, string> {
  return new Map(view.rows.map((row) => [pluginRowKey(row), serializePluginRow(row)]));
}
