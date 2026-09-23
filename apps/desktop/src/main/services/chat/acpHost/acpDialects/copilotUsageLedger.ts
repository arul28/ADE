/**
 * Copilot's own usage ledger.
 *
 * Copilot CLI writes one row per model request to
 * `$COPILOT_HOME/session-store.db`, table `assistant_usage_events`, as the
 * request completes (verified live on 1.0.88). `session_id` is the ACP session
 * id. The row names the model Copilot actually picked (`mai-code-1.1-flash`
 * for a session with no model set), the AI units it cost (`total_nano_aiu`),
 * and the premium-request multiplier.
 *
 * ## Reading it without stalling the turn
 *
 * The store is in WAL mode (`PRAGMA journal_mode` answered `wal` on this Mac,
 * 2026-09-23, Copilot CLI 1.0.88), so a reader sees the last committed
 * snapshot and does not wait on Copilot's writer. `node:sqlite` is still
 * synchronous, so ADE keeps every read off the prompt path:
 *
 * - Nothing is read when the turn starts. The mark is a timestamp, and the
 *   turn's rows are the ones whose `created_at` is at or after it. Copilot
 *   writes `created_at` as ISO 8601 UTC with milliseconds
 *   (`2026-09-23T07:38:17.494Z`); the column's own default is SQLite's
 *   `datetime('now')`, so the query normalizes both shapes before comparing.
 *   Copilot writes a request's row before it answers the prompt, so every row
 *   of the previous turn is older than this turn's mark.
 * - The read runs on a later tick than the `finishTurn` call, so the caller's
 *   deadline is armed before any SQLite work starts.
 * - `busy_timeout` is 0. A store that is briefly locked (a checkpoint or WAL
 *   recovery) answers at once, and ADE retries on a timer a bounded number of
 *   times instead of letting SQLite spin inside the event loop.
 *
 * ADE opens the database READ-ONLY and never writes it.
 *
 * ## Units
 *
 * - `input_tokens` counts the cache reads AND writes (a row with 23112 input
 *   carries 23109 cache writes); the uncached share is what ADE reports.
 * - `premium_request` sums `request_multiplier` over rows the user initiated.
 *   A row with `initiator = "agent"` is Copilot continuing on its own after a
 *   tool call, and GitHub does not bill those as premium requests.
 * - `nano_aiu` sums `total_nano_aiu` over every row, subagents included.
 *
 * ## Compaction
 *
 * Copilot compacts with a model request of its own (`initiator =
 * "compaction"`, verified live on 1.0.88 with `/compact`) and sends no ACP
 * compaction update. That row's input is the context it summarised, which is
 * the compaction's `preTokens`. Its output is the summary alone, not the
 * context that follows, so there is no post figure. Its tokens are real spend
 * and stay in the turn totals.
 */

import type { DatabaseSync } from "node:sqlite";
import type { AgentChatPlanUsage } from "../../../../../shared/types";
import type {
  AcpLocalTurnUsage,
  AcpLocalUsageReader,
  AcpSubagentUsage,
  AcpUsageSample,
} from "../acpHostTypes";
import { addTokenCounts, readFiniteNumber, readTrimmedText } from "../acpTelemetryReaders";
import { openReadOnlyDatabase } from "../../../projects/readOnlySqlite";
import { copilotSessionStorePath } from "../../../shared/providerConfigHomes";
import { getErrorMessage } from "../../../shared/utils";
import { COPILOT_USAGE_TABLE } from "../../../usage/providerLedgerFormats";
import { uncachedInputTokens } from "../../../usage/tokenSplit";

/** Reads per turn end: the first, then retries while the store reports busy. */
const COPILOT_LEDGER_READ_ATTEMPTS = 3;
/** Pause between reads of a busy store. */
const COPILOT_LEDGER_RETRY_DELAY_MS = 40;
/** A turn with more requests than this is not a turn; stop reading. */
const COPILOT_LEDGER_ROW_LIMIT = 5_000;
/** SQLite primary result codes for a store another connection holds. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export type CopilotUsageRow = Record<string, unknown>;

export type CopilotLedgerIo = {
  openDatabase(dbPath: string): Pick<DatabaseSync, "prepare" | "exec" | "close">;
  delay(ms: number): Promise<void>;
  now(): Date;
};

const defaultIo: CopilotLedgerIo = {
  // Loads `node:sqlite` on the first open, not on import: this module loads
  // with every ACP dialect, and the usage ledger worker imports
  // `readCopilotUsageRow` from it.
  openDatabase: openReadOnlyDatabase,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

/**
 * The token split of one `assistant_usage_events` row: uncached input (the
 * row's `input_tokens` counts the cache reads and writes), output, cache
 * reads and writes, reasoning, and a total of the row's input plus output.
 * Absent columns stay absent. Pure, so the usage history scanner can read
 * `session-store.db` rows with it.
 */
