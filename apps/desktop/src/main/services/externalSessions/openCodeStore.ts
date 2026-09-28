import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveUserOpenCodeDataRoot } from "../../../shared/opencodeDataHome";
import { hasTable } from "../projects/readOnlySqlite";
import {
  closeExternalSessionDb,
  openExternalSessionDb,
  resolveHomeDir,
  type ExternalSessionDiscoveryArgs,
} from "./discoveryUtils";

/**
 * The user's own OpenCode store, read directly and read-only.
 *
 * ADE never starts OpenCode on this store: OpenCode 2.0 migrates a v1 database
 * in place when it opens one, and the user's own OpenCode may still be 1.x. A
 * direct read also avoids the CLI, whose piped stdout was cut at 64 KiB.
 *
 * Two schemas exist. A 1.x store keeps `session`, `message`, and `part` (1.18
 * also has a `session_message` preview table, so that name alone proves
 * nothing). A 2.0 store keeps `session_v2` and `session_message`; a migrated
 * store keeps the old tables too, but only `session_v2` has every session.
 */

export type OpenCodeStoreSchema = "v1" | "v2";

const V2_PAGE_ROWS = 200;

export type OpenCodeStoreHandle = {
  db: DatabaseSyncType;
  schema: OpenCodeStoreSchema;
  close(): void;
};

export type OpenCodeStoreSessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  userMessageCount: number | null;
};

/** One stored message: `data` is OpenCode's own JSON for it. */
export type OpenCodeStoreMessageRow = {
  id: string;
  /** v2: the message type. v1: always "message" (the role is inside `data`). */
  type: string;
  createdAt: number | null;
  data: string;
  /** v1 only: the message's parts, oldest first, each OpenCode's own JSON. */
  parts?: Array<{ id: string; data: string }>;
};

/** `opencode.db` of the user's own store, honoring a caller-supplied home. */
export function resolveUserOpenCodeDbPath(
  args: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env"> = {},
): string | null {
  // A caller-supplied home must not be overridden by this machine's own
  // XDG_DATA_HOME, or a test or remote-profile read would reach the real store.
  const baseEnv = args.env ?? (args.homeDir ? {} : process.env);
  const root = resolveUserOpenCodeDataRoot({ ...baseEnv, HOME: resolveHomeDir(args) });
  return root ? path.join(root, "opencode.db") : null;
}

