import {
  PLUGIN_BUDGET_EXCEEDED_CODE,
  PLUGIN_COLLECTION_VALUE_MAX_BYTES,
  PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN,
  PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN,
  PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES,
  PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN,
  PLUGIN_PANEL_SCHEMA_MAX_BYTES,
  PLUGIN_PANELS_MAX_PER_PLUGIN,
} from "../../../../desktop/src/main/services/state/dbMaintenanceApi";
import { codedError } from "../../../../desktop/src/shared/codedError";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";

/**
 * The only writers for the `plugin_*` tables.
 *
 * "Only" is literal, and it is the whole point: the SDK-facing store the plugin
 * host hands to child processes
 * (`apps/desktop/src/main/services/plugins/pluginDataStore.ts`) validates and
 * serializes, then calls straight through to these functions. It enforces no
 * ceiling of its own. Two writers each enforcing their own copy of the budgets
 * is how a plugin ends up over one of them — whichever path forgets a check is
 * the path a plugin will find.
 *
 * Every cap from `dbMaintenanceApi` is enforced HERE, inside the same
 * `begin immediate` transaction as the insert, because plugin rows are the one
 * part of ADE's schema written by third-party code. The guarantee has to live
 * in the writer rather than in a caller-side check: a check the caller performs
 * before it writes is a check the next caller forgets, and on a cr-sqlite CRR
 * an accepted-then-pruned row still leaves clock and primary-key shadow rows
 * that nothing reclaims while the project has sync peers.
 *
 * Reads live here too so the byte accounting has exactly one definition of
 * "how big is this plugin". `length(cast(x as blob))` is deliberate: bare
 * `length()` on a text value counts CHARACTERS, so a collection full of
 * non-ASCII values would measure well under its real wire and disk cost.
 */

type PluginWriterDb = Pick<AdeDb, "run" | "runChanged" | "get" | "all">;

function budgetExceeded(message: string): Error & { code: typeof PLUGIN_BUDGET_EXCEEDED_CODE } {
  return codedError(message, PLUGIN_BUDGET_EXCEEDED_CODE);
}

/**
 * True when `error` is this module's typed rejection, however it was relayed.
 *
 * Re-exported from the SDK rather than written twice: the SDK path raises the
 * same refusal as a `PluginSdkError`, and one predicate that reads `code` off
 * any shape is what lets a caller branch identically whichever writer it went
 * through.
 */
export { isPluginBudgetExceeded } from "../../../../desktop/src/shared/plugins/sdk";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Run `body` inside a `begin immediate` transaction. IMMEDIATE (rather than
 * DEFERRED) is what makes the count-then-insert below atomic: it takes the
 * write lock before the counting SELECT runs, so a second writer cannot slip a
 * row in between the check and the insert and push the plugin over its cap.
 */
function inWriteTransaction<T>(db: PluginWriterDb, body: () => T): T {
  db.run("begin immediate");
  try {
    const result = body();
    db.run("commit");
    return result;
  } catch (error) {
    try {
      db.run("rollback");
    } catch {
      // A failed rollback means the transaction is already gone; the original
      // error is the one worth reporting.
    }
    throw error;
  }
}

export type PluginCollectionUsage = {
  rows: number;
  bytes: number;
};

/** Current `plugin_collections` footprint for one plugin. */
export function readPluginCollectionUsage(db: PluginWriterDb, pluginId: string): PluginCollectionUsage {
  const row = db.get<{ rows: number; bytes: number }>(
    `select count(*) as rows, coalesce(sum(length(cast(value_json as blob))), 0) as bytes
       from plugin_collections
      where plugin_id = ?`,
    [pluginId],
  );
  return {
    rows: Number(row?.rows ?? 0),
    bytes: Number(row?.bytes ?? 0),
  };
}

export type PutPluginCollectionValueArgs = {
  pluginId: string;
  collection: string;
  key: string;
  /** Already-serialized JSON. The caller owns the shape; the writer owns the size. */
  valueJson: string;
  nowIso: string;
};

/**
 * Upsert one collection value, rejecting the write when it would take the
 * plugin past its row or byte budget.
 *
 * The accounting is delta-based, not "count after insert": replacing an
 * existing 60 KiB value with a 1 KiB one must always be allowed even when the
 * plugin is at its byte ceiling, or a plugin that fills its budget can never
 * shrink itself again and is permanently stuck.
 */
