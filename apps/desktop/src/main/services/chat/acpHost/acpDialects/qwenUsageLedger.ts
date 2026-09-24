/**
 * Qwen Code's own usage ledger.
 *
 * Qwen appends one JSON line PER MODEL REQUEST to
 * `<runtime dir>/usage/token-usage-YYYY-MM.jsonl`, keyed by the LOCAL month
 * (verified on this Mac: a 2026-09-01T02:30Z row sits in the 2026-08 file,
 * `localMonth: "2026-08"`). The runtime dir is `QWEN_RUNTIME_DIR` when set,
 * otherwise the Qwen home (`QWEN_HOME`, default `~/.qwen`). A row is:
 *
 *   { schemaVersion, id, timestamp, localDate, localMonth, sessionId, model,
 *     authType, source, inputTokens, outputTokens, cachedTokens,
 *     thoughtsTokens, totalTokens, apiDurationMs }
 *
 * `sessionId` is the ACP session id. `source` is `"main"` for the chat's own
 * requests, or the name of a helper or subagent that ran on its behalf (for
 * example `managed-auto-memory-extractor`). `inputTokens` counts the cached
 * tokens (26272 input with 13824 cached); ADE reports the uncached share.
 *
 * The reader records each month file's size when the turn starts and reads
 * only what was appended after it, bounded to the last few megabytes. The file
 * is only ever read.
 */

import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import type {
  AcpLocalTurnUsage,
  AcpLocalUsageReader,
  AcpSubagentUsage,
  AcpUsageSample,
} from "../acpHostTypes";
import type { AgentChatUsageAccount } from "../../../../../shared/types";
import { addTokenCounts, readFiniteNumber, readTrimmedText } from "../acpTelemetryReaders";
import { qwenUsageDir } from "../../../shared/providerConfigHomes";
import { uncachedInputTokens } from "../../../usage/tokenSplit";
import { readQwenAccount } from "./acpAccounts";

/** `source` of the chat's own requests. */
export const QWEN_MAIN_USAGE_SOURCE = "main";
/** Never read more than this much of one month file for one turn. */
const QWEN_LEDGER_MAX_READ_BYTES = 4 * 1024 * 1024;

export type QwenUsageRow = {
  sessionId?: unknown;
  model?: unknown;
  authType?: unknown;
  source?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedTokens?: unknown;
  thoughtsTokens?: unknown;
  totalTokens?: unknown;
};

/** `YYYY-MM` in local time, the way Qwen names its month files. */
export function qwenLocalMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Qwen's month file name for `month` (`YYYY-MM`): `token-usage-YYYY-MM.jsonl`. */
export function qwenUsageFileName(month: string): string {
  return `token-usage-${month}.jsonl`;
}

/** Matches a Qwen month file name, `qwenUsageFileName`'s output. */
export const QWEN_USAGE_FILE_NAME_PATTERN = /^token-usage-\d{4}-\d{2}\.jsonl$/;

export function qwenUsageFile(dir: string, month: string): string {
  return path.join(dir, qwenUsageFileName(month));
}

/**
 * The token split of one ledger row: uncached input (the row's `inputTokens`
 * counts `cachedTokens`), cache reads, output, reasoning (`thoughtsTokens`,
 * already inside output), and Qwen's own total. Absent fields stay absent.
 * Pure, so the usage history scanner can read the month files with it.
 */