export function openUserOpenCodeStore(
  args: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env" | "logger"> = {},
): OpenCodeStoreHandle | null {
  const dbPath = resolveUserOpenCodeDbPath(args);
  if (!dbPath) return null;
  const db = openExternalSessionDb(dbPath, args.logger);
  if (!db) return null;
  try {
    // A running OpenCode may hold the write lock; answer at once rather than wait.
    db.exec("PRAGMA busy_timeout = 0");
    const schema: OpenCodeStoreSchema | null = hasTable(db, "session_v2")
      ? "v2"
      : hasTable(db, "session") && hasTable(db, "message") && hasTable(db, "part")
        ? "v1"
        : null;
    if (!schema) {
      closeExternalSessionDb(db);
      return null;
    }
    return { db, schema, close: () => closeExternalSessionDb(db) };
  } catch (error) {
    args.logger?.warn?.("external_sessions.opencode_store_unreadable", {
      dbPath,
      error: error instanceof Error ? error.message : String(error),
    });
    closeExternalSessionDb(db);
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Top-level, unarchived sessions, newest first. Child sessions are subagent
 * runs, not something a user picks to continue.
 */
export function listOpenCodeStoreSessions(
  store: OpenCodeStoreHandle,
  args: { limit: number; sessionId?: string | null },
): OpenCodeStoreSessionRow[] {
  const idFilter = args.sessionId ? "AND s.id = ?" : "";
  const params: Array<string | number> = [...(args.sessionId ? [args.sessionId] : []), Math.max(1, args.limit)];
  // v1 stores the role inside each message's JSON, and counting it would parse
  // every message of every listed session; the count stays unknown there.
  const sql = store.schema === "v2"
    ? `SELECT s.id AS id, s.directory AS directory, s.title AS title,
              s.time_created AS createdAt, s.time_updated AS updatedAt,
              (SELECT count(*) FROM session_message m WHERE m.session_id = s.id AND m.type = 'user') AS userMessageCount
         FROM session_v2 s
        WHERE s.parent_id IS NULL AND s.time_archived IS NULL ${idFilter}
        ORDER BY s.time_updated DESC
        LIMIT ?`
    : `SELECT s.id AS id, s.directory AS directory, s.title AS title,
              s.time_created AS createdAt, s.time_updated AS updatedAt,
              NULL AS userMessageCount
         FROM session s
        WHERE s.parent_id IS NULL AND s.time_archived IS NULL ${idFilter}
        ORDER BY s.time_updated DESC
        LIMIT ?`;
  const rows = store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const out: OpenCodeStoreSessionRow[] = [];
  for (const row of rows) {
    const id = textOrNull(row.id);
    if (!id) continue;
    out.push({
      id,
      directory: textOrNull(row.directory),
      title: textOrNull(row.title),
      createdAt: numberOrNull(row.createdAt),
      updatedAt: numberOrNull(row.updatedAt),
      userMessageCount: numberOrNull(row.userMessageCount),
    });
  }
  return out;
}

/**
 * A session's messages, oldest first, newest kept when the byte budget runs
 * out: a long session with screenshots stores tens of MB, and the recent end is
 * what an import continues from.
 */
export function readOpenCodeStoreMessages(
  store: OpenCodeStoreHandle,
  args: { sessionId: string; maxBytes: number },
): { messages: OpenCodeStoreMessageRow[]; truncated: boolean } {
  const messages: OpenCodeStoreMessageRow[] = [];
  let bytes = 0;
  let truncated = false;
  if (store.schema === "v2") {
    // Newest first, a page at a time, so a huge session is never loaded whole.
    const page = store.db.prepare(`
      SELECT id AS id, type AS type, seq AS seq, time_created AS createdAt, data AS data
        FROM session_message
       WHERE session_id = ? AND seq < ?
       ORDER BY seq DESC
       LIMIT ${V2_PAGE_ROWS}
    `);
    let beforeSeq = Number.MAX_SAFE_INTEGER;
    pages: for (;;) {
      const rows = page.all(args.sessionId, beforeSeq) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const seq = numberOrNull(row.seq);
        if (seq != null) beforeSeq = Math.min(beforeSeq, seq);
        const id = textOrNull(row.id);
        const data = typeof row.data === "string" ? row.data : null;
        if (!id || data == null) continue;
        bytes += data.length;
        if (bytes > args.maxBytes && messages.length) {
          truncated = true;
          break pages;
        }
        messages.push({ id, type: textOrNull(row.type) ?? "unknown", createdAt: numberOrNull(row.createdAt), data });
      }
      if (rows.length < V2_PAGE_ROWS) break;
    }
    return { messages: messages.reverse(), truncated };
  }
  const messageRows = store.db.prepare(`
    SELECT id AS id, time_created AS createdAt, data AS data
      FROM message
     WHERE session_id = ?
     ORDER BY time_created DESC, id DESC
  `).all(args.sessionId) as Array<Record<string, unknown>>;
  const partsOf = store.db.prepare(`
    SELECT id AS id, data AS data
      FROM part
     WHERE message_id = ?
     ORDER BY id ASC
  `);
  for (const row of messageRows) {
    const id = textOrNull(row.id);
    const data = typeof row.data === "string" ? row.data : null;
    if (!id || data == null) continue;
    const parts: Array<{ id: string; data: string }> = [];
    let messageBytes = data.length;
    for (const part of partsOf.all(id) as Array<Record<string, unknown>>) {
      const partId = textOrNull(part.id);
      const partData = typeof part.data === "string" ? part.data : null;
      if (!partId || partData == null) continue;
      messageBytes += partData.length;
      parts.push({ id: partId, data: partData });
    }
    bytes += messageBytes;
    if (bytes > args.maxBytes && messages.length) {
      truncated = true;
      break;
    }
    messages.push({ id, type: "message", createdAt: numberOrNull(row.createdAt), data, parts });
  }
  return { messages: messages.reverse(), truncated };
}
