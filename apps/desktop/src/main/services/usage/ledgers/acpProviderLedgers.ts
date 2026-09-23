/**
 * History scanners for the ACP providers that keep a usage ledger of their own
 * on disk: Pi, Qwen, Grok, and Copilot CLI's measured `session-store.db`.
 *
 * The plumbing — `TokenEntry`, completeness tracking, file discovery, the
 * per-file read loop, the read-only SQLite opener — is in `ledgerScanCore.ts`.
 * `localUsageLedgers.ts` imports the Copilot store reader from here to merge it
 * with Copilot's event log; nothing here imports from it.
 */
import fs from "node:fs";
import path from "node:path";
import { piSessionRootForEnvironment } from "../../chat/piSessionStore";
import { COPILOT_USAGE_TABLE, GROK_COST_TICKS_PER_USD } from "../providerLedgerFormats";
import { grokSessionsDir, qwenUsageDir } from "../../shared/providerConfigHomes";
import { finiteNumberOrNull, isRecord, safeJsonParse } from "../../shared/utils";
import { uncachedInputTokens } from "../tokenSplit";
import { readGrokModelUsageRow } from "../../chat/acpHost/acpDialects/grokTelemetry";
import { QWEN_USAGE_FILE_NAME_PATTERN, readQwenUsageRow } from "../../chat/acpHost/acpDialects/qwenUsageLedger";
import { readCopilotUsageRow } from "../../chat/acpHost/acpDialects/copilotUsageLedger";
import {
  LOCAL_COST_SCAN_ALL_DAYS,
  LOCAL_SQLITE_SCAN_MAX_ROWS,
  collectLedgerEntries,
  findJsonlFiles,
  findRecentFiles,
  isAdeWorktreePath,
  markLedgerScanIncomplete,
  markLedgerScanIncompleteUnlessMissing,
  normalizeUsageLabel,
  numberFromRecord,
  openReadonlyUsageDatabase,
  textFromSqliteValue,
  timestampMsFromUnixish,
  timestampMsFromValue,
  timestampMsOrNull,
  toNonNegativeInt,
  usageSqliteAll,
  type TokenEntry,
} from "./ledgerScanCore";
/**
 * One entry per Pi assistant message. Pi's `usage.cost.total` is its own
 * list-price arithmetic, not a provider bill, so it is deliberately not copied
 * into `costOverrideUsd` — ADE's usage service prices the tokens it reports.
 */
export function parsePiEntries(raw: string, sourcePath: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  let sessionId = path.basename(sourcePath, ".jsonl");
  let sessionCwd = "";
  let sessionTimestamp = "";
  let ordinal = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
    const type = normalizeUsageLabel(record.type, "");

    if (type === "session") {
      if (typeof record.id === "string" && record.id.trim()) sessionId = record.id.trim();
      if (typeof record.cwd === "string" && record.cwd.trim()) sessionCwd = record.cwd.trim();
      if (typeof record.timestamp === "string") sessionTimestamp = record.timestamp;
      continue;
    }
    if (type !== "message" || !isRecord(record.message)) continue;
    const message = record.message;
    if (message.role !== "assistant" || !isRecord(message.usage)) continue;

    const usage = message.usage;
    const inputTokens = numberFromRecord(usage, "input");
    const outputTokens = numberFromRecord(usage, "output");
    const cachedTokens = numberFromRecord(usage, "cacheRead");
    const cacheWriteTokens = numberFromRecord(usage, "cacheWrite");
    const reasoningTokens = numberFromRecord(usage, "reasoning");
    if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens + reasoningTokens === 0) continue;

    const responseModel = typeof message.responseModel === "string" && message.responseModel.trim()
      ? message.responseModel.trim()
      : "";
    const model = normalizeUsageLabel(responseModel || message.model, "pi-auto");
    const oneHourCacheWrite = finiteNumberOrNull(usage.cacheWrite1h);
    const recordId = typeof record.id === "string" && record.id ? record.id : "";
    const messageId = `pi:${sessionId}:${recordId || ordinal}`;
    ordinal += 1;
    // One Pi assistant message is one model request, so its input side is that
    // request's context for long-context pricing.
    const requestContextTokens = inputTokens + cachedTokens + cacheWriteTokens;

    entries.push({
      messageId,
      model,
      inputTokens,
      // pi-ai's usage type counts reasoning inside `output`, so output alone is
      // the billable figure; adding reasoning would bill it twice.
      outputTokens,
      cachedTokens,
      billableCachedTokens: cachedTokens,
      cacheWriteTokens,
      ...(requestContextTokens > 0 ? { requestContextTokens } : {}),
      ...(oneHourCacheWrite != null && oneHourCacheWrite > 0
        ? { oneHourCacheWriteTokens: oneHourCacheWrite }
        : {}),
      timestamp: timestampMsFromValue(message.timestamp ?? record.timestamp ?? sessionTimestamp),
      ...(sessionCwd ? { projectPath: sessionCwd } : {}),
      ...(sessionCwd && isAdeWorktreePath(sessionCwd) ? { adeOriginated: true } : {}),
    });
  }

  return entries;
}

