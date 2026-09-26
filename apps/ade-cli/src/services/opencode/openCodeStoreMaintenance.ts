import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Pruning for an OpenCode data store.
 *
 * Why this exists: OpenCode keeps an append-only `event` log whose
 * `message.updated` entries snapshot the WHOLE message on every update,
 * including complete `summary.diffs[].patch` payloads. On one real machine the
 * event table was 11.5 GB of a 12.5 GB store, with single rows of 88 MB and 621
 * rows over 1 MB. Deleting the file only postpones the problem, and ADE's own
 * maintenance sweep never touched this store.
 *
 * The unit of deletion is a whole SESSION, never individual event rows: the
 * projection tables (`message`, `part`, `session_message`, …) are the read
 * model, and `event` rows cascade from `event_sequence` per aggregate. Deleting
 * a subset of one live session's event rows would break replay/sync from those
 * sequences; deleting the session's `event_sequence` row along with the session
 * is exactly what OpenCode's own `Session.remove` does.
 *
 * This module is deliberately filesystem + SQLite only. It does not know about
 * ADE chats, leases, or the server; the caller owns discovery and policy.
 */

export type OpenCodeStoreKind = "ade" | "user" | "path";

export type OpenCodeStoreTarget = {
  kind: OpenCodeStoreKind;
  /** The `opencode/` data directory holding `opencode.db*`. */
  dataRoot: string;
  /** Chosen database file (channel suffix resolved). */
  dbPath: string;
};

export class OpenCodeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeStoreError";
  }
}

export function parseOpenCodeStoreDuration(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)\s*(m|min|h|hr|d|day|days|w|week|weeks)?$/.exec(trimmed);
  if (!match) {
    throw new OpenCodeStoreError(`Invalid duration "${value}". Use forms like 30m, 12h, 14d, 2w.`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "d";
  const multiplier = unit.startsWith("m")
    ? 60_000
    : unit.startsWith("h")
      ? 3_600_000
      : unit.startsWith("d")
        ? 86_400_000
        : 7 * 86_400_000;
  return amount * multiplier;
}

/** The user's OpenCode data root, matching xdg-basedir exactly. */
export function resolveUserOpenCodeDataRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.XDG_DATA_HOME?.trim();
  if (configured) return path.resolve(configured, "opencode");
  const homeDir = env.HOME?.trim() || os.homedir().trim();
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim()
      || (homeDir ? path.join(homeDir, "AppData", "Local") : "");
    return localAppData ? path.join(localAppData, "opencode") : null;
  }
  return homeDir ? path.join(homeDir, ".local", "share", "opencode") : null;
}

/** ADE's owned data root, matching the desktop manager's fallback resolution. */
export function resolveAdeOpenCodeDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ADE_OPENCODE_XDG_ROOT?.trim();
  const root = override
    ? path.resolve(override)
    : path.join(os.homedir().trim() || os.tmpdir(), ".ade", "opencode-runtime");
  return path.join(root, "xdg-v1", "data");
}

function listStoreDatabases(dataRoot: string): string[] {
  if (!fs.existsSync(dataRoot)) return [];
  return fs
    .readdirSync(dataRoot)
    .filter((entry) => /^opencode(-[a-z]+)?\.db$/.test(entry))
    .map((entry) => path.join(dataRoot, entry))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Resolve a store target. `--store user` is the user's personal OpenCode home;
 * `--store ade` is ADE's owned home. `--store <path>` accepts either the data
 * root or the database file itself.
 */
export function resolveOpenCodeStoreTarget(
  store: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeStoreTarget {
  const trimmed = store.trim();
  if (trimmed === "user" || trimmed === "ade") {
    const dataRoot = trimmed === "user" ? resolveUserOpenCodeDataRoot(env) : resolveAdeOpenCodeDataRoot(env);
    if (!dataRoot) throw new OpenCodeStoreError(`Could not resolve the ${trimmed} OpenCode data root.`);
    const databases = listStoreDatabases(dataRoot);
    if (databases.length === 0) {
      throw new OpenCodeStoreError(`No OpenCode database found under ${dataRoot}.`);
    }
    // A pinned binary uses `opencode.db`; a locally built one may use a channel
    // suffix. Prefer the canonical name, else the most recently modified.
    const dbPath = databases.find((file) => path.basename(file) === "opencode.db")
      ?? databases.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0]!;
    return { kind: trimmed, dataRoot, dbPath };
  }

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) throw new OpenCodeStoreError(`No OpenCode store at ${resolved}.`);
  if (fs.statSync(resolved).isDirectory()) {
    const databases = listStoreDatabases(resolved);
    if (databases.length === 0) throw new OpenCodeStoreError(`No OpenCode database found under ${resolved}.`);
    const dbPath = databases.find((file) => path.basename(file) === "opencode.db")
      ?? databases.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0]!;
    return { kind: "path", dataRoot: resolved, dbPath };
  }
  return { kind: "path", dataRoot: path.dirname(resolved), dbPath: resolved };
}

