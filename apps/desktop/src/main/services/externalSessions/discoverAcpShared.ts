import path from "node:path";
import type { ExternalSessionProvider } from "../../../shared/types/externalSessions";
import {
  asRecord,
  countExternalSessionUserMessages,
  firstUserTextFromRecords,
  readFilePrefix,
  readJsonlRecords,
  readJsonlRecordsFromSuffix,
  recentExternalSessionMessagesFromRecords,
  recordWithFile,
  safeParseJson,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryRecord,
  EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER,
  JSONL_SCAN_BYTE_LIMIT,
} from "./discoveryUtils";

/**
 * Shared plumbing for the ACP-provider discoverers (Qwen, Kimi, Grok, Copilot).
 *
 * Each of those CLIs writes its own record shape, so every discoverer first
 * maps its records to one neutral form — `{ type, timestamp, message: { role,
 * content } }` — and then hands that to the same shared helpers every other
 * provider uses for the preview, the sampled messages, and the prompt count.
 * The mapping is the only provider-specific part; what counts as a user turn,
 * how transport markup is stripped, and how text is clipped stay in one place.
 */

export type NeutralSessionRecord = {
  type: "user" | "assistant";
  timestamp: number | string | null;
  message: { role: "user" | "assistant"; content: string };
};

export function neutralRecord(
  role: "user" | "assistant",
  text: string | null | undefined,
  timestamp: number | string | null | undefined,
): NeutralSessionRecord | null {
  if (typeof text !== "string" || !text.trim()) return null;
  return { type: role, timestamp: timestamp ?? null, message: { role, content: text } };
}

/**
 * Files at or under this size are read whole, so the prompt count is exact.
 * Larger files get a bounded head and tail, and a null count — the same
 * contract as `countJsonlUserMessagesCheap` in the other discoverers.
 */
const WHOLE_FILE_MAX_BYTES = 768 * 1024;
const HEAD_MAX_LINES = 20_000;

export type JsonlWindow = {
  head: Record<string, unknown>[];
  tail: Record<string, unknown>[];
  /** Every record, when the file was small enough to read whole. */
  all: Record<string, unknown>[] | null;
};

function parseJsonlText(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => asRecord(safeParseJson(line)))
    .filter((record): record is Record<string, unknown> => record != null);
}

/** A bounded read of a JSONL history: whole when small, head + tail when not. */
export function readJsonlWindow(filePath: string, size: number): JsonlWindow {
  if (size <= WHOLE_FILE_MAX_BYTES) {
    const text = size > 0 ? readFilePrefix(filePath, size) : "";
    const all = text ? parseJsonlText(text) : [];
    return { head: all, tail: all, all };
  }
  const toRecords = (rows: unknown[]) => rows
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record != null);
  return {
    head: toRecords(readJsonlRecords(filePath, HEAD_MAX_LINES)),
    tail: toRecords(readJsonlRecordsFromSuffix(filePath, JSONL_SCAN_BYTE_LIMIT)),
    all: null,
  };
}

/** Small JSON documents (summary.json, state.json, workspaces.json). */
export function readSmallJson(filePath: string, maxBytes = 256 * 1024): Record<string, unknown> | null {
  const text = readFilePrefix(filePath, maxBytes);
  return text ? asRecord(safeParseJson(text)) : null;
}

/**
 * ADE's own ACP chats open with the ADE guidance block. Some providers wrap the
 * prompt in `<user_query>` first, so the check looks inside that wrapper too.
 */
export function startsWithAdeGuidance(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^\s*(?:<user_query>\s*)?## ADE\b/u.test(text);
}

/** Expand a leading `~` the way the provider CLIs do for their own env overrides. */
export function expandHomePath(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir, value.slice(2));
  return path.resolve(value);
}

export type AcpRecordSummary = {
  preview: string | null;
  messages: ReturnType<typeof recentExternalSessionMessagesFromRecords>;
  /** Exact when the whole history was read, else null. */
  messageCount: number | null;
  /** True when at least one real prompt was seen in the records read. */
  hasPrompt: boolean;
};

/** Preview, sampled messages, and prompt count from neutral records. */
export function summarizeNeutralRecords(
  provider: ExternalSessionProvider,
  window: { head: NeutralSessionRecord[]; tail: NeutralSessionRecord[]; all: NeutralSessionRecord[] | null },
): AcpRecordSummary {
  const messageCount = window.all ? countExternalSessionUserMessages(window.all, provider) : null;
  const hasPrompt = messageCount != null
    ? messageCount > 0
    : countExternalSessionUserMessages(window.head, provider) > 0
      || countExternalSessionUserMessages(window.tail, provider) > 0;
  return {
    preview: firstUserTextFromRecords(window.head),
    messages: recentExternalSessionMessagesFromRecords(window.tail),
    messageCount,
    hasPrompt,
  };
}

/** `recordWithFile` plus the on-disk size of the history file. */
export function acpDiscoveryRecord(
  args: Parameters<typeof recordWithFile>[0] & { sizeBytes: number | null },
): ExternalSessionDiscoveryRecord {
  const { sizeBytes, ...rest } = args;
  return { ...recordWithFile(rest), sizeBytes };
}

/**
 * Read candidates newest-first until `limit` sessions survive.
 *
 * These stores are dominated by sessions the importer drops — ADE's own ACP
 * chats, subagents, sessions opened and closed without a prompt — so a fixed
 * `limit × 2` read budget could be spent entirely on rejects. Reading stops as
 * soon as enough rows exist, and never opens more than the hard cap. An exact
 * lookup reads every candidate: the session asked for may be older than any
 * recent-session budget.
 */
export function collectNewestSessions<T extends { mtimeMs: number }>(args: {
  candidates: T[];
  limit: number;
  lookupId: string | null;
  read: (candidate: T) => ExternalSessionDiscoveryRecord | null;
}): ExternalSessionDiscoveryRecord[] {
  const ordered = args.candidates.slice().sort((left, right) => right.mtimeMs - left.mtimeMs);
  const readCap = args.lookupId
    ? ordered.length
    : Math.max(args.limit * EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER, ACP_MIN_READ_CAP);
  const recordsById = new Map<string, ExternalSessionDiscoveryRecord>();
  for (const candidate of ordered.slice(0, readCap)) {
    const record = args.read(candidate);
    if (!record || recordsById.has(record.id)) continue;
    if (args.lookupId && record.id !== args.lookupId) continue;
    recordsById.set(record.id, record);
    if (!args.lookupId && recordsById.size >= args.limit) break;
  }
  return sortDiscoveryRecords(Array.from(recordsById.values()), args.limit);
}

const ACP_MIN_READ_CAP = 200;

/** Rejects ids that would escape the directory they are joined onto. */
export function safeLookupId(sessionId: string | null | undefined): string | null | false {
  const id = sessionId?.trim() || null;
  if (!id) return null;
  return id === path.basename(id) && id !== "." && id !== ".." ? id : false;
}

export function compact<T>(values: Array<T | null | undefined>): T[] {
  return values.filter((value): value is T => value != null);
}
