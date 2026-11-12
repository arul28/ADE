/**
 * Read-only access to agy's own session log.
 *
 * Every agy conversation is a SQLite file,
 * `~/.gemini/antigravity-cli/conversations/<conversationId>.db`, with a
 * `steps` table (`idx`, `step_type`, `step_payload`). A payload is a protobuf
 * message (exa.cortex_pb trajectory steps). Only length-delimited fields are
 * read here, and only the ones verified on agy 1.5.6 (Windows, 2026-11-12):
 *
 * | step_type | meaning | fields read |
 * |---|---|---|
 * | 14 | the user's message | 19.2 text |
 * | 15 | the agent's reply | 20.1 text, 20.3 thinking, 20.7 tool calls (1 id, 2 name, 3 args JSON) |
 * | 17 | an error (see `antigravityTurnOutcome.ts`) | the payload's text |
 * | 101 | a message from another conversation (a subagent's result) | 114.2.1 title, 114.2.10.1 content, 114.4.3 sender id |
 * | any other | a tool's step | 5.4 tool call (1 id, 2 name, 3 args JSON), 140.2.1 result text |
 *
 * A step's `status` column (1.5.6): 3 done, 6 cancelled, 7 failed or denied,
 * 9 waiting for the user's approval; anything else is still running.
 *
 * A reply's or tool's step has its time at 5.6 (1 seconds). A tool's result
 * text opens with a "Created At: …" and a "Completed At: …" line, which are
 * dropped.
 *
 * The conversation's own metadata is `trajectory_metadata_blob.data`: 1.1 the
 * workspace as a `file://` URL (7 when 1 is missing), 2 the creation time
 * (1 seconds), and, for a conversation an ACP client opened with a system
 * prompt, an `acp_system_prompt` entry (1 the key, 2 the text). A subagent's
 * conversation starts with a `101` message from its parent.
 *
 * The decoder never throws: a payload it cannot read is `{ kind: "other" }`.
 * A future agy that renumbers a field makes the reader see less, never
 * crash; the pin keeps the format fixed between upgrades.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { hasTable, openReadOnlyDatabase } from "../../../projects/readOnlySqlite";
import { antigravityCliDir } from "../../../ai/antigravityAuth";

const CONVERSATION_ID = /^[\w-]+$/;
/** One step's payload is read up to this many bytes. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
const TEXT_LIMIT = 32_000;

export type AntigravityToolCall = { id: string; name: string; args: string };

export type AntigravityStep =
  | { kind: "user"; idx: number; text: string }
  | { kind: "reply"; idx: number; text: string; thinking: string; toolCalls: AntigravityToolCall[]; atMs: number | null }
  | { kind: "message"; idx: number; senderId: string | null; title: string; content: string }
  | { kind: "tool"; idx: number; toolCall: AntigravityToolCall; text: string; atMs: number | null; status: AntigravityStepStatus }
  | { kind: "error"; idx: number; text: string }
  | { kind: "other"; idx: number; type: number };

/** A tool step's state, from the `steps.status` column (values seen on 1.5.6). */
export type AntigravityStepStatus = "done" | "cancelled" | "failed" | "waiting" | "running";

function stepStatus(value: unknown): AntigravityStepStatus {
  switch (value) {
    case 3: return "done";
    case 6: return "cancelled";
    case 7: return "failed";
    case 9: return "waiting";
    default: return "running";
  }
}

export function antigravityConversationsDir(cliDir = antigravityCliDir()): string {
  return path.join(cliDir, "conversations");
}

export function antigravityConversationFile(conversationId: string, cliDir?: string): string | null {
  if (!CONVERSATION_ID.test(conversationId)) return null;
  return path.join(antigravityConversationsDir(cliDir), `${conversationId}.db`);
}

// ── protobuf: length-delimited fields only ──────────────────────────────────

/** A length-delimited field's bytes, or a varint's value. */
type Field = readonly [number, Uint8Array | number];

function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("truncated");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("overlong");
  };
  while (offset < bytes.length) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) out.push([field, varint()]);
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint();
      if (offset + length > bytes.length) throw new Error("truncated");
      out.push([field, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else throw new Error("wire");
  }
  return out;
}

function safeFields(bytes: Uint8Array | undefined): Field[] {
  if (!bytes) return [];
  try {
    return fields(bytes);
  } catch {
    return [];
  }
}

const decoder = new TextDecoder("utf-8");

function isBytes(value: Uint8Array | number): value is Uint8Array {
  return typeof value !== "number";
}

function sub(bytes: Uint8Array | undefined, ...path: number[]): Uint8Array | undefined {
  let current = bytes;
  for (const number of path) {
    const value = safeFields(current).find(([field]) => field === number)?.[1];
    current = value !== undefined && isBytes(value) ? value : undefined;
    if (!current) return undefined;
  }
  return current;
}

function all(bytes: Uint8Array | undefined, number: number): Uint8Array[] {
  return safeFields(bytes).flatMap(([field, value]) => (field === number && isBytes(value) ? [value] : []));
}