export function readQwenUsageRow(row: QwenUsageRow): AcpUsageSample {
  const input = readFiniteNumber(row.inputTokens);
  const cached = readFiniteNumber(row.cachedTokens);
  const output = readFiniteNumber(row.outputTokens);
  const thoughts = readFiniteNumber(row.thoughtsTokens);
  const total = readFiniteNumber(row.totalTokens);
  return {
    ...(input !== undefined ? { inputTokens: uncachedInputTokens(input, cached, undefined) } : {}),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(thoughts !== undefined ? { reasoningTokens: thoughts } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

/**
 * Fold one turn's rows for one session. Rows whose `source` is not `main`
 * are helper or subagent requests and come back grouped by `source`.
 */
export function summarizeQwenUsageRows(
  rows: readonly QwenUsageRow[],
  readAccount: (authType: string | null) => AgentChatUsageAccount,
): AcpLocalTurnUsage | null {
  if (!rows.length) return null;
  const isMain = (row: QwenUsageRow) => (readTrimmedText(row.source) ?? QWEN_MAIN_USAGE_SOURCE) === QWEN_MAIN_USAGE_SOURCE;
  const main = rows.filter(isMain);
  const usage: AcpUsageSample = {};
  for (const row of main) addTokenCounts(usage, readQwenUsageRow(row));

  const helpers = new Map<string, { usage: AcpSubagentUsage; model?: string }>();
  for (const row of rows) {
    const source = readTrimmedText(row.source) ?? QWEN_MAIN_USAGE_SOURCE;
    if (source === QWEN_MAIN_USAGE_SOURCE) continue;
    const entry = helpers.get(source) ?? { usage: {} };
    addTokenCounts(entry.usage, readQwenUsageRow(row));
    entry.model = readTrimmedText(row.model) ?? entry.model;
    helpers.set(source, entry);
  }

  const last = rows[rows.length - 1];
  const lastMain = main[main.length - 1];
  const servedModel = readTrimmedText(lastMain?.model);
  return {
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(main.length ? { requestCount: main.length } : {}),
    ...(servedModel ? { servedModel } : {}),
    account: readAccount(readTrimmedText(last?.authType) ?? null),
    subagents: [...helpers].map(([source, entry]) => ({
      agentId: source,
      label: source,
      ...(entry.model ? { model: entry.model } : {}),
      usage: entry.usage,
    })),
  };
}

function parseRows(textChunk: string, sessionId: string): QwenUsageRow[] {
  const rows: QwenUsageRow[] = [];
  for (const line of textChunk.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // A torn line: the tail of a truncated read, or a row still being written.
      continue;
    }
    if (row && typeof row === "object" && !Array.isArray(row) && (row as QwenUsageRow).sessionId === sessionId) {
      rows.push(row as QwenUsageRow);
    }
  }
  return rows;
}

/** Read what was appended to `filePath` after `fromOffset`, bounded. */
async function readAppended(filePath: string, fromOffset: number): Promise<string> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const { size } = await handle.stat();
    // A file smaller than the mark was rotated or rewritten; read it all.
    const from = size < fromOffset ? 0 : fromOffset;
    const start = Math.max(from, size - QWEN_LEDGER_MAX_READ_BYTES);
    if (size <= start) return "";
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const chunk = buffer.toString("utf8");
    // A bounded read that skipped bytes starts mid-line. Drop the fragment.
    return start > from ? chunk.slice(chunk.indexOf("\n") + 1) : chunk;
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Read one Qwen ACP session's rows from the ledger, one turn at a time.
 * Every failure resolves `null`; nothing here may break a turn.
 */
export function createQwenUsageLedger(args: {
  sessionId: string;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}): AcpLocalUsageReader {
  const now = args.now ?? (() => new Date());
  const dir = qwenUsageDir({ env: args.env });
  let mark: { month: string; offset: number } | null = null;

  return {
    beginTurn: () => {
      const month = qwenLocalMonth(now());
      mark = { month, offset: fileSize(qwenUsageFile(dir, month)) };
    },
    finishTurn: async () => {
      const turnMark = mark;
      mark = null;
      if (!turnMark) return null;
      try {
        const endMonth = qwenLocalMonth(now());
        const chunks = [await readAppended(qwenUsageFile(dir, turnMark.month), turnMark.offset)];
        // A turn that crossed midnight at a month end writes into two files.
        if (endMonth !== turnMark.month) chunks.push(await readAppended(qwenUsageFile(dir, endMonth), 0));
        const rows = chunks.flatMap((chunk) => parseRows(chunk, args.sessionId));
        return summarizeQwenUsageRows(rows, (authType) => readQwenAccount({ env: args.env, authType }));
      } catch {
        return null;
      }
    },
  };
}
