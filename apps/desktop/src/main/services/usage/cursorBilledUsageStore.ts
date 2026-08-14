import type { AdeDb } from "../state/kvDb";
import type { TokenEntry } from "./ledgers/localUsageLedgers";

export const CURSOR_BILLED_USAGE_KV_REF = "usage.cursor.billedEntries.v1";
const MAX_CURSOR_BILLED_ENTRIES = 5_000;

function isTokenEntry(value: unknown): value is TokenEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as TokenEntry;
  return typeof record.messageId === "string"
    && typeof record.model === "string"
    && typeof record.inputTokens === "number"
    && typeof record.outputTokens === "number"
    && typeof record.timestamp === "number";
}

export function listCursorBilledUsage(db: Pick<AdeDb, "getJson">): TokenEntry[] {
  const raw = db.getJson<unknown>(CURSOR_BILLED_USAGE_KV_REF);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTokenEntry);
}

export function recordCursorBilledUsage(
  db: Pick<AdeDb, "getJson" | "setJson">,
  entry: TokenEntry,
): void {
  const existing = listCursorBilledUsage(db);
  const next = [
    ...existing.filter((row) => row.messageId !== entry.messageId),
    entry,
  ].slice(-MAX_CURSOR_BILLED_ENTRIES);
  db.setJson(CURSOR_BILLED_USAGE_KV_REF, next);
}
