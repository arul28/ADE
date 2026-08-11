import { parsePluginContributionPayload, type PluginEntityKind, type PluginSocketKind } from "../../../shared/plugins/sockets";
import {
  assertPluginCollectionKey,
  assertPluginCollectionName,
  budgetExceeded,
  encodePluginJsonWithinBudget,
  PluginSdkError,
  pluginUtf8ByteLength,
  PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN,
  PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN,
  PLUGIN_COLLECTION_VALUE_MAX_BYTES,
  PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN,
  PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES,
  PLUGIN_PANELS_MAX_PER_PLUGIN,
  PLUGIN_PANEL_SCHEMA_MAX_BYTES,
  type PluginCollectionRow,
  type PluginUsageSummary,
} from "../../../shared/plugins/sdk";
import type { AdeDb } from "../state/kvDb";

/**
 * The three plugin data tables this module writes, character-for-character as
 * `kvDb.ts`'s `migrate()` creates them.
 *
 * CROSS-REFERENCE: `kvDb.ts` is the authority — it creates these alongside
 * `plugin_presence` and `plugin_wire_meter_daily` and lets cr-sqlite's table
 * discovery convert them. This copy exists because `ensureTables` has to work
 * on a database whose migration predates the plugin platform (and in tests),
 * and it is a `create table if not exists`: a copy that DRIFTED from kvDb's
 * would be silently ignored on a migrated database and silently authoritative
 * on an unmigrated one. Keep the two identical or delete this one.
 *
 * Three rules the shape encodes, all non-negotiable:
 *
 * 1. The composite PRIMARY KEY is the ONLY uniqueness constraint. `crsql_as_crr`
 *    refuses a table with any other UNIQUE index, and there is no AUTOINCREMENT
 *    anywhere — a per-site rowid sequence cannot converge.
 * 2. Every column is NOT NULL with a DEFAULT, so a peer that predates a column
 *    can still apply a changeset naming it.
 * 3. The SQL shape is FROZEN. Richer panels version themselves inside
 *    `schema_json`; a new column would reach older iOS clients as an unknown one.
 */
export const PLUGIN_TABLE_DDL: readonly string[] = [
  `create table if not exists plugin_panels (
      plugin_id text not null,
      panel_id text not null,
      title text not null default '',
      icon text not null default '',
      surface text not null default '',
      schema_json text not null default '{}',
      vocab_version integer not null default 1,
      updated_at text not null default '',
      primary key (plugin_id, panel_id)
    )`,
  `create table if not exists plugin_collections (
      plugin_id text not null,
      collection text not null,
      key text not null,
      value_json text not null default 'null',
      updated_at text not null default '',
      primary key (plugin_id, collection, key)
    )`,
  "create index if not exists idx_plugin_collections_scope on plugin_collections(plugin_id, collection)",
  `create table if not exists plugin_contributions (
      entity_kind text not null,
      entity_id text not null,
      plugin_id text not null,
      socket text not null,
      payload_json text not null default 'null',
      updated_at text not null default '',
      primary key (entity_kind, entity_id, plugin_id, socket)
    )`,
  "create index if not exists idx_plugin_contributions_entity on plugin_contributions(entity_kind, entity_id)",
  "create index if not exists idx_plugin_contributions_plugin on plugin_contributions(plugin_id)",
];

export type PluginDataStore = {
  getCollection(pluginId: string, collection: string, key: string): unknown;
  putCollection(pluginId: string, collection: string, key: string, value: unknown): void;
  deleteCollection(pluginId: string, collection: string, key: string): void;
  listCollection(
    pluginId: string,
    collection: string,
    options?: { keyPrefix?: string; limit?: number },
  ): PluginCollectionRow[];
  publishContribution(
    pluginId: string,
    entityKind: PluginEntityKind,
    entityId: string,
    socket: PluginSocketKind,
    payload: Record<string, unknown> | null,
  ): void;
  updatePanel(
    pluginId: string,
    panelId: string,
    args: { title?: string; icon?: string; surface?: string; schema: unknown; vocabVersion: number },
  ): void;
  usage(pluginId?: string): PluginUsageSummary;
  removePluginData(pluginId: string): void;
};

