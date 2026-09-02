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
import {
  PLUGIN_COLLECTION_MAX_EVICTIONS_PER_PUT,
  type PluginCollectionIfFull,
} from "../../../../desktop/src/shared/plugins/sdk";
import { countRawVocabComponents, parsePluginPanel } from "../../../../desktop/src/shared/plugins/vocabulary";
import { VOCAB_LIMITS } from "../../../../desktop/src/shared/plugins/vocabularyNodes";
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
  /**
   * What to do when the write would exceed a budget. Omitted means `"fail"`,
   * which is the behavior every caller had before the option existed.
   */
  ifFull?: PluginCollectionIfFull;
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
 *
 * With `ifFull: "evictOldest"` a write that does not fit frees room first, by
 * deleting the oldest rows of the SAME collection until it does. Same
 * collection and same plugin, always: a collection is the unit the plugin
 * declared and reasons about, so a cache growing without bound must never be
 * able to consume the plugin's own saved-items collection to keep itself
 * writable, and nothing here ever touches another plugin's rows. The eviction
 * and the insert share this function's transaction, so a crash between them
 * cannot leave a plugin having paid the deletes without gaining the write.
 */
export function putPluginCollectionValue(db: PluginWriterDb, args: PutPluginCollectionValueArgs): void {
  const valueBytes = byteLength(args.valueJson);
  // Checked before the transaction and before any eviction: no number of
  // deletions makes an oversized single value fit, so evicting rows here would
  // be pure loss on the way to the same refusal.
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
    let nextRows = existing ? usage.rows : usage.rows + 1;
    let nextBytes = usage.bytes - existingBytes + valueBytes;

    const overBudget = (rows: number, bytes: number): Error | null => {
      if (rows > PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN) {
        return budgetExceeded(
          `This plugin already holds ${usage.rows} stored values, the maximum is ${PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN}.`,
        );
      }
      if (bytes > PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN) {
        return budgetExceeded(
          `This plugin's stored data would reach ${bytes} bytes, the maximum is ${PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN}.`,
        );
      }
      return null;
    };

    // Captured once, before anything is deleted, and re-thrown unchanged if
    // eviction fails to make room: the plugin should read the same refusal
    // whether or not the host tried to heal it, rather than a message describing
    // a post-eviction state it never asked about.
    const refusal = overBudget(nextRows, nextBytes);
    if (refusal) {
      if (args.ifFull !== "evictOldest") throw refusal;
      // `key <> ?` is what keeps a put from evicting the very row it is about to
      // write — deleting it would free its bytes and then immediately re-spend
      // them, and on a replacement it would turn an update into a delete+insert
      // for no gain.
      const candidates = db.all<{ key: string; bytes: number }>(
        `select key, length(cast(value_json as blob)) as bytes
           from plugin_collections
          where plugin_id = ? and collection = ? and key <> ?
          order by updated_at asc, key asc
          limit ?`,
        [args.pluginId, args.collection, args.key, PLUGIN_COLLECTION_MAX_EVICTIONS_PER_PUT],
      );
      for (const candidate of candidates) {
        if (!overBudget(nextRows, nextBytes)) break;
        db.run(
          "delete from plugin_collections where plugin_id = ? and collection = ? and key = ?",
          [args.pluginId, args.collection, candidate.key],
        );
        nextRows -= 1;
        nextBytes -= Number(candidate.bytes ?? 0);
      }
      // Still over after emptying what it was allowed to: the value is bigger
      // than the whole budget, or the rows in the way live in other collections.
      // Throwing rolls the evictions back with it.
      if (overBudget(nextRows, nextBytes)) throw refusal;
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
  /**
   * Whether the phone should list this panel, resolved from the declaring
   * surface. Defaults to true, which is what every row written before the flag
   * existed means.
   */
  mobile?: boolean;
  /**
   * The manifest's `refreshAction` for this panel, when it declared one.
   *
   * The host's answer, not the plugin's: it comes off the manifest, so a
   * plugin cannot publish a refresh gesture for an action it never declared.
   * Absent or null means the panel has no refresh gesture on any client.
   */
  refreshAction?: string | null;
  /**
   * The manifest's `viewAction` for this panel, when it declared one.
   *
   * Same rule as `refreshAction`: the host's answer, stamped into the schema
   * so a plugin cannot publish a view ack for an action it never declared.
   */
  viewAction?: string | null;
  nowIso: string;
};

/**
 * Stamp the host's own answers onto the stored schema.
 *
 * Inside the JSON rather than in new columns, because the plugin tables are
 * CRR and their SQL shapes are frozen: a column added here would have to be
 * added to every mirror that already exists, while a key inside the payload
 * reaches an old reader as something it ignores. Both vocabulary parsers walk
 * only the roots they know (`v`, `title`, `fallback`, `body`), so a client that
 * predates a key renders the panel exactly as before.
 *
 * Written on every update, never merged: the host's resolution wins over
 * anything the plugin put under the same names, and clearing one has to
 * actually remove it from the row rather than leaving the previous answer
 * standing. `refreshAction` and `viewAction` are dropped rather than written
 * as null for the same reason — an absent key and a null one would then differ
 * on the wire while meaning the same thing.
 */
function withPanelHostKeys(
  schemaJson: string,
  host: { mobile: boolean; refreshAction: string | null; viewAction: string | null },
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaJson) as unknown;
  } catch {
    return schemaJson;
  }
  // A schema that is not an object has nowhere to carry the keys. It is also a
  // panel no client can render, so leaving it byte-identical is the honest
  // answer rather than wrapping it in a shape it never had.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return schemaJson;
  const {
    refreshAction: _droppedRefresh,
    viewAction: _droppedView,
    ...rest
  } = parsed as Record<string, unknown>;
  return JSON.stringify({
    ...rest,
    mobile: host.mobile,
    ...(host.refreshAction ? { refreshAction: host.refreshAction } : {}),
    ...(host.viewAction ? { viewAction: host.viewAction } : {}),
  });
}

