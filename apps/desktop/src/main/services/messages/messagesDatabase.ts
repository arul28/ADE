/**
 * Read-only access to the macOS Messages database (`~/Library/Messages/chat.db`).
 *
 * Messages keeps every conversation in one SQLite database owned by
 * `~/Library/Messages`, a directory TCC guards. ADE can read it only after the
 * person grants Full Disk Access, and the grant belongs to the process that
 * opens the file — which is why the worker entry opens this from a child of
 * ADE.app rather than from a terminal.
 *
 * The database is opened `readOnly: true` and never written. The `message.text`
 * column is NULL for rich messages, so the plain text is recovered from
 * `attributedBody` before a record is returned.
 *
 * Privacy: a {@link MessageRecord} carries the body of a text, the sender's
 * phone number or email, and attachment paths. Nothing here logs; callers must
 * keep those values out of logs, telemetry and error messages too.
 *
 * @module messages/messagesDatabase
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { decodeAttributedBody } from "./attributedBody";

/** Apple's reference date, 2001-01-01T00:00:00Z, in UNIX milliseconds. */
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

/**
 * Values at or above this are nanoseconds since the Apple epoch. Modern macOS
 * writes nanoseconds (~8e17 in 2026); very old databases wrote seconds (~8e8).
 * No plausible seconds value reaches 1e12 (that would be the year 33658), and
 * no plausible nanosecond value falls below it.
 */
const NANOSECOND_THRESHOLD = 1e12;

const DEFAULT_MESSAGE_LIMIT = 50;
const DEFAULT_CHAT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Only `chat.style = 43` is a group conversation. */
const GROUP_CHAT_STYLE = 43;

export type MessageService = "iMessage" | "SMS" | "RCS" | "other";

export type MessageAttachment = {
  /** Display name Messages shows: the transfer name, else the file's basename. */
  readonly name: string;
  readonly mimeType: string | null;
  /** Absolute path with `~` expanded, or "" when Messages stored no filename. */
  readonly path: string;
  readonly bytes: number | null;
};

export type MessageRecord = {
  readonly rowId: number;
  readonly guid: string;
  /** Plain text; decoded from `attributedBody` when `message.text` was NULL. */
  readonly text: string;
  readonly fromMe: boolean;
  /** Sender's phone number or email; null for a message this Mac sent. */
  readonly handle: string | null;
  readonly chatGuid: string | null;
  /** `chat.display_name`, or null for a one-to-one conversation. */
  readonly chatName: string | null;
  readonly isGroup: boolean;
  /** ISO 8601 timestamp, or null when the database stored no usable date. */
  readonly date: string | null;
  readonly service: MessageService;
  readonly hasAttachments: boolean;
  readonly attachments: readonly MessageAttachment[];
};

export type ChatRecord = {
  readonly chatGuid: string;
  readonly chatName: string | null;
  readonly isGroup: boolean;
  /** ISO 8601 timestamp of the newest message, or null when there is none. */
  readonly lastMessageAt: string | null;
  readonly participants: readonly string[];
};

export type ReadRecentMessagesOptions = {
  /** Only messages at or after this UNIX-epoch millisecond timestamp. */
  readonly sinceMs?: number;
  /** 1-500, default 50. */
  readonly limit?: number;
  /** Phone number or email. Matched after {@link normalizeHandle}. */
  readonly handle?: string;
  /** Restrict to one conversation. */
  readonly chatGuid?: string;
  /** Include messages this Mac sent. Defaults to false. */
  readonly fromMeToo?: boolean;
};

export type ListChatsOptions = {
  /** 1-500, default 50. */
  readonly limit?: number;
};

export type MessagesAccessFailure = {
  readonly ok: false;
  readonly code: "needs_full_disk_access" | "no_database" | "unsupported_platform" | "error";
  readonly message: string;
};

export type MessagesAccessResult = { readonly ok: true; readonly path: string } | MessagesAccessFailure;

type SqliteDatabase = DatabaseSyncType;

type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: { allowExtension?: boolean; readOnly?: boolean },
) => SqliteDatabase;

type NodeSqlite = { DatabaseSync: DatabaseSyncConstructor };

let nodeSqlite: NodeSqlite | null = null;

/**
 * Loads `node:sqlite` on first use.
 *
 * A static import is rewritten by the desktop test bundler into a missing
 * module URL, and the modules that load with the app shell must import cleanly
 * on Windows and Linux where the database can never be opened. A runtime
 * require keeps both properties.
 */
function loadNodeSqlite(): NodeSqlite {
  if (!nodeSqlite) {
    const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
    nodeSqlite = require("node:sqlite") as NodeSqlite;
  }
  return nodeSqlite;
}