export type OpenCodeStoreTableSize = {
  table: string;
  /** Bytes held by the table's B-tree plus its indexes, from `dbstat`. */
  bytes: number;
  rows: number;
};

export type OpenCodePrunePlan = {
  dbPath: string;
  fileBytes: number;
  totalSessions: number;
  eligibleSessions: string[];
  /** Payload bytes of the eligible sessions' own rows (event/message/part). */
  reclaimablePayloadBytes: number;
  byTable: Array<{ table: string; rows: number; bytes: number }>;
  tableSizes: OpenCodeStoreTableSize[];
};

export type OpenCodeApplyResult = {
  deletedSessions: number;
  deletedEvents: number;
  deletedMessages: number;
  deletedParts: number;
  vacuumed: boolean;
  fileBytesBefore: number;
  fileBytesAfter: number;
};

const PAYLOAD_TABLES = ["event", "message", "part"] as const;

function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // Cascades only fire on a connection that enables them; OpenCode's own
  // connection does, and the maintenance path must match or it would delete a
  // session row and leave every child row behind.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 2500");
  return db;
}

type TableInfoRow = { name?: unknown };

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as TableInfoRow[];
  return new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")).filter(Boolean));
}

export function planOpenCodeStorePrune(args: {
  dbPath: string;
  cutoffMs: number;
  nowMs?: number;
}): OpenCodePrunePlan {
  const fileBytes = fs.statSync(args.dbPath).size;
  const db = openDatabase(args.dbPath);
  try {
    const tables = tableNames(db);
    if (!tables.has("session") || !tables.has("event") || !tables.has("event_sequence")) {
      throw new OpenCodeStoreError(
        `${args.dbPath} is not an OpenCode store: session/event/event_sequence tables are missing.`,
      );
    }
    const totalSessions = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM session").get() as { count: number | bigint }).count,
    );
    const eligible = db
      .prepare(
        `WITH RECURSIVE doomed(id) AS (
           SELECT id FROM session WHERE time_updated < :cutoff
           UNION
           SELECT child.id FROM session child JOIN doomed parent ON child.parent_id = parent.id
         )
         SELECT id FROM doomed ORDER BY id`,
      )
      .all({ cutoff: args.cutoffMs }) as Array<{ id: string }>;
    const eligibleIds = eligible.map((row) => row.id);

    const byTable: OpenCodePrunePlan["byTable"] = [];
    let reclaimablePayloadBytes = 0;
    if (eligibleIds.length > 0) {
      const placeholders = eligibleIds.map(() => "?").join(",");
      for (const table of PAYLOAD_TABLES) {
        if (!tables.has(table)) continue;
        const dataColumn = table === "event" ? "data" : "data";
        const column = table === "part" ? "session_id" : table === "message" ? "session_id" : "aggregate_id";
        const row = db
          .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(${dataColumn})), 0) AS bytes
             FROM ${table} WHERE ${column} IN (${placeholders})`,
          )
          .get(...eligibleIds) as { rows: number | bigint; bytes: number | bigint };
        const bytes = Number(row.bytes);
        reclaimablePayloadBytes += bytes;
        byTable.push({ table, rows: Number(row.rows), bytes });
      }
    }

    // Whole-store attribution so the report can say WHERE the bytes are, not
    // just what this run would free. `dbstat` is compiled into the SQLite
    // builds Node ships; if it is unavailable the report degrades to payload
    // sums rather than failing the command.
    const tableSizes: OpenCodeStoreTableSize[] = [];
    try {
      const statRows = db
        .prepare(
          "SELECT name AS table, SUM(pgsize) AS bytes, SUM(ncell) AS rows FROM dbstat GROUP BY name ORDER BY bytes DESC",
        )
        .all() as Array<{ table?: unknown; bytes?: unknown; rows?: unknown }>;
      for (const row of statRows) {
        if (typeof row.table !== "string") continue;
        tableSizes.push({
          table: row.table,
          bytes: Number(row.bytes ?? 0),
          rows: Number(row.rows ?? 0),
        });
      }
    } catch {
      // dbstat unavailable; tableSizes stays empty.
    }

    return {
      dbPath: args.dbPath,
      fileBytes,
      totalSessions,
      eligibleSessions: eligibleIds,
      reclaimablePayloadBytes,
      byTable,
      tableSizes,
    };
  } finally {
    db.close();
  }
}

/** True when another connection holds a write lock (a running server). */
export function openCodeStoreHasActiveWriter(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

export function applyOpenCodeStorePrune(args: {
  plan: OpenCodePrunePlan;
  vacuum?: boolean;
}): OpenCodeApplyResult {
  const { plan } = args;
  const fileBytesBefore = fs.statSync(plan.dbPath).size;
  const db = openDatabase(plan.dbPath);
  let deletedEvents = 0;
  let deletedMessages = 0;
  let deletedParts = 0;
  try {
    if (plan.eligibleSessions.length === 0) {
      return {
        deletedSessions: 0,
        deletedEvents: 0,
        deletedMessages: 0,
        deletedParts: 0,
        vacuumed: false,
        fileBytesBefore,
        fileBytesAfter: fileBytesBefore,
      };
    }
    const placeholders = plan.eligibleSessions.map(() => "?").join(",");
    db.exec("BEGIN IMMEDIATE");
    try {
      const countOf = (sql: string): number => Number((db.prepare(sql).get(...plan.eligibleSessions) as { count: number | bigint }).count);
      deletedEvents = countOf(
        `SELECT COUNT(*) AS count FROM event WHERE aggregate_id IN (${placeholders})`,
      );
      deletedMessages = countOf(
        `SELECT COUNT(*) AS count FROM message WHERE session_id IN (${placeholders})`,
      );
      deletedParts = countOf(
        `SELECT COUNT(*) AS count FROM part WHERE session_id IN (${placeholders})`,
      );
      // Order matters. `event` cascades from `event_sequence`, never from
      // `session`; deleting the sequence row first removes the log. The session
      // row then cascades every projection table. Children are part of the
      // selection already (recursive CTE), so a parent-first delete cannot
      // strand them.
      db.prepare(`DELETE FROM event_sequence WHERE aggregate_id IN (${placeholders})`).run(...plan.eligibleSessions);
      db.prepare(`DELETE FROM session WHERE id IN (${placeholders})`).run(...plan.eligibleSessions);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }

  let vacuumed = false;
  if (args.vacuum) {
    const vacuumDb = new DatabaseSync(plan.dbPath);
    try {
      vacuumDb.exec("PRAGMA busy_timeout = 30000");
      vacuumDb.exec("VACUUM");
      vacuumed = true;
    } finally {
      vacuumDb.close();
    }
  }

  return {
    deletedSessions: plan.eligibleSessions.length,
    deletedEvents,
    deletedMessages,
    deletedParts,
    vacuumed,
    fileBytesBefore,
    fileBytesAfter: fs.statSync(plan.dbPath).size,
  };
}