/**
 * Pi's sessions root, resolved the way ADE's Pi chat and Pi's own CLI resolve
 * it (`PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in Pi's settings.json,
 * then `sessions/` under the agent directory, with `~` expanded).
 */
export async function scanPiLogs(sessionsDir = piSessionRootForEnvironment()): Promise<TokenEntry[]> {
  const files = await findJsonlFiles(sessionsDir, LOCAL_COST_SCAN_ALL_DAYS);
  return collectLedgerEntries(files, parsePiEntries);
}

/**
 * Qwen's per-request rows carry no working directory, but its per-session
 * summary file (`usage_record.jsonl`, one line per finished session) records
 * `{ sessionId, project }`. Join on sessionId so project-scoped usage works.
 */
export function parseQwenSessionProjects(raw: string): Map<string, string> {
  const projects = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const project = typeof record.project === "string" ? record.project.trim() : "";
    if (sessionId && project) projects.set(sessionId, project);
  }
  return projects;
}

/**
 * Qwen writes one row per model request. Following Codex's normalization,
 * `cachedTokens` is treated as a subset of `inputTokens` so the cached portion
 * is not counted twice. `thoughtsTokens` are already inside `outputTokens`
 * (a row's `totalTokens` is input + output), so they add nothing to the bill.
 * `~/.qwen/usage_record.jsonl` holds
 * per-session summaries of these same requests and is deliberately not read
 * here.
 */
export function parseQwenUsageEntries(
  raw: string,
  sourcePath: string,
  projectBySession: ReadonlyMap<string, string> = new Map(),
): TokenEntry[] {
  const entries: TokenEntry[] = [];
  let ordinal = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
    const id = typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `${path.basename(sourcePath)}:${ordinal}`;
    ordinal += 1;

    // The live chat path reads the same row with the same reader, so a Qwen
    // row never normalizes two ways.
    const read = readQwenUsageRow(record);
    const inputTokens = read.inputTokens ?? 0;
    const cachedTokens = read.cacheReadTokens ?? 0;
    const outputTokens = read.outputTokens ?? 0;
    const thoughtsTokens = read.reasoningTokens ?? 0;
    if (inputTokens + outputTokens + cachedTokens + thoughtsTokens === 0) continue;
    // The row's raw `inputTokens` (cache included) is the request's context.
    const totalInput = numberFromRecord(record, "inputTokens");

    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const projectPath = sessionId ? projectBySession.get(sessionId) : undefined;
    entries.push({
      messageId: `qwen:${id}`,
      model: normalizeUsageLabel(record.model, "qwen-auto"),
      ...(projectPath ? { projectPath, adeOriginated: isAdeWorktreePath(projectPath) } : {}),
      inputTokens,
      // Qwen counts thoughts inside `outputTokens` (a row's totalTokens is
      // input + output), so output alone is the billable figure.
      outputTokens,
      cachedTokens,
      billableCachedTokens: cachedTokens,
      cacheWriteTokens: 0,
      // One Qwen row is one model request; `totalInput` is its context.
      ...(totalInput > 0 ? { requestContextTokens: totalInput } : {}),
      timestamp: timestampMsFromValue(record.timestamp),
    });
  }

  return entries;
}

