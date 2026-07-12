import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import type { AgentChatProvider } from "../../../shared/types/chat";
import { writeFileAtomic } from "../state/durableFile";

export type ThreadPointerLedgerEntry = {
  sessionId: string;
  provider: Exclude<AgentChatProvider, "unified">;
  pointer: string | null;
  prevPointer: string | null;
  reason: string;
  at: string;
};

const THREAD_POINTER_LEDGER_FILENAME = "thread-pointers.jsonl";
const THREAD_POINTER_LEDGER_MAX_BYTES = 64 * 1024;

export function isThreadPointerLedgerEntry(value: unknown): value is ThreadPointerLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ThreadPointerLedgerEntry>;
  return typeof record.sessionId === "string"
    && record.sessionId.trim().length > 0
    && (record.provider === "codex"
      || record.provider === "claude"
      || record.provider === "opencode"
      || record.provider === "cursor"
      || record.provider === "droid")
    && (record.pointer === null || typeof record.pointer === "string")
    && (record.prevPointer === null || typeof record.prevPointer === "string")
    && typeof record.reason === "string"
    && record.reason.trim().length > 0
    && typeof record.at === "string"
    && record.at.trim().length > 0;
}

export function parseThreadPointerLedger(raw: string): ThreadPointerLedgerEntry[] {
  const entries: ThreadPointerLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().length) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isThreadPointerLedgerEntry(parsed)) entries.push(parsed);
    } catch {
      // A torn tail only loses that malformed entry.
    }
  }
  return entries;
}

export function readThreadPointerLedger(chatSessionsDir: string): Map<string, ThreadPointerLedgerEntry> {
  const newestBySession = new Map<string, ThreadPointerLedgerEntry>();
  try {
    const raw = fs.readFileSync(path.join(chatSessionsDir, THREAD_POINTER_LEDGER_FILENAME), "utf8");
    for (const entry of parseThreadPointerLedger(raw)) {
      newestBySession.set(entry.sessionId, entry);
    }
  } catch {
    // Missing and unreadable ledgers are equivalent to an empty ledger.
  }
  return newestBySession;
}

export function recordThreadPointerChange(
  chatSessionsDir: string,
  entry: ThreadPointerLedgerEntry,
): void {
  const ledgerPath = path.join(chatSessionsDir, THREAD_POINTER_LEDGER_FILENAME);
  let separator = "";
  try {
    const stat = fs.statSync(ledgerPath);
    if (stat.size > 0) {
      const fd = fs.openSync(ledgerPath, "r");
      try {
        const lastByte = Buffer.allocUnsafe(1);
        fs.readSync(fd, lastByte, 0, 1, stat.size - 1);
        if (lastByte[0] !== 0x0a) separator = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // A missing ledger starts with the entry itself.
  }
  fs.appendFileSync(ledgerPath, `${separator}${JSON.stringify(entry)}\n`, "utf8");
  if (fs.statSync(ledgerPath).size <= THREAD_POINTER_LEDGER_MAX_BYTES) return;

  const newestBySession = new Map<string, ThreadPointerLedgerEntry>();
  for (const parsed of parseThreadPointerLedger(fs.readFileSync(ledgerPath, "utf8"))) {
    newestBySession.delete(parsed.sessionId);
    newestBySession.set(parsed.sessionId, parsed);
  }
  const newestFirst = [...newestBySession.values()].reverse();
  const retainedNewestFirst: ThreadPointerLedgerEntry[] = [];
  let retainedBytes = 0;
  for (const parsed of newestFirst) {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(parsed)}\n`, "utf8");
    if (retainedNewestFirst.length > 0 && retainedBytes + lineBytes > THREAD_POINTER_LEDGER_MAX_BYTES) continue;
    retainedNewestFirst.push(parsed);
    retainedBytes += lineBytes;
  }
  const compacted = retainedNewestFirst
    .reverse()
    .map((parsed) => JSON.stringify(parsed))
    .join("\n");
  writeFileAtomic(ledgerPath, compacted.length ? `${compacted}\n` : "");
}