/**
 * Refuse a panel whose schema is over a `VOCAB_LIMITS` ceiling.
 *
 * The byte cap above is not the whole budget. A schema can sit well inside
 * 64 KiB and still carry 400 nodes, and an over-`maxNodes` schema is
 * PANEL-FATAL at render on every client — so the row stored fine, replicated
 * fine, and then drew as the fallback card on desktop, iOS and the web with
 * nothing anywhere saying why, while `ade plugin doctor` still counted it as
 * published. Collections refuse at the write with a precise message; panels
 * used to accept silently and fail later on four clients.
 *
 * Only the two COUNTING ceilings are refused here. The degradation ladder is
 * deliberately left alone: an unknown component and a malformed known one are
 * meant to be accepted at the write and become markers at render, and they
 * come back as `warnings` with `ok: true`, so they never reach this branch. The
 * structural failures (`not_json`, `fallback_missing`, a `v` this build does
 * not render) are a different class than a budget and are not this cap's to
 * judge — refusing them here would reject a panel written for a NEWER
 * vocabulary that an updated client would render correctly.
 */
function assertPanelWithinVocabLimits(schemaJson: string): void {
  let source: unknown;
  try {
    source = JSON.parse(schemaJson) as unknown;
  } catch {
    // Unreadable JSON is `not_json` to the parser below, which is a structural
    // failure this function does not judge. Nothing to measure either.
    return;
  }
  const parsed = parsePluginPanel(source);
  if (parsed.ok) return;
  for (const error of parsed.errors) {
    if (error.code === "too_many_nodes") {
      throw budgetExceeded(
        `A panel may contain at most ${VOCAB_LIMITS.maxNodes} nodes `
        + `(this one has ${countRawVocabComponents(source)}).`,
      );
    }
    if (error.code === "too_deep") {
      throw budgetExceeded(`A panel may nest at most ${VOCAB_LIMITS.maxDepth} levels.`);
    }
  }
}