export async function scanQwenLogs(usageDir = qwenUsageDir()): Promise<TokenEntry[]> {
  let filenames: string[];
  try {
    filenames = await fs.promises.readdir(usageDir);
  } catch (error) {
    markLedgerScanIncompleteUnlessMissing(error);
    return [];
  }
  // Newest month first. The names sort lexicographically, and reversing gives a
  // deterministic order regardless of directory listing order on a shared home.
  const files = filenames
    .filter((name) => QWEN_USAGE_FILE_NAME_PATTERN.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(usageDir, name));
  // `usage_record.jsonl` sits beside the `usage/` directory.
  let projectBySession = new Map<string, string>();
  try {
    projectBySession = parseQwenSessionProjects(
      await fs.promises.readFile(path.join(path.dirname(usageDir), "usage_record.jsonl"), "utf8"),
    );
  } catch {
    // No session summaries yet: entries simply carry no project.
  }
  return collectLedgerEntries(files, (raw, filePath) => parseQwenUsageEntries(raw, filePath, projectBySession));
}

/**
 * Grok records the working directory as a percent-encoded directory name above
 * each session's uuid directory (`sessions/<encoded-cwd>/<uuid>/updates.jsonl`),
 * which is the only place the literal path survives. A Windows cwd decodes to a
 * drive or UNC path, so both path flavours count as absolute.
 */
function grokProjectPathFromFile(filePath: string): string | undefined {
  const encoded = path.basename(path.dirname(path.dirname(filePath)));
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.startsWith("/") || path.win32.isAbsolute(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One entry per model per completed turn, read from `turn_completed` updates.
 *
 * A turn reports usage twice — once on `turn_completed` and once on each
 * `response_completed` — so only `turn_completed` is read to avoid double
 * counting. Within a turn the per-model `modelUsage` rows are preferred over the
 * aggregate `usage` (which they sum to). `costUsdTicks` is a real xAI figure in
 * nano-dollars, so it is copied into `costOverrideUsd`.
 */
export function parseGrokTurnEntries(raw: string, sourcePath: string, projectPath?: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const sessionId = path.basename(path.dirname(sourcePath));

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
    const params = isRecord(record.params) ? record.params : undefined;
    const update = params && isRecord(params.update) ? params.update : undefined;
    if (!update || update.sessionUpdate !== "turn_completed") continue;
    const usage = isRecord(update.usage) ? update.usage : undefined;
    if (!usage) continue;

    const promptId = normalizeUsageLabel(update.prompt_id, "") || `${path.basename(sourcePath)}:${entries.length}`;
    const meta = isRecord(record._meta) ? record._meta : undefined;
    const timestamp = timestampMsFromUnixish(meta?.agentTimestampMs ?? record.timestamp);
    const modelUsage = isRecord(usage.modelUsage) ? usage.modelUsage : undefined;
    const rows: Array<{ model: string; usage: Record<string, unknown> }> = [];
    if (modelUsage) {
      for (const [model, value] of Object.entries(modelUsage)) {
        if (isRecord(value)) rows.push({ model, usage: value });
      }
    }
    if (rows.length === 0) rows.push({ model: "grok-auto", usage });

    for (const row of rows) {
      // The live chat path reads the same row with the same reader, so a Grok
      // row never normalizes two ways.
      const read = readGrokModelUsageRow(row.usage);
      if (!read) continue;
      const totalInput = read.input ?? 0;
      const cachedTokens = read.cacheRead ?? 0;
      const cacheWriteTokens = read.cacheWrite ?? 0;
      const outputTokens = read.output ?? 0;
      const reasoningTokens = read.reasoning ?? 0;
      // xAI's `inputTokens` includes the cache, like Codex: split it out so the
      // cached portion is not charged twice. Same rule as the live chat path.
      const inputTokens = uncachedInputTokens(totalInput, cachedTokens, cacheWriteTokens);
      if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens + reasoningTokens === 0) continue;
      const costUsdTicks = read.costTicks ?? null;
      // A modelUsage row spans `modelCalls` requests. Only a row that says it is
      // exactly one request carries one request's context; a multi-call row, or
      // one that does not say, must not pick a long-context tier as though its
      // aggregate input were one prompt.
      const singleRequest = read.calls === 1;
      entries.push({
        messageId: `grok:${sessionId}:${promptId}:${row.model}`,
        model: row.model,
        inputTokens,
        // Grok counts reasoning inside `outputTokens` (totalTokens is input +
        // output; a one-word reply shows 24 output with 23 reasoning).
        outputTokens,
        cachedTokens,
        billableCachedTokens: cachedTokens,
        cacheWriteTokens,
        ...(totalInput > 0 && singleRequest ? { requestContextTokens: totalInput } : {}),
        ...(costUsdTicks != null && costUsdTicks > 0
          ? { costOverrideUsd: costUsdTicks / GROK_COST_TICKS_PER_USD }
          : {}),
        timestamp,
        ...(projectPath ? { projectPath } : {}),
        ...(projectPath && isAdeWorktreePath(projectPath) ? { adeOriginated: true } : {}),
      });
    }
  }

  return entries;
}

