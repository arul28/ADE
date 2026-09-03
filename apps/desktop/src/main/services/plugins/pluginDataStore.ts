import {
  deleteAllPluginRows,
  deletePluginCollectionValue,
  deleteUndeclaredPluginPanels,
  isPluginBudgetExceeded,
  publishPluginContribution,
  putPluginCollectionValue,
  putPluginPanel,
  readPluginCollectionUsage,
} from "../../../../../ade-cli/src/services/plugins/pluginTableWriters";
import { parsePluginContributionPayload, type PluginEntityKind, type PluginSocketKind } from "../../../shared/plugins/sockets";
import {
  assertPluginCollectionKey,
  assertPluginCollectionName,
  PluginSdkError,
  PLUGIN_BUDGET_EXCEEDED_CODE,
  PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN,
  PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN,
  PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN,
  PLUGIN_PANELS_MAX_PER_PLUGIN,
  type PluginCollectionPutOptions,
  type PluginCollectionRow,
  type PluginPanelRecord,
  type PluginUsageSummary,
} from "../../../shared/plugins/sdk";
import { SYNC_PLUGIN_TABLES } from "../../../shared/types/sync";
import { PLUGIN_TABLE_DDL, type AdeDb } from "../state/kvDb";
import { emitPluginChange } from "./pluginEvents";

/**
 * The three plugin data tables this module writes.
 *
 * Re-exported from `kvDb.ts` rather than restated: `ensureTables` has to create
 * them on a database whose migration predates the plugin platform (and in
 * tests), but both are `create table if not exists`, so a second copy that
 * DRIFTED from kvDb's would be silently ignored on a migrated database and
 * silently authoritative on an unmigrated one. See the constant there for the
 * three shape rules the SQL encodes.
 */
export { PLUGIN_TABLE_DDL };

export type PluginDataStore = {
  getCollection(pluginId: string, collection: string, key: string): unknown;
  /**
   * Store a value. `options.ifFull` is the plugin's own choice about what a full
   * budget means for THIS collection; omitting it refuses the write, which is
   * what every caller written before the option existed gets.
   */
  putCollection(
    pluginId: string,
    collection: string,
    key: string,
    value: unknown,
    options?: PluginCollectionPutOptions,
  ): void;
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
    args: {
      title?: string;
      icon?: string;
      surface?: string;
      schema: unknown;
      vocabVersion: number;
      /** Whether the phone lists this panel. Omitted means yes — see the writer. */
      mobile?: boolean;
      /**
       * The manifest's refresh action for this panel. Omitted means the panel
       * has no refresh gesture — see {@link PluginManifestPanel.refreshAction}.
       */
      refreshAction?: string | null;
      /**
       * The manifest's view action for this panel. Omitted means the host does
       * not tell the plugin when this panel is on screen.
       */
      viewAction?: string | null;
      /**
       * True only for the host's own seed of a manifest-declared schema. A
       * plugin's `panels.update` never sets it, so the flag answers "is this
       * row still the shipped default?" — which is what lets a client run the
       * panel's first refresh on its own.
       */
      seeded?: boolean;
    },
  ): void;
  /** The materialized panel row, which is what every client actually renders. */
  readPanel(pluginId: string, panelId: string): PluginPanelRecord | null;
  /**
   * Drop this plugin's panel rows whose id `declaredPanelIds` does not name,
   * and answer with the ids that went. The manifest's panel list is the only
   * legitimate argument — see the writer.
   */
  prunePanels(pluginId: string, declaredPanelIds: readonly string[]): string[];
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
 * Serialize a value for storage. Size is NOT checked here: the writers in
 * `pluginTableWriters` own every ceiling and enforce it inside the same
 * transaction as the insert, so a check on this side could only disagree.
 */
function encodePluginJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch (error) {
    throw new PluginSdkError(
      "invalid_args",
      `Value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Run a writer, translating its `codedError` budget rejection into the SDK's
 * typed error. Both carry the same `plugin_budget_exceeded` code — this only
 * changes the CLASS, so an SDK caller that branches on `PluginSdkError` sees a
 * refusal rather than an anonymous internal failure.
 */
function withBudgetErrors<T>(budget: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!isPluginBudgetExceeded(error)) throw error;
    throw new PluginSdkError(
      PLUGIN_BUDGET_EXCEEDED_CODE,
      error instanceof Error ? error.message : String(error),
      { budget },
    );
  }
}

/**
 * Byte length in SQL. `length()` on a TEXT column counts characters, which
 * would under-report every non-ASCII value and let a plugin past its byte
 * budget by storing emoji; casting to BLOB counts the stored UTF-8 bytes.
 */
const VALUE_BYTES_SQL = "length(cast(value_json as blob))";

export function createPluginDataStore(deps: {
  db: AdeDb;
  ensureTables?: boolean;
  /**
   * Called after a collection write lands. The sync host pushes plugin panels
   * on this rather than waiting for its poll; it is a no-op when nobody has a
   * panel open, so it is safe to fire on every write. Injected so this module
   * keeps no dependency on the sync layer.
   */
  onCollectionChanged?: () => void;
}): PluginDataStore {
  const { db } = deps;
  if (deps.ensureTables !== false) {
    for (const statement of PLUGIN_TABLE_DDL) db.run(statement);
    // A table this store creates is born PLAIN. `openKvDb` registers CRRs once,
    // at open, long before any project is attached, so a table created here has
    // no cr-sqlite triggers and nothing written to it enters `crsql_changes` —
    // and a row that is not in the change log cannot be exported by any path,
    // including the plugin catch-up. That is a plugin whose data is visible on
    // the machine that wrote it and on no other device, for ever. Registering
    // them here is idempotent, and it repairs a database that already collected
    // plain rows: `crsql_as_crr` backfills what the table already holds.
    db.sync?.ensureTablesAreCrr?.(SYNC_PLUGIN_TABLES);
  }

  const nowIso = (): string => new Date().toISOString();

  const notifyCollectionChanged = (pluginId: string, collection: string): void => {
    deps.onCollectionChanged?.();
    emitPluginChange({ kind: "collections", pluginId, collection });
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

    putCollection(pluginId, collection, key, value, options) {
      const name = assertPluginCollectionName(collection);
      const rowKey = assertPluginCollectionKey(key);
      withBudgetErrors("collections", () => {
        putPluginCollectionValue(db, {
          pluginId,
          collection: name,
          key: rowKey,
          valueJson: encodePluginJson(value),
          // Spread rather than passed as `undefined` so the writer's args are
          // shaped identically to before on the default path.
          ...(options?.ifFull ? { ifFull: options.ifFull } : {}),
          nowIso: nowIso(),
        });
      });
      notifyCollectionChanged(pluginId, name);
    },

    deleteCollection(pluginId, collection, key) {
      const name = assertPluginCollectionName(collection);
      deletePluginCollectionValue(db, {
        pluginId,
        collection: name,
        key: assertPluginCollectionKey(key),
      });
      notifyCollectionChanged(pluginId, name);
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
        publishPluginContribution(db, {
          entityKind,
          entityId: id,
          pluginId,
          socket,
          payloadJson: null,
          nowIso: nowIso(),
        });
        return;
      }
      const parsed = parsePluginContributionPayload(socket, payload);
      if (!parsed) {
        throw new PluginSdkError("invalid_args", `Contribution payload does not match socket "${socket}".`);
      }
      withBudgetErrors("contributions", () => {
        publishPluginContribution(db, {
          entityKind,
          entityId: id,
          pluginId,
          socket,
          payloadJson: encodePluginJson(parsed),
          nowIso: nowIso(),
        });
      });
      emitPluginChange({ kind: "contributions", pluginId });
    },

    updatePanel(pluginId, panelId, args) {
      withBudgetErrors("panels", () => {
        putPluginPanel(db, {
          pluginId,
          panelId,
          title: args.title ?? "",
          icon: args.icon ?? "",
          surface: args.surface ?? "",
          schemaJson: encodePluginJson(args.schema),
          vocabVersion: Math.trunc(args.vocabVersion),
          ...(args.mobile === undefined ? {} : { mobile: args.mobile }),
          ...(args.refreshAction === undefined ? {} : { refreshAction: args.refreshAction }),
          ...(args.viewAction === undefined ? {} : { viewAction: args.viewAction }),
          ...(args.seeded === undefined ? {} : { seeded: args.seeded }),
          nowIso: nowIso(),
        });
      });
      emitPluginChange({ kind: "panels", pluginId, panelId });
    },

    readPanel(pluginId, panelId) {
      const row = db.get<{
        title: string;
        schema_json: string;
        vocab_version: number;
        updated_at: string;
      }>(
        `select title, schema_json, vocab_version, updated_at
           from plugin_panels where plugin_id = ? and panel_id = ?`,
        [pluginId, panelId],
      );
      if (!row) return null;
      let schema: unknown = null;
      try {
        schema = JSON.parse(row.schema_json) as unknown;
      } catch {
        // One corrupt row must not blank the whole panel surface: the record is
        // still returned so the client renders the panel's declared fallback.
        schema = null;
      }
      return {
        pluginId,
        panelId,
        title: row.title || null,
        schema,
        vocabVersion: Number(row.vocab_version ?? 1),
        updatedAt: row.updated_at || null,
      };
    },

    prunePanels(pluginId, declaredPanelIds) {
      const removed = deleteUndeclaredPluginPanels(db, pluginId, declaredPanelIds);
      // One event per row that went, the same shape `updatePanel` emits: a
      // client holding a removed panel has to refetch it to learn it is gone.
      for (const panelId of removed) emitPluginChange({ kind: "panels", pluginId, panelId });
      return removed;
    },

    usage(pluginId) {
      const where = pluginId ? " where plugin_id = ?" : "";
      const params = pluginId ? [pluginId] : [];
      // One plugin is measured by the writers' own accounting, so "how big is
      // this plugin" has a single definition on the read and write paths.
      const collections = pluginId
        ? (() => {
          const totals = readPluginCollectionUsage(db, pluginId);
          return totals.rows > 0
            ? [{ plugin_id: pluginId, rows: totals.rows, bytes: totals.bytes }]
            : [];
        })()
        : db.all<{ plugin_id: string; rows: number; bytes: number }>(
          `select plugin_id, count(*) as rows, coalesce(sum(${VALUE_BYTES_SQL}), 0) as bytes
             from plugin_collections group by plugin_id`,
        );
      const contributions = db.all<{ plugin_id: string; rows: number }>(
        `select plugin_id, count(*) as rows from plugin_contributions${where} group by plugin_id`,
        params,
      );
      const panels = db.all<{ plugin_id: string; rows: number }>(
        `select plugin_id, count(*) as rows from plugin_panels${where} group by plugin_id`,
        params,
      );

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
            // Wire bytes are the sync meter's to report — it holds counters
            // this database has not seen a flush of yet, so the host merges
            // them in rather than this reading the meter table behind its back.
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
      deleteAllPluginRows(db, pluginId);
    },
  };
}