export function putPluginPanel(db: PluginWriterDb, args: PutPluginPanelArgs): void {
  const schemaJson = withPanelHostKeys(args.schemaJson, {
    mobile: args.mobile ?? true,
    refreshAction: args.refreshAction ?? null,
    viewAction: args.viewAction ?? null,
  });
  // Measured after stamping: the cap is a promise about the bytes that land in
  // the row, and the clients check it against exactly those bytes.
  const schemaBytes = byteLength(schemaJson);
  if (schemaBytes > PLUGIN_PANEL_SCHEMA_MAX_BYTES) {
    throw budgetExceeded(
      `A panel schema may be at most ${PLUGIN_PANEL_SCHEMA_MAX_BYTES} bytes (this one is ${schemaBytes}).`,
    );
  }
  assertPanelWithinVocabLimits(schemaJson);
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
        schemaJson,
        Math.max(1, Math.floor(args.vocabVersion)),
        args.nowIso,
      ],
    );
  });
}

/**
 * Drop every row the three plugin tables hold for one plugin.
 *
 * Here rather than as three `db.run("delete …")` calls in the SDK-facing store:
 * these tables are CRR, so a delete is itself a replicated change, and the set
 * of tables that make up "a plugin's data" has to have one definition. A caller
 * that deleted two of the three would leave rows nothing will ever collect —
 * the plugin they belonged to is gone, so no later write can reach them.
 *
 * One transaction, so an uninstall cannot half-apply and leave a plugin with
 * panels but no collections.
 */
export function deleteAllPluginRows(db: PluginWriterDb, pluginId: string): void {
  inWriteTransaction(db, () => {
    db.run("delete from plugin_collections where plugin_id = ?", [pluginId]);
    db.run("delete from plugin_contributions where plugin_id = ?", [pluginId]);
    db.run("delete from plugin_panels where plugin_id = ?", [pluginId]);
  });
}

/**
 * Drop the `plugin_panels` rows one plugin holds whose panel id its manifest no
 * longer declares, and answer with the ids that went.
 *
 * The manifest is the whole truth for which panels a plugin may own: the SDK's
 * `panels.update` refuses a panel id the manifest does not declare
 * (`pluginSdkServer.ts` `requireDeclaredPanel`), so a row outside the declared
 * set is unreachable by the plugin that wrote it — nothing will ever update it
 * and no client should draw it. Without this, dropping a panel from a manifest
 * left its last published row on every surface forever.
 *
 * A plain `delete` on the base table is the right and only supported way to
 * remove a CRR row — the crsql trigger turns it into a replicated delete — so
 * this is the same statement shape `deleteAllPluginRows` uses, one panel at a
 * time so the ids can be reported. The ids are read inside the same
 * `begin immediate` transaction as the deletes so what is reported is exactly
 * what went.
 *
 * `declaredPanelIds` is every panel the manifest declares, not only the ones
 * that ship a `schemaFile`: a declared panel with no schema is still a panel
 * the plugin may publish into at runtime.
 */
export function deleteUndeclaredPluginPanels(
  db: PluginWriterDb,
  pluginId: string,
  declaredPanelIds: readonly string[],
): string[] {
  const declared = new Set(declaredPanelIds);
  return inWriteTransaction(db, () => {
    const stale = db
      .all<{ panel_id: string }>("select panel_id from plugin_panels where plugin_id = ?", [pluginId])
      .map((row) => String(row.panel_id))
      .filter((panelId) => !declared.has(panelId));
    for (const panelId of stale) {
      db.run("delete from plugin_panels where plugin_id = ? and panel_id = ?", [pluginId, panelId]);
    }
    return stale;
  });
}

/** One materialized panel, shaped exactly as the desktop store answers it. */
export type PluginPanelReadRow = {
  pluginId: string;
  panelId: string;
  title: string | null;
  /** Decoded, not the stored text: `null` when the row's JSON is unreadable. */
  schema: unknown;
  vocabVersion: number;
  updatedAt: string | null;
};