/** `~/Library/Messages/chat.db` for the current user. */
export function defaultMessagesDatabasePath(): string {
  return path.join(os.homedir(), "Library", "Messages", "chat.db");
}

/**
 * Opens the Messages database read-only. Throws when the file is unreadable;
 * {@link checkMessagesDatabaseAccess} turns that into a typed answer.
 */
export function openMessagesDatabase(dbPath: string = defaultMessagesDatabasePath()): SqliteDatabase {
  const { DatabaseSync } = loadNodeSqlite();
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Whether a filesystem error is TCC refusing access (macOS uses EPERM). */
export function isFullDiskAccessDenial(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EPERM";
}

/**
 * Probes whether the Messages database can be opened and queried.
 *
 * `stat` and `open` are separate on purpose: TCC refuses the `open` with EPERM
 * even when the directory listing already succeeded, so the probe mirrors
 * Safari's `safariAccessDenied`. A missing file is `no_database` — the person
 * has never signed into Messages on this Mac.
 */
export function checkMessagesDatabaseAccess(
  dbPath: string = defaultMessagesDatabasePath(),
): MessagesAccessResult {
  if (process.platform !== "darwin") {
    return { ok: false, code: "unsupported_platform", message: "Messages is available on Macs only." };
  }
  try {
    fs.statSync(dbPath);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      return { ok: false, code: "no_database", message: "Messages has no database on this Mac yet." };
    }
    return isFullDiskAccessDenial(error)
      ? { ok: false, code: "needs_full_disk_access", message: "ADE needs Full Disk Access to read Messages." }
      : { ok: false, code: "error", message: "Messages' database could not be reached." };
  }

  let handle: number | null = null;
  try {
    handle = fs.openSync(dbPath, "r");
  } catch (error) {
    return isFullDiskAccessDenial(error)
      ? { ok: false, code: "needs_full_disk_access", message: "ADE needs Full Disk Access to read Messages." }
      : { ok: false, code: "error", message: "Messages' database could not be opened." };
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Closing a probe handle cannot fail in a way that matters.
      }
    }
  }

  let db: SqliteDatabase | null = null;
  try {
    db = openMessagesDatabase(dbPath);
    db.prepare("SELECT 1 AS present FROM message LIMIT 1").get();
    return { ok: true, path: dbPath };
  } catch (error) {
    // The file itself opened above, so this is a SQLite/schema failure, not a
    // missing TCC grant. Say "error" rather than sending the person to a
    // permission they already have.
    return {
      ok: false,
      code: "error",
      message: isFullDiskAccessDenial(error)
        ? "ADE needs Full Disk Access to read Messages."
        : "Messages' database could not be read.",
    };
  } finally {
    try {
      db?.close();
    } catch {
      // A read-only handle closing late cannot lose anything.
    }
  }
}

/**
 * Compares phone numbers by their last 10 digits (so +1 and a bare area code
 * match) and emails case-insensitively. Returns "" for an unusable input.
 */