export function readCopilotUsageRow(row: CopilotUsageRow): AcpUsageSample {
  const input = readFiniteNumber(row.input_tokens);
  const output = readFiniteNumber(row.output_tokens);
  const cacheRead = readFiniteNumber(row.cache_read_tokens);
  const cacheWrite = readFiniteNumber(row.cache_write_tokens);
  const reasoning = readFiniteNumber(row.reasoning_tokens);
  return {
    ...(input !== undefined ? { inputTokens: uncachedInputTokens(input, cacheRead, cacheWrite) } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(input !== undefined || output !== undefined ? { totalTokens: (input ?? 0) + (output ?? 0) } : {}),
  };
}

/**
 * Fold one turn's `assistant_usage_events` rows. Rows with an `agent_id`
 * belong to a subagent; the rest are the main agent's requests.
 */
export function summarizeCopilotUsageRows(rows: readonly CopilotUsageRow[]): AcpLocalTurnUsage | null {
  if (!rows.length) return null;
  const main = rows.filter((row) => !readTrimmedText(row.agent_id));
  const usage: AcpUsageSample = {};
  for (const row of main) addTokenCounts(usage, readCopilotUsageRow(row));

  let premium: number | undefined;
  let nanoAiu: number | undefined;
  for (const row of rows) {
    const multiplier = readFiniteNumber(row.request_multiplier);
    if (multiplier !== undefined && readTrimmedText(row.initiator) !== "agent") premium = (premium ?? 0) + multiplier;
    const aiu = readFiniteNumber(row.total_nano_aiu);
    if (aiu !== undefined) nanoAiu = (nanoAiu ?? 0) + aiu;
  }
  const planUsage: AgentChatPlanUsage[] = [
    ...(premium !== undefined ? [{ unit: "premium_request" as const, amount: premium }] : []),
    ...(nanoAiu !== undefined ? [{ unit: "nano_aiu" as const, amount: nanoAiu }] : []),
  ];

  const byAgent = new Map<string, { usage: AcpSubagentUsage; model?: string; parentToolCallId?: string }>();
  for (const row of rows) {
    const agentId = readTrimmedText(row.agent_id);
    if (!agentId) continue;
    const entry = byAgent.get(agentId) ?? { usage: {} };
    addTokenCounts(entry.usage, readCopilotUsageRow(row));
    entry.model = readTrimmedText(row.model) ?? entry.model;
    entry.parentToolCallId ??= readTrimmedText(row.parent_tool_call_id);
    byAgent.set(agentId, entry);
  }

  const compactions = main
    .filter((row) => readTrimmedText(row.initiator) === "compaction")
    .map((row) => {
      const preTokens = readFiniteNumber(row.input_tokens);
      return preTokens !== undefined ? { preTokens } : {};
    });
  // The model that answered the user, not the one that wrote a summary.
  const answering = main.filter((row) => readTrimmedText(row.initiator) !== "compaction");
  const lastMain = answering[answering.length - 1] ?? main[main.length - 1];
  const servedModel = readTrimmedText(lastMain?.model);
  return {
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(main.length ? { requestCount: main.length } : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(planUsage.length ? { planUsage } : {}),
    ...(compactions.length ? { compactions } : {}),
    subagents: [...byAgent].map(([agentId, entry]) => ({
      agentId,
      ...(entry.parentToolCallId ? { parentToolCallId: entry.parentToolCallId } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      usage: entry.usage,
    })),
  };
}

/** True when SQLite reported the store busy or locked, the one error worth a retry. */
function isBusyError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  // Extended result codes (SQLITE_BUSY_SNAPSHOT, ...) carry the primary in the low byte.
  if (typeof code === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(code & 0xff)) return true;
  return /database (?:table )?is locked|busy/i.test(getErrorMessage(error));
}

/**
 * Read one Copilot ACP session's rows from the ledger, one turn at a time.
 * Every failure resolves `null`; nothing here may break or stall a turn.
 */
export function createCopilotUsageLedger(args: {
  sessionId: string;
  env: NodeJS.ProcessEnv;
  io?: Partial<CopilotLedgerIo>;
}): AcpLocalUsageReader {
  const io: CopilotLedgerIo = { ...defaultIo, ...args.io };
  const dbPath = copilotSessionStorePath({ env: args.env });
  let turnStartedAt: string | null = null;

  const readTurnRows = (sinceIso: string): CopilotUsageRow[] => {
    const db = io.openDatabase(dbPath);
    try {
      // Never let SQLite wait on a lock inside the event loop; a busy store
      // answers at once and the caller retries on a timer.
      db.exec("PRAGMA busy_timeout = 0");
      return db.prepare(
        `select * from ${COPILOT_USAGE_TABLE}
          where session_id = ? and strftime('%Y-%m-%dT%H:%M:%fZ', created_at) >= ?
          order by id limit ${COPILOT_LEDGER_ROW_LIMIT}`,
      ).all<CopilotUsageRow>(args.sessionId, sinceIso);
    } finally {
      db.close();
    }
  };

  return {
    // A timestamp only. Nothing touches the store in front of the prompt.
    beginTurn: () => {
      turnStartedAt = io.now().toISOString();
    },
    finishTurn: async () => {
      const sinceIso = turnStartedAt;
      turnStartedAt = null;
      if (!sinceIso) return null;
      for (let attempt = 1; attempt <= COPILOT_LEDGER_READ_ATTEMPTS; attempt += 1) {
        // Always a later tick: the first read never runs inside the caller's
        // synchronous path, and a retry waits on a timer, not inside SQLite.
        await io.delay(attempt === 1 ? 0 : COPILOT_LEDGER_RETRY_DELAY_MS);
        try {
          return summarizeCopilotUsageRows(readTurnRows(sinceIso));
        } catch (error) {
          // A missing store or table, or anything else that is not a lock,
          // will not change on a retry.
          if (!isBusyError(error)) return null;
        }
      }
      return null;
    },
  };
}