/**
 * Read one panel for a client whose replica does not have the row.
 *
 * Byte-for-byte the same answer as `pluginDataStore.readPanel`
 * (apps/desktop/src/main/services/plugins/pluginDataStore.ts:299) — same
 * columns, same decode, same "a corrupt schema still returns the record so the
 * client draws its declared fallback". Two readers that disagree would mean a
 * panel that renders over sync and not over IPC, which is the class of bug this
 * whole repair path exists to end.
 */
export function readPluginPanel(
  db: PluginWriterDb,
  pluginId: string,
  panelId: string,
): PluginPanelReadRow | null {
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
}

/** One row of a collection, shaped as `PluginCollectionRow` on the wire. */
export type PluginCollectionReadRow = {
  collection: string;
  key: string;
  /** Decoded, like the panel schema above. */
  value: unknown;
  updatedAt: string;
};

/** Default and ceiling for one collection read, mirroring the desktop store. */
export const PLUGIN_COLLECTION_READ_DEFAULT_LIMIT = 200;
export const PLUGIN_COLLECTION_READ_MAX_LIMIT = 1_000;

/**
 * Read rows of one collection, optionally narrowed by key prefix.
 *
 * The sibling of {@link readPluginPanel}, and the same copy of
 * `pluginDataStore.listCollection` (pluginDataStore.ts:219): same ordering,
 * same bounds, and the same `escape` clause so a `%` or `_` inside a
 * caller-supplied prefix filters literally instead of widening the scan to the
 * whole collection.
 */