export function normalizeHandle(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") return trimmed.toLowerCase();
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Whether two phones/emails refer to the same person. */
export function handlesMatch(left: string, right: string): boolean {
  const normalized = normalizeHandle(left);
  return normalized !== "" && normalized === normalizeHandle(right);
}

/**
 * Converts an Apple Messages date to ISO 8601.
 *
 * Accepts the units the platform has used: nanoseconds since 2001-01-01 on
 * current macOS, seconds on very old databases. Values outside a plausible
 * Messages lifetime return null rather than a year-33658 timestamp.
 */
export function appleMessageDateToIso(
  value: number | bigint | string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const appleMillis = raw >= NANOSECOND_THRESHOLD ? raw / 1_000_000 : raw * 1_000;
  return appleMillisToIso(appleMillis);
}

/** Converts milliseconds since the Apple epoch to ISO 8601, with sanity bounds. */
function appleMillisToIso(appleMillis: number): string | null {
  if (!Number.isFinite(appleMillis) || appleMillis <= 0) return null;
  const date = new Date(APPLE_EPOCH_OFFSET_MS + appleMillis);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(year) || year < 2001 || year > 2200) return null;
  return date.toISOString();
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

/** SQL that normalises the two Apple timestamp units to milliseconds since 2001. */
function appleMillisSql(column: string): string {
  return `CAST(CASE WHEN ${column} >= ${NANOSECOND_THRESHOLD} THEN ${column} / 1000000 ELSE ${column} * 1000 END AS INTEGER)`;
}

function mapService(value: unknown): MessageService {
  return value === "iMessage" || value === "SMS" || value === "RCS" ? value : "other";
}

function expandTilde(filePath: string): string {
  if (filePath === "~") return os.homedir();
  return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function textForRow(row: { text: unknown; attributedBody: unknown }): string {
  if (typeof row.text === "string" && row.text !== "") return row.text;
  const decoded = decodeAttributedBody(
    row.attributedBody instanceof Uint8Array ? row.attributedBody : null,
  );
  if (decoded !== null) return decoded;
  return typeof row.text === "string" ? row.text : "";
}

/**
 * Resolves the handle rows that match `handle` after normalization. Reads the
 * whole handle table once: it holds one row per person this Mac has talked to,
 * and no SQL expression reproduces "last 10 digits" correctly.
 */
function resolveHandleIds(db: SqliteDatabase, handle: string): number[] {
  const target = normalizeHandle(handle);
  if (target === "") return [];
  const rows = db.prepare("SELECT ROWID AS rowId, id AS handle FROM handle").all() as Array<{
    rowId: number;
    handle: unknown;
  }>;
  return rows
    .filter((row) => typeof row.handle === "string" && normalizeHandle(row.handle) === target)
    .map((row) => Number(row.rowId));
}

function resolveChatRowId(db: SqliteDatabase, chatGuid: string): number | null {
  const row = db.prepare("SELECT ROWID AS rowId FROM chat WHERE guid = ? LIMIT 1")
    .get(chatGuid) as { rowId?: number } | undefined;
  return typeof row?.rowId === "number" ? row.rowId : null;
}

type MessageRow = {
  rowId: number;
  guid: string | null;
  text: unknown;
  attributedBody: unknown;
  isFromMe: number | null;
  service: unknown;
  handleId: unknown;
  chatGuid: unknown;
  chatName: unknown;
  chatStyle: number | null;
  participantCount: number | null;
  attachmentCount: number | null;
  cacheHasAttachments: number | null;
  appleMillis: number | null;
};

function readAttachments(
  db: SqliteDatabase,
  messageIds: number[],
): Map<number, MessageAttachment[]> {
  const byMessage = new Map<number, MessageAttachment[]>();
  if (messageIds.length === 0) return byMessage;

  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT maj.message_id AS messageId,
           a.filename AS filename,
           a.mime_type AS mimeType,
           a.transfer_name AS transferName,
           a.total_bytes AS totalBytes
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id IN (${placeholders})
    ORDER BY maj.message_id, a.ROWID
  `).all(...messageIds) as Array<{
    messageId: number;
    filename: unknown;
    mimeType: unknown;
    transferName: unknown;
    totalBytes: unknown;
  }>;

  for (const row of rows) {
    const messageId = Number(row.messageId);
    const filePath = typeof row.filename === "string" ? expandTilde(row.filename) : "";
    const name = typeof row.transferName === "string" && row.transferName !== ""
      ? row.transferName
      : path.basename(filePath);
    const bytes = typeof row.totalBytes === "number" && Number.isFinite(row.totalBytes)
      ? row.totalBytes
      : null;
    const attachment: MessageAttachment = {
      name,
      mimeType: typeof row.mimeType === "string" ? row.mimeType : null,
      path: filePath,
      bytes,
    };
    const existing = byMessage.get(messageId);
    if (existing) existing.push(attachment);
    else byMessage.set(messageId, [attachment]);
  }
  return byMessage;
}

/**
 * Reads the newest messages, newest first.
 *
 * Defaults to incoming messages only (`fromMeToo: false`): an agent looking for
 * a sign-in code wants what a sender wrote, not what this Mac sent. Pass
 * `fromMeToo: true` for a conversation-style read.
 */
export function readRecentMessages(
  db: SqliteDatabase,
  options: ReadRecentMessagesOptions = {},
): MessageRecord[] {
  const limit = clampLimit(options.limit, DEFAULT_MESSAGE_LIMIT);
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.fromMeToo !== true) where.push("m.is_from_me = 0");

  if (typeof options.sinceMs === "number" && Number.isFinite(options.sinceMs) && options.sinceMs > 0) {
    where.push(`${appleMillisSql("m.date")} >= ?`);
    params.push(Math.round(options.sinceMs) - APPLE_EPOCH_OFFSET_MS);
  }

  if (typeof options.chatGuid === "string" && options.chatGuid !== "") {
    const chatRowId = resolveChatRowId(db, options.chatGuid);
    if (chatRowId === null) return [];
    where.push("m.ROWID IN (SELECT message_id FROM chat_message_join WHERE chat_id = ?)");
    params.push(chatRowId);
  }

  if (typeof options.handle === "string" && options.handle.trim() !== "") {
    const handleIds = resolveHandleIds(db, options.handle);
    if (handleIds.length === 0) return [];
    where.push(`h.ROWID IN (${handleIds.map(() => "?").join(", ")})`);
    params.push(...handleIds);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT m.ROWID AS rowId,
           m.guid AS guid,
           m.text AS text,
           m.attributedBody AS attributedBody,
           m.is_from_me AS isFromMe,
           m.service AS service,
           m.cache_has_attachments AS cacheHasAttachments,
           ${appleMillisSql("m.date")} AS appleMillis,
           h.id AS handleId,
           c.guid AS chatGuid,
           c.display_name AS chatName,
           c.style AS chatStyle,
           (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participantCount,
           (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) AS attachmentCount
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    ${whereSql}
    GROUP BY m.ROWID
    ORDER BY m.date DESC, m.ROWID DESC
    LIMIT ?
  `).all(...params, limit) as MessageRow[];

  const attachments = readAttachments(db, rows.map((row) => Number(row.rowId)));
  return rows.map((row) => {
    const rowId = Number(row.rowId);
    const participantCount = Number(row.participantCount ?? 0);
    const attachmentCount = Number(row.attachmentCount ?? 0);
    return {
      rowId,
      guid: typeof row.guid === "string" ? row.guid : "",
      text: textForRow(row),
      fromMe: row.isFromMe === 1,
      handle: typeof row.handleId === "string" ? row.handleId : null,
      chatGuid: typeof row.chatGuid === "string" ? row.chatGuid : null,
      chatName: typeof row.chatName === "string" && row.chatName !== "" ? row.chatName : null,
      isGroup: row.chatStyle === GROUP_CHAT_STYLE || participantCount > 1,
      date: typeof row.appleMillis === "number" ? appleMillisToIso(row.appleMillis) : null,
      service: mapService(row.service),
      hasAttachments: attachmentCount > 0 || row.cacheHasAttachments === 1,
      attachments: attachments.get(rowId) ?? [],
    } satisfies MessageRecord;
  });
}

/**
 * Lists recent conversations, newest activity first, with the stored
 * participants. The list is the entry point for "which chat?" before a
 * `readRecentMessages({ chatGuid })` call.
 */
export function listChats(db: SqliteDatabase, options: ListChatsOptions = {}): ChatRecord[] {
  const limit = clampLimit(options.limit, DEFAULT_CHAT_LIMIT);
  const rows = db.prepare(`
    SELECT c.ROWID AS rowId,
           c.guid AS guid,
           c.display_name AS chatName,
           c.style AS chatStyle,
           (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participantCount,
           ${appleMillisSql("MAX(m.date)")} AS appleMillis
    FROM chat c
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    LEFT JOIN message m ON m.ROWID = cmj.message_id
    GROUP BY c.ROWID
    ORDER BY MAX(m.date) IS NULL, MAX(m.date) DESC
    LIMIT ?
  `).all(limit) as Array<{
    rowId: number;
    guid: unknown;
    chatName: unknown;
    chatStyle: number | null;
    participantCount: number | null;
    appleMillis: number | null;
  }>;

  const chatIds = rows.map((row) => Number(row.rowId));
  const participantsByChat = new Map<number, string[]>();
  if (chatIds.length > 0) {
    const placeholders = chatIds.map(() => "?").join(", ");
    const participantRows = db.prepare(`
      SELECT chj.chat_id AS chatId, h.id AS handle
      FROM chat_handle_join chj
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id IN (${placeholders})
      ORDER BY chj.chat_id, h.ROWID
    `).all(...chatIds) as Array<{ chatId: number; handle: unknown }>;
    for (const row of participantRows) {
      if (typeof row.handle !== "string") continue;
      const chatId = Number(row.chatId);
      const existing = participantsByChat.get(chatId);
      if (existing) existing.push(row.handle);
      else participantsByChat.set(chatId, [row.handle]);
    }
  }

  return rows
    .filter((row) => typeof row.guid === "string")
    .map((row) => {
      const rowId = Number(row.rowId);
      return {
        chatGuid: row.guid as string,
        chatName: typeof row.chatName === "string" && row.chatName !== "" ? row.chatName : null,
        isGroup:
          row.chatStyle === GROUP_CHAT_STYLE
          || Number(row.participantCount ?? 0) > 1,
        lastMessageAt:
          typeof row.appleMillis === "number" ? appleMillisToIso(row.appleMillis) : null,
        participants: participantsByChat.get(rowId) ?? [],
      } satisfies ChatRecord;
    });
}