export async function scanGrokLogs(sessionsDir = grokSessionsDir()): Promise<TokenEntry[]> {
  const files = (await findRecentFiles(sessionsDir, LOCAL_COST_SCAN_ALL_DAYS, ["updates.jsonl"]))
    .filter((filePath) => path.basename(filePath) === "updates.jsonl");
  return collectLedgerEntries(files, (raw, filePath) => parseGrokTurnEntries(raw, filePath, grokProjectPathFromFile(filePath)));
}

/**
 * How far an event-log `assistant.message` may sit from the
 * `assistant_usage_events` row of the same request. The row's `created_at` is
 * when the request completed and the event is written once the message is
 * final, so the event trails its row by a second or two. The window leaves room
 * for a slow write after the row, and for clock jitter in the other direction.
 */
const COPILOT_EVENT_AFTER_ROW_MS = 10_000;
const COPILOT_EVENT_BEFORE_ROW_MS = 2_000;

/**
 * Map Copilot CLI `assistant_usage_events` rows to token entries.
 *
 * One row is one model request inside a turn. `input_tokens` is the *whole*
 * input side — uncached input plus cache reads *and* cache writes
 * (`token_details_json` splits a row of 23,112 input into 3 fresh, 0 cache read
 * and 23,109 cache write) — so it is normalized to the mutually exclusive
 * input/cache split Codex uses, or the cached portion would be charged twice.
 * `total_nano_aiu` is GitHub's AI-unit accounting, not a dollar bill, so it is
 * deliberately not copied into `costOverrideUsd`.
 */
export function parseCopilotUsageEventRows(
  rows: Record<string, unknown>[],
  projectPathBySession: ReadonlyMap<string, string>,
): TokenEntry[] {
  const entries: TokenEntry[] = [];
  for (const row of rows) {
    const sessionId = textFromSqliteValue(row.session_id);
    const rowId = toNonNegativeInt(row.id);
    // The live chat path reads the same row with the same reader, so a
    // Copilot row never normalizes two ways.
    const read = readCopilotUsageRow(row);
    const inputTokens = read.inputTokens ?? 0;
    const cachedTokens = read.cacheReadTokens ?? 0;
    const cacheWriteTokens = read.cacheWriteTokens ?? 0;
    const outputTokens = read.outputTokens ?? 0;
    const reasoningTokens = read.reasoningTokens ?? 0;
    if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens + reasoningTokens === 0) continue;
    // The row's raw `input_tokens` (cache included) is the request's context.
    const totalInput = numberFromRecord(row, "input_tokens");
    const projectPath = projectPathBySession.get(sessionId);
    entries.push({
      messageId: `copilot-cli:${sessionId}:${rowId}`,
      model: normalizeUsageLabel(row.model, "copilot-auto"),
      inputTokens,
      // Copilot's `output_tokens` already holds `reasoning_tokens` (a short
      // reply stores 60 output with 53 reasoning), so output is the billable figure.
      outputTokens,
      cachedTokens,
      billableCachedTokens: cachedTokens,
      cacheWriteTokens,
      // One row is one model request; `totalInput` is that request's context.
      ...(totalInput > 0 ? { requestContextTokens: totalInput } : {}),
      timestamp: timestampMsFromValue(row.created_at),
      ...(projectPath ? { projectPath } : {}),
      ...(projectPath && isAdeWorktreePath(projectPath) ? { adeOriginated: true } : {}),
    });
  }
  return entries;
}