export function putPluginCollectionValue(db: PluginWriterDb, args: PutPluginCollectionValueArgs): void {
  const valueBytes = byteLength(args.valueJson);
  if (valueBytes > PLUGIN_COLLECTION_VALUE_MAX_BYTES) {
    throw budgetExceeded(
      `A single plugin value may be at most ${PLUGIN_COLLECTION_VALUE_MAX_BYTES} bytes (this one is ${valueBytes}).`,
    );
  }
  inWriteTransaction(db, () => {
    const existing = db.get<{ bytes: number }>(
      `select length(cast(value_json as blob)) as bytes
         from plugin_collections
        where plugin_id = ? and collection = ? and key = ?`,
      [args.pluginId, args.collection, args.key],
    );
    const usage = readPluginCollectionUsage(db, args.pluginId);
    const existingBytes = existing ? Number(existing.bytes ?? 0) : 0;
    const nextRows = existing ? usage.rows : usage.rows + 1;
    const nextBytes = usage.bytes - existingBytes + valueBytes;
    if (nextRows > PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN) {
      throw budgetExceeded(
        `This plugin already holds ${usage.rows} stored values, the maximum is ${PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN}.`,
      );
    }
    if (nextBytes > PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN) {
      throw budgetExceeded(
        `This plugin's stored data would reach ${nextBytes} bytes, the maximum is ${PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN}.`,
      );
    }
    db.run(
      `insert into plugin_collections (plugin_id, collection, key, value_json, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(plugin_id, collection, key) do update set
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      [args.pluginId, args.collection, args.key, args.valueJson, args.nowIso],
    );
  });
}

export function deletePluginCollectionValue(
  db: PluginWriterDb,
  args: { pluginId: string; collection: string; key: string },
): boolean {
  return db.runChanged(
    "delete from plugin_collections where plugin_id = ? and collection = ? and key = ?",
    [args.pluginId, args.collection, args.key],
  ) > 0;
}

export type PublishPluginContributionArgs = {
  entityKind: string;
  entityId: string;
  pluginId: string;
  socket: string;
  /** Already-serialized JSON, or null to retract the contribution. */
  payloadJson: string | null;
  nowIso: string;
};

/**
 * Publish (or retract) one materialized socket output. Retraction is a DELETE
 * rather than a null payload so a retracted contribution stops costing a row.
 */
export function publishPluginContribution(db: PluginWriterDb, args: PublishPluginContributionArgs): void {
  if (args.payloadJson == null) {
    db.run(
      `delete from plugin_contributions
        where entity_kind = ? and entity_id = ? and plugin_id = ? and socket = ?`,
      [args.entityKind, args.entityId, args.pluginId, args.socket],
    );
    return;
  }
  const payloadBytes = byteLength(args.payloadJson);
  if (payloadBytes > PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES) {
    throw budgetExceeded(
      `A contribution payload may be at most ${PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES} bytes (this one is ${payloadBytes}).`,
    );
  }
  const payloadJson = args.payloadJson;
  inWriteTransaction(db, () => {
    const existing = db.get<{ present: number }>(
      `select 1 as present from plugin_contributions
        where entity_kind = ? and entity_id = ? and plugin_id = ? and socket = ? limit 1`,
      [args.entityKind, args.entityId, args.pluginId, args.socket],
    );
    if (!existing) {
      const count = Number(db.get<{ count: number }>(
        "select count(*) as count from plugin_contributions where plugin_id = ?",
        [args.pluginId],
      )?.count ?? 0);
      if (count + 1 > PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN) {
        throw budgetExceeded(
          `This plugin already publishes ${count} contributions, the maximum is ${PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN}.`,
        );
      }
    }
    db.run(
      `insert into plugin_contributions (entity_kind, entity_id, plugin_id, socket, payload_json, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(entity_kind, entity_id, plugin_id, socket) do update set
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [args.entityKind, args.entityId, args.pluginId, args.socket, payloadJson, args.nowIso],
    );
  });
}

export type PutPluginPanelArgs = {
  pluginId: string;
  panelId: string;
  title: string;
  icon: string;
  surface: string;
  /** Opaque vocabulary JSON. Its own version lives inside, not in a column. */
  schemaJson: string;
  vocabVersion: number;
  nowIso: string;
};

export function putPluginPanel(db: PluginWriterDb, args: PutPluginPanelArgs): void {
  const schemaBytes = byteLength(args.schemaJson);
  if (schemaBytes > PLUGIN_PANEL_SCHEMA_MAX_BYTES) {
    throw budgetExceeded(
      `A panel schema may be at most ${PLUGIN_PANEL_SCHEMA_MAX_BYTES} bytes (this one is ${schemaBytes}).`,
    );
  }
  inWriteTransaction(db, () => {
    const existing = db.get<{ present: number }>(
      "select 1 as present from plugin_panels where plugin_id = ? and panel_id = ? limit 1",
      [args.pluginId, args.panelId],
    );
    if (!existing) {
      const count = Number(db.get<{ count: number }>(
        "select count(*) as count from plugin_panels where plugin_id = ?",
        [args.pluginId],
      )?.count ?? 0);
      if (count + 1 > PLUGIN_PANELS_MAX_PER_PLUGIN) {
        throw budgetExceeded(
          `This plugin already declares ${count} panels, the maximum is ${PLUGIN_PANELS_MAX_PER_PLUGIN}.`,
        );
      }
    }
    db.run(
      `insert into plugin_panels (plugin_id, panel_id, title, icon, surface, schema_json, vocab_version, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(plugin_id, panel_id) do update set
         title = excluded.title,
         icon = excluded.icon,
         surface = excluded.surface,
         schema_json = excluded.schema_json,
         vocab_version = excluded.vocab_version,
         updated_at = excluded.updated_at`,
      [
        args.pluginId,
        args.panelId,
        args.title,
        args.icon,
        args.surface,
        args.schemaJson,
        Math.max(1, Math.floor(args.vocabVersion)),
        args.nowIso,
      ],
    );
  });
}

export type PluginPresenceRow = {
  pluginId: string;
  version: string;
  enabled: boolean;
  displayName: string;
  icon: string;
  accent: string;
};

/**
 * Replace one machine's presence rows.
 *
 * `machineKey` is always the caller's verified identity — the local machine key
 * when publishing this machine's own state, or the DIRECTORY's key for the
 * machine that answered a fan-out pull. It is never taken from the payload: a
 * machine that could name itself could overwrite another machine's row.
 *
 * Unchanged rows are skipped rather than rewritten. On a CRR an idempotent
 * rewrite is not free — it stamps a fresh clock entry per column and ships a
 * changeset to every peer — and presence republishes on every install-state
 * poll, so "no news" has to cost nothing.
 *
 * Returns the number of rows actually written or removed.
 */
export function replacePluginPresenceForMachine(
  db: PluginWriterDb,
  machineKey: string,
  rows: readonly PluginPresenceRow[],
  nowIso: string,
): number {
  return inWriteTransaction(db, () => {
    const existing = new Map(
      db.all<{
        plugin_id: string;
        version: string;
        enabled: number;
        display_name: string;
        icon: string;
        accent: string;
      }>(
        `select plugin_id, version, enabled, display_name, icon, accent
           from plugin_presence where machine_key = ?`,
        [machineKey],
      ).map((row) => [row.plugin_id, row]),
    );
    let written = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.pluginId);
      const previous = existing.get(row.pluginId);
      const enabled = row.enabled ? 1 : 0;
      if (
        previous
        && previous.version === row.version
        && Number(previous.enabled) === enabled
        && previous.display_name === row.displayName
        && previous.icon === row.icon
        && previous.accent === row.accent
      ) {
        continue;
      }
      db.run(
        `insert into plugin_presence
           (machine_key, plugin_id, version, enabled, display_name, icon, accent, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(machine_key, plugin_id) do update set
           version = excluded.version,
           enabled = excluded.enabled,
           display_name = excluded.display_name,
           icon = excluded.icon,
           accent = excluded.accent,
           updated_at = excluded.updated_at`,
        [machineKey, row.pluginId, row.version, enabled, row.displayName, row.icon, row.accent, nowIso],
      );
      written += 1;
    }
    for (const pluginId of existing.keys()) {
      if (seen.has(pluginId)) continue;
      written += db.runChanged(
        "delete from plugin_presence where machine_key = ? and plugin_id = ?",
        [machineKey, pluginId],
      );
    }
    return written;
  });
}

export function readPluginPresenceForMachine(
  db: PluginWriterDb,
  machineKey: string,
): PluginPresenceRow[] {
  return db.all<{
    plugin_id: string;
    version: string;
    enabled: number;
    display_name: string;
    icon: string;
    accent: string;
  }>(
    `select plugin_id, version, enabled, display_name, icon, accent
       from plugin_presence where machine_key = ? order by plugin_id`,
    [machineKey],
  ).map((row) => ({
    pluginId: row.plugin_id,
    version: row.version,
    enabled: Number(row.enabled) !== 0,
    displayName: row.display_name,
    icon: row.icon,
    accent: row.accent,
  }));
}