/** Default page size for `collections.list`, and its hard ceiling. */
const PLUGIN_COLLECTION_LIST_DEFAULT_LIMIT = 200;
const PLUGIN_COLLECTION_LIST_MAX_LIMIT = 1_000;

/** Entity ids are foreign keys into ADE's own tables, so only length is ours. */
const PLUGIN_ENTITY_ID_MAX_LENGTH = 512;

function assertEntityId(entityId: unknown): string {
  if (typeof entityId !== "string" || entityId.length === 0 || entityId.length > PLUGIN_ENTITY_ID_MAX_LENGTH) {
    throw new PluginSdkError("invalid_args", `Invalid contribution entity id: ${String(entityId)}`);
  }
  return entityId;
}

/**
 * Byte length in SQL. `length()` on a TEXT column counts characters, which
 * would under-report every non-ASCII value and let a plugin past its byte
 * budget by storing emoji; casting to BLOB counts the stored UTF-8 bytes.
 */
const VALUE_BYTES_SQL = "length(cast(value_json as blob))";

export function createPluginDataStore(deps: { db: AdeDb; ensureTables?: boolean }): PluginDataStore {
  const { db } = deps;
  if (deps.ensureTables !== false) {
    for (const statement of PLUGIN_TABLE_DDL) db.run(statement);
  }

  const nowIso = (): string => new Date().toISOString();

  const collectionTotals = (pluginId: string): { rows: number; bytes: number } => {
    const row = db.get<{ rows: number | null; bytes: number | null }>(
      `select count(*) as rows, coalesce(sum(${VALUE_BYTES_SQL}), 0) as bytes
         from plugin_collections where plugin_id = ?`,
      [pluginId],
    );
    return { rows: Number(row?.rows ?? 0), bytes: Number(row?.bytes ?? 0) };
  };

  const contributionCount = (pluginId: string): number => {
    const row = db.get<{ rows: number | null }>(
      "select count(*) as rows from plugin_contributions where plugin_id = ?",
      [pluginId],
    );
    return Number(row?.rows ?? 0);
  };

  const panelCount = (pluginId: string): number => {
    const row = db.get<{ rows: number | null }>(
      "select count(*) as rows from plugin_panels where plugin_id = ?",
      [pluginId],
    );
    return Number(row?.rows ?? 0);
  };

  return {
    getCollection(pluginId, collection, key) {
      const row = db.get<{ value_json: string }>(
        "select value_json from plugin_collections where plugin_id = ? and collection = ? and key = ?",
        [pluginId, assertPluginCollectionName(collection), assertPluginCollectionKey(key)],
      );
      if (!row) return null;
      try {
        return JSON.parse(row.value_json) as unknown;
      } catch {
        return null;
      }
    },

    putCollection(pluginId, collection, key, value) {
      const name = assertPluginCollectionName(collection);
      const rowKey = assertPluginCollectionKey(key);
      const json = encodePluginJsonWithinBudget(value, "collection_value", PLUGIN_COLLECTION_VALUE_MAX_BYTES);
      const bytes = pluginUtf8ByteLength(json);

      // Both per-plugin ceilings are checked against the totals MINUS the row
      // this write replaces, so an in-place update of an existing key never
      // fails on a budget it already occupies.
      const totals = collectionTotals(pluginId);
      const existing = db.get<{ bytes: number | null }>(
        `select ${VALUE_BYTES_SQL} as bytes from plugin_collections
           where plugin_id = ? and collection = ? and key = ?`,
        [pluginId, name, rowKey],
      );
      const nextRows = totals.rows + (existing ? 0 : 1);
      if (nextRows > PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN) {
        throw budgetExceeded("collection_rows", PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN, nextRows);
      }
      const nextBytes = totals.bytes - Number(existing?.bytes ?? 0) + bytes;
      if (nextBytes > PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN) {
        throw budgetExceeded("collection_bytes", PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN, nextBytes);
      }

      // Upsert, never `insert or replace`: replace is a DELETE plus an INSERT,
      // and the delete would publish a tombstone every peer has to apply.
      db.run(
        `insert into plugin_collections (plugin_id, collection, key, value_json, updated_at)
           values (?, ?, ?, ?, ?)
         on conflict(plugin_id, collection, key)
           do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [pluginId, name, rowKey, json, nowIso()],
      );
    },

    deleteCollection(pluginId, collection, key) {
      db.run(
        "delete from plugin_collections where plugin_id = ? and collection = ? and key = ?",
        [pluginId, assertPluginCollectionName(collection), assertPluginCollectionKey(key)],
      );
    },

    listCollection(pluginId, collection, options) {
      const name = assertPluginCollectionName(collection);
      const limit = Math.min(
        Math.max(1, Math.trunc(options?.limit ?? PLUGIN_COLLECTION_LIST_DEFAULT_LIMIT)),
        PLUGIN_COLLECTION_LIST_MAX_LIMIT,
      );
      const prefix = typeof options?.keyPrefix === "string" ? options.keyPrefix : null;
      const rows = prefix === null
        ? db.all<{ key: string; value_json: string; updated_at: string }>(
          `select key, value_json, updated_at from plugin_collections
             where plugin_id = ? and collection = ? order by key limit ?`,
          [pluginId, name, limit],
        )
        : db.all<{ key: string; value_json: string; updated_at: string }>(
          // ESCAPE so a `%` or `_` inside a plugin-supplied prefix filters
          // literally instead of widening the scan to the whole collection.
          `select key, value_json, updated_at from plugin_collections
             where plugin_id = ? and collection = ? and key like ? escape '\\'
             order by key limit ?`,
          [pluginId, name, `${prefix.replace(/[\\%_]/g, "\\$&")}%`, limit],
        );
      return rows.map((row): PluginCollectionRow => {
        let value: unknown = null;
        try {
          value = JSON.parse(row.value_json) as unknown;
        } catch {
          value = null;
        }
        return { collection: name, key: row.key, value, updatedAt: row.updated_at };
      });
    },

    publishContribution(pluginId, entityKind, entityId, socket, payload) {
      const id = assertEntityId(entityId);
      if (payload === null) {
        db.run(
          `delete from plugin_contributions
             where entity_kind = ? and entity_id = ? and plugin_id = ? and socket = ?`,
          [entityKind, id, pluginId, socket],
        );
        return;
      }
      const parsed = parsePluginContributionPayload(socket, payload);
      if (!parsed) {
        throw new PluginSdkError("invalid_args", `Contribution payload does not match socket "${socket}".`);
      }
      const json = encodePluginJsonWithinBudget(
        parsed,
        "contribution_payload",
        PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES,
      );
      const existing = db.get<{ one: number }>(
        `select 1 as one from plugin_contributions
           where entity_kind = ? and entity_id = ? and plugin_id = ? and socket = ?`,
        [entityKind, id, pluginId, socket],
      );
      if (!existing) {
        const next = contributionCount(pluginId) + 1;
        if (next > PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN) {
          throw budgetExceeded("contributions", PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN, next);
        }
      }
      db.run(
        `insert into plugin_contributions (entity_kind, entity_id, plugin_id, socket, payload_json, updated_at)
           values (?, ?, ?, ?, ?, ?)
         on conflict(entity_kind, entity_id, plugin_id, socket)
           do update set payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
        [entityKind, id, pluginId, socket, json, nowIso()],
      );
    },

    updatePanel(pluginId, panelId, args) {
      const json = encodePluginJsonWithinBudget(args.schema, "panel_schema", PLUGIN_PANEL_SCHEMA_MAX_BYTES);
      const existing = db.get<{ one: number }>(
        "select 1 as one from plugin_panels where plugin_id = ? and panel_id = ?",
        [pluginId, panelId],
      );
      if (!existing) {
        const next = panelCount(pluginId) + 1;
        if (next > PLUGIN_PANELS_MAX_PER_PLUGIN) {
          throw budgetExceeded("panels", PLUGIN_PANELS_MAX_PER_PLUGIN, next);
        }
      }
      db.run(
        `insert into plugin_panels (plugin_id, panel_id, title, icon, surface, schema_json, vocab_version, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(plugin_id, panel_id)
           do update set
             title = excluded.title,
             icon = excluded.icon,
             surface = excluded.surface,
             schema_json = excluded.schema_json,
             vocab_version = excluded.vocab_version,
             updated_at = excluded.updated_at`,
        [
          pluginId,
          panelId,
          args.title ?? "",
          args.icon ?? "",
          args.surface ?? "",
          json,
          Math.trunc(args.vocabVersion),
          nowIso(),
        ],
      );
    },

    usage(pluginId) {
      const where = pluginId ? " where plugin_id = ?" : "";
      const params = pluginId ? [pluginId] : [];
      const collections = db.all<{ plugin_id: string; rows: number; bytes: number }>(
        `select plugin_id, count(*) as rows, coalesce(sum(${VALUE_BYTES_SQL}), 0) as bytes
           from plugin_collections${where} group by plugin_id`,
        params,
      );
      const contributions = db.all<{ plugin_id: string; rows: number }>(
        `select plugin_id, count(*) as rows from plugin_contributions${where} group by plugin_id`,
        params,
      );
      const panels = db.all<{ plugin_id: string; rows: number }>(
        `select plugin_id, count(*) as rows from plugin_panels${where} group by plugin_id`,
        params,
      );
      // Per-plugin wire accounting is written by the sync host into a
      // local-only table that may not exist yet on an unmigrated database, so
      // its absence degrades to zeros rather than failing the whole summary.
      let meter: { plugin_id: string; direction: string; bytes: number }[] = [];
      try {
        meter = db.all<{ plugin_id: string; direction: string; bytes: number }>(
          `select plugin_id, direction, coalesce(sum(bytes), 0) as bytes
             from plugin_wire_meter_daily${where} group by plugin_id, direction`,
          params,
        );
      } catch {
        meter = [];
      }

      const entries = new Map<string, PluginUsageSummary["entries"][number]>();
      const entryFor = (id: string) => {
        let entry = entries.get(id);
        if (!entry) {
          entry = {
            pluginId: id,
            collectionRows: 0,
            collectionBytes: 0,
            contributionRows: 0,
            panelRows: 0,
            syncBytesOut: 0,
            syncBytesIn: 0,
          };
          entries.set(id, entry);
        }
        return entry;
      };
      for (const row of collections) {
        const entry = entryFor(row.plugin_id);
        entry.collectionRows = Number(row.rows ?? 0);
        entry.collectionBytes = Number(row.bytes ?? 0);
      }
      for (const row of contributions) entryFor(row.plugin_id).contributionRows = Number(row.rows ?? 0);
      for (const row of panels) entryFor(row.plugin_id).panelRows = Number(row.rows ?? 0);
      for (const row of meter) {
        const entry = entryFor(row.plugin_id);
        // Matched on the first letter so this keeps working whether the meter
        // writes "in"/"out" or "inbound"/"outbound".
        if (row.direction.startsWith("o")) entry.syncBytesOut = Number(row.bytes ?? 0);
        else if (row.direction.startsWith("i")) entry.syncBytesIn = Number(row.bytes ?? 0);
      }
      return {
        entries: [...entries.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
        budgets: {
          collectionBytesPerPlugin: PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN,
          collectionRowsPerPlugin: PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN,
          contributionsPerPlugin: PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN,
          panelsPerPlugin: PLUGIN_PANELS_MAX_PER_PLUGIN,
        },
      };
    },

    removePluginData(pluginId) {
      db.run("delete from plugin_collections where plugin_id = ?", [pluginId]);
      db.run("delete from plugin_contributions where plugin_id = ?", [pluginId]);
      db.run("delete from plugin_panels where plugin_id = ?", [pluginId]);
    },
  };
}