/** What the measured store holds: its entries, and when each request finished. */
export type CopilotStoreRead = {
  entries: TokenEntry[];
  /** Completion time of every measured request, per Copilot session id, ascending. */
  requestTimesBySession: Map<string, number[]>;
};

function emptyCopilotStoreRead(): CopilotStoreRead {
  return { entries: [], requestTimesBySession: new Map() };
}

export async function scanCopilotCliRows(dbPath: string): Promise<CopilotStoreRead> {
  const db = openReadonlyUsageDatabase(dbPath);
  if (!db) return emptyCopilotStoreRead();
  try {
    // An older Copilot install simply has no usage store yet: an absent table is
    // "nothing to read", not a partial read, so it must not mark the provider
    // incomplete.
    const table = usageSqliteAll<Record<string, unknown>>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [COPILOT_USAGE_TABLE],
    );
    if (table.length === 0) return emptyCopilotStoreRead();
    const rows = usageSqliteAll<Record<string, unknown>>(
      db,
      `SELECT id, session_id, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, reasoning_tokens, created_at
         FROM ${COPILOT_USAGE_TABLE}
        ORDER BY id
        LIMIT ?`,
      [LOCAL_SQLITE_SCAN_MAX_ROWS],
    );
    const projectPathBySession = new Map<string, string>();
    try {
      const sessions = usageSqliteAll<Record<string, unknown>>(db, "SELECT id, cwd FROM sessions");
      for (const session of sessions) {
        const sessionId = textFromSqliteValue(session.id);
        const cwd = textFromSqliteValue(session.cwd).trim();
        if (sessionId && cwd) projectPathBySession.set(sessionId, cwd);
      }
    } catch {
      // No `sessions` table: usage rows still count, they just lose their
      // project attribution.
    }
    // Every row is a request the store measured, including one that reported no
    // tokens, so every row can cover its event-log twin.
    const requestTimesBySession = new Map<string, number[]>();
    for (const row of rows) {
      const finishedAt = timestampMsOrNull(row.created_at);
      if (finishedAt == null) continue;
      const sessionId = textFromSqliteValue(row.session_id);
      const times = requestTimesBySession.get(sessionId);
      if (times) times.push(finishedAt);
      else requestTimesBySession.set(sessionId, [finishedAt]);
    }
    for (const times of requestTimesBySession.values()) times.sort((a, b) => a - b);
    return { entries: parseCopilotUsageEventRows(rows, projectPathBySession), requestTimesBySession };
  } catch {
    markLedgerScanIncomplete();
    return emptyCopilotStoreRead();
  } finally {
    db.close();
  }
}

/**
 * The event-log entries of one session that the measured store does NOT cover.
 *
 * Neither source carries an id the other knows, so each event pairs with the
 * nearest unpaired row whose completion time sits inside the tolerance window,
 * and each row pairs at most once. Position is not a key: a session that began
 * before `session-store.db` existed has event-log turns with no row at all, and
 * those are its OLDEST turns — skipping the first N events would drop them and
 * count the newest turns twice.
 */
export function copilotEventsNotInStore(
  events: readonly TokenEntry[],
  requestTimes: readonly number[],
): TokenEntry[] {
  if (requestTimes.length === 0) return [...events];
  const paired = new Array<boolean>(requestTimes.length).fill(false);
  const covered = new Set<TokenEntry>();
  let first = 0;
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    while (first < requestTimes.length && requestTimes[first]! < event.timestamp - COPILOT_EVENT_AFTER_ROW_MS) {
      first += 1;
    }
    let nearest = -1;
    for (
      let index = first;
      index < requestTimes.length && requestTimes[index]! <= event.timestamp + COPILOT_EVENT_BEFORE_ROW_MS;
      index += 1
    ) {
      if (paired[index]) continue;
      if (nearest < 0 || Math.abs(requestTimes[index]! - event.timestamp) < Math.abs(requestTimes[nearest]! - event.timestamp)) {
        nearest = index;
      }
    }
    if (nearest < 0) continue;
    paired[nearest] = true;
    covered.add(event);
  }
  return events.filter((event) => !covered.has(event));
}