function varintAt(bytes: Uint8Array | undefined, number: number): number | null {
  const value = safeFields(bytes).find(([field]) => field === number)?.[1];
  return typeof value === "number" ? value : null;
}

function text(bytes: Uint8Array | undefined, ...path: number[]): string {
  const value = sub(bytes, ...path);
  if (!value) return "";
  const decoded = decoder.decode(value);
  return decoded.length > TEXT_LIMIT ? decoded.slice(0, TEXT_LIMIT) : decoded;
}

function toolCall(bytes: Uint8Array | undefined): AntigravityToolCall | null {
  if (!bytes) return null;
  const name = text(bytes, 2);
  if (!name) return null;
  return { id: text(bytes, 1), name, args: text(bytes, 3) };
}

/** A message from another conversation: a subagent's result, or a subagent's first step. */
const STEP_TYPE_MESSAGE = 101;
const RESULT_HEADER = /^Created At: [^\n]*\nCompleted At: [^\n]*\n/;

function stepTime(payload: Uint8Array): number | null {
  const seconds = varintAt(sub(payload, 5, 6), 1);
  return seconds && seconds > 0 ? seconds * 1000 : null;
}

export function parseAntigravityStep(
  idx: number,
  type: number,
  payload: Uint8Array | null,
  status: unknown = 3,
): AntigravityStep {
  if (!payload) return { kind: "other", idx, type };
  if (type === 14) {
    const body = text(payload, 19, 2);
    return body ? { kind: "user", idx, text: body } : { kind: "other", idx, type };
  }
  if (type === 15) {
    const reply = sub(payload, 20);
    const toolCalls = all(reply, 7).map(toolCall).filter((call): call is AntigravityToolCall => call !== null);
    return { kind: "reply", idx, text: text(reply, 1), thinking: text(reply, 3), toolCalls, atMs: stepTime(payload) };
  }
  if (type === 17) return { kind: "error", idx, text: decoder.decode(payload).slice(0, 4_000) };
  if (type === STEP_TYPE_MESSAGE) {
    const message = sub(payload, 114);
    if (!message) return { kind: "other", idx, type };
    const senderId = text(message, 4, 3) || null;
    return {
      kind: "message",
      idx,
      senderId,
      title: text(message, 2, 1),
      content: text(message, 2, 10, 1) || text(message, 4, 4),
    };
  }
  const call = toolCall(sub(payload, 5, 4));
  if (call) {
    // A denied or unanswered call has no result.
    const resultText = text(payload, 140, 2, 1).replace(RESULT_HEADER, "");
    return { kind: "tool", idx, toolCall: call, text: resultText, atMs: stepTime(payload), status: stepStatus(status) };
  }
  return { kind: "other", idx, type };
}

// ── reading ────────────────────────────────────────────────────────────────

type StepRow = { idx?: unknown; type?: unknown; status?: unknown; payload?: unknown };

function stepFromRow(row: StepRow): AntigravityStep[] {
  if (typeof row.idx !== "number" || typeof row.type !== "number") return [];
  return [parseAntigravityStep(row.idx, row.type, row.payload instanceof Uint8Array ? row.payload : null, row.status)];
}

function withLog<T>(file: string, read: (db: DatabaseSyncType) => T): T | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(file);
    db.exec("PRAGMA busy_timeout = 50");
    return hasTable(db, "steps") ? read(db) : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

/** The log's last step index, -1 for an empty log, `undefined` when unreadable. */
export function antigravityLastStepIndex(file: string): number | undefined {
  return withLog(file, (db) => {
    const index = db.prepare("SELECT max(idx) AS idx FROM steps").get<{ idx?: unknown }>()?.idx;
    return typeof index === "number" ? index : -1;
  });
}

/** Steps after `afterIdx`, oldest first, at most `limit`. */
export function readAntigravitySteps(file: string, afterIdx: number, limit = 200): AntigravityStep[] | undefined {
  return withLog(file, (db) => db
    .prepare(
      "SELECT idx, step_type AS type, status, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx LIMIT ?",
    )
    .all<StepRow>(MAX_PAYLOAD_BYTES, afterIdx, limit)
    .flatMap(stepFromRow));
}

/** The given steps as they are now: a running tool's later state. */
export function readAntigravityStepsAt(file: string, indexes: readonly number[]): AntigravityStep[] | undefined {
  const wanted = indexes.filter((index) => Number.isSafeInteger(index)).slice(0, 200);
  if (!wanted.length) return [];
  return withLog(file, (db) => db
    .prepare(
      `SELECT idx, step_type AS type, status, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx IN (${wanted.map(() => "?").join(", ")}) ORDER BY idx`,
    )
    .all<StepRow>(MAX_PAYLOAD_BYTES, ...wanted)
    .flatMap(stepFromRow));
}

/**
 * Steps before `beforeIdx` (all steps when null), newest first, at most
 * `limit`, each payload read up to `payloadBytes`. Paging backwards through a
 * whole conversation (the importer's preview and copy).
 */