export function readPluginCollectionRows(
  db: PluginWriterDb,
  args: { pluginId: string; collection: string; keyPrefix?: string | null; limit?: number },
): PluginCollectionReadRow[] {
  const limit = Math.min(
    Math.max(1, Math.trunc(args.limit ?? PLUGIN_COLLECTION_READ_DEFAULT_LIMIT)),
    PLUGIN_COLLECTION_READ_MAX_LIMIT,
  );
  const prefix = typeof args.keyPrefix === "string" && args.keyPrefix.length > 0 ? args.keyPrefix : null;
  const rows = prefix === null
    ? db.all<{ key: string; value_json: string; updated_at: string }>(
      `select key, value_json, updated_at from plugin_collections
         where plugin_id = ? and collection = ? order by key limit ?`,
      [args.pluginId, args.collection, limit],
    )
    : db.all<{ key: string; value_json: string; updated_at: string }>(
      `select key, value_json, updated_at from plugin_collections
         where plugin_id = ? and collection = ? and key like ? escape '\\'
         order by key limit ?`,
      [args.pluginId, args.collection, `${prefix.replace(/[\\%_]/g, "\\$&")}%`, limit],
    );
  return rows.map((row) => {
    let value: unknown = null;
    try {
      value = JSON.parse(row.value_json) as unknown;
    } catch {
      value = null;
    }
    return { collection: args.collection, key: row.key, value, updatedAt: row.updated_at };
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

/**
 * Drop one machine's presence row for one plugin.
 *
 * The uninstall counterpart to {@link replacePluginPresenceForMachine}, and it
 * exists because the republish that normally carries a removal cannot be relied
 * on to reach every database: presence publishes into the ONE project scope
 * that currently owns the presence service, while a plugin's rows can sit in
 * every project database this machine has attached. Rows left behind are not
 * inert — another machine reading them sees this one as still having the plugin
 * enabled, which is the exact stale signal the coverage matrix exists to avoid.
 *
 * `machineKey` is this machine's own key, never one taken from a payload: an
 * uninstall here says nothing about what any other machine has installed, so it
 * must not be able to delete another machine's row.
 *
 * A delete on a CRR table is itself a replicated change, so this removal
 * reaches peers the same way the write did. Returns the number of rows removed.
 */
export function deletePluginPresenceForPlugin(
  db: PluginWriterDb,
  machineKey: string,
  pluginId: string,
): number {
  if (!machineKey) return 0;
  return inWriteTransaction(db, () => db.runChanged(
    "delete from plugin_presence where machine_key = ? and plugin_id = ?",
    [machineKey, pluginId],
  ));
}

/**
 * The raw `plugin_contributions` row, string-typed fields and all — every
 * field here is exactly what SQLite returns, before `entityKind`/`socket` are
 * narrowed to their closed unions and joined against the declaring manifest.
 * Named distinctly from `sdk.ts`'s `PluginContributionRecord` (the public
 * shape a caller of `plugin.listContributions` actually receives) so the two
 * are never mistaken for each other at a call site that imports both.
 */
export type PluginContributionDbRow = {
  entityKind: string;
  entityId: string;
  pluginId: string;
  socket: string;
  /** Still JSON. The caller decides what a payload means; this module sizes it. */
  payloadJson: string;
  updatedAt: string;
};

/** Rows one `listContributions` answer may carry, before surface filtering. */
export const PLUGIN_CONTRIBUTIONS_READ_LIMIT = 2_000;

/**
 * Materialized socket outputs, optionally narrowed to one entity kind.
 *
 * Reads live here beside the writers so "what is a contribution" has one
 * definition. Deliberately NOT filtered by surface: the table stores the socket
 * KIND, and which surface a socket belongs to is a manifest fact the caller
 * holds — pushing that join into SQL would mean this module parsing manifests.
 *
 * Bounded because this answers a per-render read on core surfaces: a plugin at
 * its 2,000-contribution ceiling must not be able to make the Lanes list pay
 * for all of them at once.
 */
export function readPluginContributions(
  db: PluginWriterDb,
  args: { entityKind?: string | null; entityIds?: readonly string[] | null; limit?: number } = {},
): PluginContributionDbRow[] {
  const limit = Math.min(
    Math.max(1, Math.trunc(args.limit ?? PLUGIN_CONTRIBUTIONS_READ_LIMIT)),
    PLUGIN_CONTRIBUTIONS_READ_LIMIT,
  );
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (args.entityKind) {
    where.push("entity_kind = ?");
    params.push(args.entityKind);
  }
  if (args.entityIds && args.entityIds.length > 0) {
    where.push(`entity_id in (${args.entityIds.map(() => "?").join(", ")})`);
    params.push(...args.entityIds);
  }
  params.push(limit);
  return db.all<{
    entity_kind: string;
    entity_id: string;
    plugin_id: string;
    socket: string;
    payload_json: string;
    updated_at: string;
  }>(
    `select entity_kind, entity_id, plugin_id, socket, payload_json, updated_at
       from plugin_contributions
       ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
      order by entity_kind, entity_id, plugin_id, socket
      limit ?`,
    params,
  ).map((row) => ({
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    pluginId: row.plugin_id,
    socket: row.socket,
    payloadJson: row.payload_json,
    updatedAt: row.updated_at,
  }));
}

/** One machine's row for one plugin, as the presence table stores it. */
export type PluginPresenceMachineEntry = PluginPresenceRow & { machineKey: string };

/**
 * Every machine's presence rows, for the coverage matrix.
 *
 * Reads the CRR table rather than asking peers: the rows are the durable floor
 * the fan-out maintains, so this answers the same on a machine that is offline
 * right now. Ordered by machine then plugin so the matrix renders stably
 * instead of reshuffling on every poll.
 */
export function readAllPluginPresence(db: PluginWriterDb): PluginPresenceMachineEntry[] {
  return db.all<{
    machine_key: string;
    plugin_id: string;
    version: string;
    enabled: number;
    display_name: string;
    icon: string;
    accent: string;
  }>(
    `select machine_key, plugin_id, version, enabled, display_name, icon, accent
       from plugin_presence order by machine_key, plugin_id`,
  ).map((row) => ({
    machineKey: row.machine_key,
    pluginId: row.plugin_id,
    version: row.version,
    enabled: Number(row.enabled) !== 0,
    displayName: row.display_name,
    icon: row.icon,
    accent: row.accent,
  }));
}