export function readAntigravityStepsBefore(
  file: string,
  beforeIdx: number | null,
  limit: number,
  payloadBytes = MAX_PAYLOAD_BYTES,
): Array<{ step: AntigravityStep; bytes: number }> | undefined {
  return withLog(file, (db) => db
    .prepare(
      "SELECT idx, step_type AS type, status, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx < ? ORDER BY idx DESC LIMIT ?",
    )
    .all<StepRow>(
      Math.min(payloadBytes, MAX_PAYLOAD_BYTES),
      beforeIdx ?? Number.MAX_SAFE_INTEGER,
      limit,
    )
    .flatMap((row) => {
      if (typeof row.idx !== "number" || typeof row.type !== "number") return [];
      const payload = row.payload instanceof Uint8Array ? row.payload : null;
      return [{ step: parseAntigravityStep(row.idx, row.type, payload, row.status), bytes: payload?.byteLength ?? 0 }];
    }));
}

/** Conversation ids a launch step's result names (`"conversationId": "<id>"`). */
export function antigravityLaunchedConversationIds(resultText: string): string[] {
  const ids = new Set<string>();
  for (const match of resultText.matchAll(/"conversationId"\s*:\s*"([\w-]{8,64})"/g)) ids.add(match[1]!);
  return [...ids];
}

// ── whole conversations (the importer) ───────────────────────────────────────

const META_SEARCH_DEPTH = 8;
const SYSTEM_PROMPT_KEY = "acp_system_prompt";

export type AntigravityConversationMeta = {
  /** The folder the conversation ran in; null when agy recorded none. */
  workspace: string | null;
  createdAtMs: number | null;
  /** The system prompt an ACP client opened it with (ADE's guidance, for an ADE chat). */
  systemPrompt: string | null;
  /** True for a subagent's conversation: it opens with its parent's message. */
  isSubagent: boolean;
};

function workspacePath(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** The text of the first `{1: key, 2: text}` entry under `bytes`, searched depth-first. */
function keyedText(bytes: Uint8Array, key: string, depth: number): string | null {
  if (depth <= 0) return null;
  const entries = safeFields(bytes);
  if (text(bytes, 1) === key) {
    const value = text(bytes, 2);
    if (value) return value;
  }
  for (const [, value] of entries) {
    if (!isBytes(value) || value.length < key.length) continue;
    const found = keyedText(value, key, depth - 1);
    if (found) return found;
  }
  return null;
}

export function readAntigravityConversationMeta(file: string): AntigravityConversationMeta | undefined {
  return withLog(file, (db) => {
    const first = db.prepare("SELECT step_type AS type FROM steps ORDER BY idx LIMIT 1").get<{ type?: unknown }>();
    const isSubagent = first?.type === STEP_TYPE_MESSAGE;
    if (!hasTable(db, "trajectory_metadata_blob")) {
      return { workspace: null, createdAtMs: null, systemPrompt: null, isSubagent };
    }
    const row = db
      .prepare("SELECT substr(data, 1, ?) AS data FROM trajectory_metadata_blob LIMIT 1")
      .get<{ data?: unknown }>(MAX_PAYLOAD_BYTES);
    const blob = row?.data instanceof Uint8Array ? row.data : undefined;
    const seconds = varintAt(sub(blob, 2), 1);
    return {
      workspace: workspacePath(text(blob, 1, 1)) ?? workspacePath(text(blob, 7)),
      createdAtMs: seconds && seconds > 0 ? seconds * 1000 : null,
      systemPrompt: blob ? keyedText(blob, SYSTEM_PROMPT_KEY, META_SEARCH_DEPTH) : null,
      isSubagent,
    };
  });
}

export type AntigravityMessageWindow = {
  /** The user's messages in the whole conversation. */
  userMessageCount: number;
  /** The first messages and replies, oldest first. */
  head: Array<Extract<AntigravityStep, { kind: "user" | "reply" }>>;
  /** The last messages and replies, oldest first. */
  tail: Array<Extract<AntigravityStep, { kind: "user" | "reply" }>>;
};

const WINDOW_PAYLOAD_BYTES = 64 * 1024;

/** The user's messages and the agent's replies at both ends of a conversation, bounded. */
export function readAntigravityMessageWindow(
  file: string,
  size: { head: number; tail: number } = { head: 20, tail: 40 },
): AntigravityMessageWindow | undefined {
  return withLog(file, (db) => {
    const messages = (order: "ASC" | "DESC", limit: number) => db
      .prepare(
        `SELECT idx, step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx ${order} LIMIT ?`,
      )
      .all<{ idx?: unknown; type?: unknown; payload?: unknown }>(WINDOW_PAYLOAD_BYTES, limit)
      .flatMap((row) => {
        if (typeof row.idx !== "number" || typeof row.type !== "number") return [];
        const step = parseAntigravityStep(row.idx, row.type, row.payload instanceof Uint8Array ? row.payload : null);
        return step.kind === "user" || step.kind === "reply" ? [step] : [];
      });
    const count = db.prepare("SELECT count(*) AS count FROM steps WHERE step_type = 14").get<{ count?: unknown }>()?.count;
    return {
      userMessageCount: typeof count === "number" ? count : 0,
      head: messages("ASC", size.head),
      tail: messages("DESC", size.tail).reverse(),
    };
  });
}
