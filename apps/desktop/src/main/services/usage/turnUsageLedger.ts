import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  AdeQuotaSample,
  AdeTurnUsageAmendment,
  AdeTurnUsageGroupBy,
  AdeTurnUsageLedgerSummary,
  AdeTurnUsageRecord,
  AdeTurnUsageSummaryRow,
  AgentChatEvent,
  AgentChatPlanUsage,
  AgentChatSession,
  AgentChatSubagentUsage,
  CodexTokenUsageBreakdown,
  GetTurnUsageSummaryArgs,
  UsageSnapshot,
} from "../../../shared/types";
import {
  ADE_TURN_USAGE_DEFAULT_DAYS,
  ADE_TURN_USAGE_MAX_DAYS,
  ADE_TURN_USAGE_MAX_RECENT,
  DEFAULT_ADE_TURN_USAGE_GROUP_BY,
  isAdeTurnUsageGroupBy,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isServedModelMismatch } from "../chat/servedModelMismatch";
import { pathKey } from "../shared/pathCompare";
import { evictOldestEntries, evictOldestSetEntries, finiteNumberOrNull, getErrorMessage, toOptionalString } from "../shared/utils";
import { localDayKey, localDayStart } from "./localDay";
import { DEFAULT_BURN_LOOKBACK_MS, estimateQuotaBurnRates, quotaSampleKey, sameResetInstance } from "./quotaBurnRate";
import { reasoningBilledSeparately, uncachedInputTokens } from "./tokenSplit";
import { usageAccountId } from "./usageAccountId";
import {
  isZeroTokenPrice,
  priceTokenSplit,
  ratesForRequest,
  resolveTokenPrice,
} from "./usagePricing";

/**
 * The machine-local per-turn usage ledger: one JSON line for each finished
 * chat turn, whatever the provider. A model router reads it to learn what each
 * provider, account, and model costs on this machine, in tokens, in the
 * provider's own bill, and in one shared currency (`apiEquivalentUsd`).
 *
 * It lives under `<adeDir>/usage/`, outside the synced project database, so a
 * new field never has to reach an older phone or desktop. It observes and
 * never steers: every write is best effort, and no failure here can reach a
 * chat turn.
 */

type DoneEvent = Extract<AgentChatEvent, { type: "done" }>;

type TokenSplit = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

/** What the ledger saw of one turn before its `done` arrived. */
export type TurnUsageObservation = {
  firstSeenAtMs: number;
  /**
   * The model the session asked for when the turn began. A model switch while
   * the turn runs changes the session, not the turn that is already running.
   */
  requestedModel: string | null;
  /** Codex thread totals when the turn's first usage update arrived, minus that update's own request. */
  codexBaseline: CodexTokenUsageBreakdown | null;
  codexLatestTotal: CodexTokenUsageBreakdown | null;
  codexLatestLast: CodexTokenUsageBreakdown | null;
  codexContextWindow: number | null;
  latestTokens: (TokenSplit & { contextWindow: number | null }) | null;
  /** The turn's latest live occupancy sample (`context_usage`), for a `done` that carries none. */
  latestContext: { tokens: number; window: number | null } | null;
  /** Highest token count each subagent reported, by task id. */
  subagentTokensByTask: Map<string, number>;
  /** Compaction ids the turn finished; an event with no id counts on its own. */
  compactionIds: Set<string>;
  compactions: number;
};

export type TurnUsageSessionFacts = Pick<AgentChatSession, "id" | "laneId" | "provider" | "model"> & {
  modelId?: string | null;
  reasoningEffort?: string | null;
  surface?: string | null;
  orchestrationParentSessionId?: string | null;
};

const LEDGER_DIR_NAME = "usage";
const TURN_FILE_PREFIX = "turns-";
const QUOTA_FILE_PREFIX = "quota-";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_OPEN_TURNS = 512;
const MAX_SETTLED_KEYS = 4_096;
/** Sessions whose recent turn starts the ledger remembers, and turns per session. */
const MAX_TURN_START_SESSIONS = 512;
const MAX_TURN_STARTS_PER_SESSION = 32;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_FILE_READ_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETENTION_MONTHS = 3;
/** A quota reading moves by at least this many percent points before the ledger writes it again. */
const MIN_QUOTA_PERCENT_DELTA = 0.5;

function nonNegative(value: unknown): number | null {
  const n = finiteNumberOrNull(value);
  return n != null && n >= 0 ? n : null;
}

function monthKey(ms: number): string {
  const at = new Date(ms);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthIndex(key: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/** USD rounded to 6 decimals, the precision every ledger and report dollar figure keeps. */
export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function subtractBreakdown(a: CodexTokenUsageBreakdown, b: CodexTokenUsageBreakdown | null): CodexTokenUsageBreakdown {
  const minus = (x: number | undefined, y: number | undefined) => Math.max(0, (x ?? 0) - (y ?? 0));
  return {
    inputTokens: minus(a.inputTokens, b?.inputTokens),
    outputTokens: minus(a.outputTokens, b?.outputTokens),
    cacheReadTokens: minus(a.cacheReadTokens, b?.cacheReadTokens),
    cacheWriteTokens: minus(a.cacheWriteTokens, b?.cacheWriteTokens),
    reasoningTokens: minus(a.reasoningTokens, b?.reasoningTokens),
  };
}

function newObservation(nowMs: number, requestedModel: string | null): TurnUsageObservation {
  return {
    firstSeenAtMs: nowMs,
    requestedModel,
    codexBaseline: null,
    codexLatestTotal: null,
    codexLatestLast: null,
    codexContextWindow: null,
    latestTokens: null,
    latestContext: null,
    subagentTokensByTask: new Map(),
    compactionIds: new Set(),
    compactions: 0,
  };
}

/**
 * True for an event that says the provider finished compacting the context:
 * a `context_compact` that is not the `started` half of a pair (a `failed`
 * one still spent the attempt), or a completed `codex_context_compaction`.
 */
function finishedCompaction(event: AgentChatEvent): { id: string | null } | null {
  if (event.type === "context_compact") {
    return event.state === "started" ? null : { id: toOptionalString(event.compactionId) };
  }
  if (event.type === "codex_context_compaction") {
    return event.state === "completed" ? { id: toOptionalString(event.compactionId) } : null;
  }
  return null;
}

/**
 * Tokens in one subagent usage record, from a subagent event or from `done`:
 * the reported total when there is one, else input + output + cache read +
 * cache write. Reasoning is inside output, so it is not added again.
 */
function subagentUsageTokens(
  usage: Pick<AgentChatSubagentUsage, "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> | undefined,
): number {
  if (!usage) return 0;
  const total = nonNegative(usage.totalTokens);
  if (total != null) return total;
  return (nonNegative(usage.inputTokens) ?? 0)
    + (nonNegative(usage.outputTokens) ?? 0)
    + (nonNegative(usage.cacheReadTokens) ?? 0)
    + (nonNegative(usage.cacheWriteTokens) ?? 0);
}

/**
 * Folds one chat event into the open turn it belongs to. Only the events that
 * carry usage matter; every other event just marks when the turn started.
 */
export function observeTurnEvent(
  turns: Map<string, TurnUsageObservation>,
  sessionId: string,
  event: AgentChatEvent,
  nowMs: number,
  sessionModel: string | null = null,
): TurnUsageObservation | null {
  if (event.type === "done") return null;
  const turnId = toOptionalString((event as { turnId?: unknown }).turnId);
  if (!turnId) return null;
  const key = `${sessionId}:${turnId}`;
  // Least recently used goes first: re-inserting a touched turn keeps a long
  // turn from being evicted by many short ones.
  const observation = turns.get(key) ?? newObservation(nowMs, toOptionalString(sessionModel));
  turns.delete(key);
  turns.set(key, observation);
  evictOldestEntries(turns, MAX_OPEN_TURNS);
  if (event.type === "codex_token_usage") {
    const total = event.usage?.total ?? null;
    const last = event.usage?.last ?? null;
    // Codex sends running thread totals. The turn's own usage is the latest
    // total minus the total before the turn's first request, which stays right
    // even when Codex repeats an update.
    if (total && !observation.codexBaseline) observation.codexBaseline = subtractBreakdown(total, last);
    if (total) observation.codexLatestTotal = total;
    if (last) observation.codexLatestLast = last;
    const window = nonNegative(event.usage?.modelContextWindow);
    if (window) observation.codexContextWindow = window;
    return observation;
  }
  if (event.type === "tokens") {
    observation.latestTokens = {
      inputTokens: nonNegative(event.inputTokens),
      outputTokens: nonNegative(event.outputTokens),
      cacheReadTokens: nonNegative(event.cacheReadTokens),
      cacheWriteTokens: nonNegative(event.cacheWriteTokens),
      reasoningTokens: nonNegative(event.reasoningTokens),
      contextWindow: nonNegative(event.contextWindow),
    };
    return observation;
  }
  if (event.type === "context_usage") {
    // Only a measured sample says what the context holds; a compacting or
    // recalculating one is a placeholder.
    const measured = event.state === undefined || event.state === "measured";
    const tokens = nonNegative(event.usage?.totalTokens);
    if (measured && tokens != null && tokens > 0) {
      observation.latestContext = { tokens, window: nonNegative(event.usage?.maxTokens) || null };
    }
    return observation;
  }
  if (event.type === "subagent_progress" || event.type === "subagent_result") {
    const count = subagentUsageTokens(event.usage);
    const previous = observation.subagentTokensByTask.get(event.taskId) ?? 0;
    if (count > previous) observation.subagentTokensByTask.set(event.taskId, count);
    return observation;
  }
  const compaction = finishedCompaction(event);
  if (compaction) {
    // A runtime that repeats the end of one compaction must not count it twice.
    if (compaction.id != null) {
      if (observation.compactionIds.has(compaction.id)) return observation;
      observation.compactionIds.add(compaction.id);
    }
    observation.compactions += 1;
  }
  return observation;
}

function tokensFromDone(event: DoneEvent): TokenSplit | null {
  const usage = event.usage;
  if (!usage) return null;
  const split: TokenSplit = {
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens),
    cacheWriteTokens: nonNegative(usage.cacheCreationTokens),
    reasoningTokens: nonNegative(usage.reasoningTokens),
  };
  return Object.values(split).some((value) => value != null) ? split : null;
}

/**
 * The turn's token split in the ledger's one meaning (uncached input apart
 * from cache reads). Codex puts the cached part inside its input count, and
 * its `done` carries no cache split, so its figures come from the thread
 * totals the turn's usage updates carried.
 */
function turnTokens(
  provider: string,
  event: DoneEvent,
  observation: TurnUsageObservation | null,
): { split: TokenSplit | null; contextTokens: number | null; contextWindow: number | null; derived: boolean } {
  const usage = event.usage;
  if (provider === "codex") {
    if (observation?.codexLatestTotal) {
      const delta = subtractBreakdown(observation.codexLatestTotal, observation.codexBaseline);
      const last = observation.codexLatestLast;
      return {
        split: {
          inputTokens: uncachedInputTokens(delta.inputTokens ?? 0, delta.cacheReadTokens, undefined),
          outputTokens: delta.outputTokens ?? 0,
          cacheReadTokens: delta.cacheReadTokens ?? 0,
          cacheWriteTokens: delta.cacheWriteTokens ?? 0,
          reasoningTokens: delta.reasoningTokens ?? 0,
        },
        contextTokens: nonNegative(usage?.contextTokens) ?? nonNegative(last?.inputTokens),
        contextWindow: nonNegative(usage?.contextWindow) ?? observation.codexContextWindow,
        derived: true,
      };
    }
    const split = tokensFromDone(event);
    if (split && split.inputTokens != null) {
      split.inputTokens = uncachedInputTokens(split.inputTokens, split.cacheReadTokens ?? undefined, undefined);
    }
    return { split, contextTokens: nonNegative(usage?.contextTokens), contextWindow: nonNegative(usage?.contextWindow), derived: false };
  }
  const fromDone = tokensFromDone(event);
  const latest = observation?.latestTokens ?? null;
  return {
    split: fromDone ?? (latest
      ? {
          inputTokens: latest.inputTokens,
          outputTokens: latest.outputTokens,
          cacheReadTokens: latest.cacheReadTokens,
          cacheWriteTokens: latest.cacheWriteTokens,
          reasoningTokens: latest.reasoningTokens,
        }
      : null),
    contextTokens: nonNegative(usage?.contextTokens) ?? observation?.latestContext?.tokens ?? null,
    contextWindow: nonNegative(usage?.contextWindow) ?? latest?.contextWindow ?? observation?.latestContext?.window ?? null,
    derived: !fromDone && Boolean(latest),
  };
}

/**
 * The turn at the model's public API list price. Every request in the turn is
 * priced at the tier of the turn's last request, which can over-price the
 * early requests of a turn that crossed a long-context threshold. Reasoning is
 * priced on its own only for a provider whose output count leaves it out (see
 * `reasoningBilledSeparately`).
 */
export function apiEquivalentTurnUsd(
  model: string | null,
  split: TokenSplit | null,
  request: {
    contextTokens?: number | null;
    cacheWrite1hTokens?: number | null;
    timestampMs: number;
    provider?: string | null;
  },
): number | null {
  if (!model || !split) return null;
  const price = resolveTokenPrice(model);
  if (isZeroTokenPrice(price)) return null;
  const rates = ratesForRequest(model, price, { contextTokens: request.contextTokens, timestampMs: request.timestampMs });
  const reasoning = reasoningBilledSeparately(request.provider) ? (split.reasoningTokens ?? 0) : 0;
  return round6(priceTokenSplit(rates, {
    input: split.inputTokens ?? 0,
    output: (split.outputTokens ?? 0) + reasoning,
    cacheRead: split.cacheReadTokens ?? 0,
    cacheWrite: split.cacheWriteTokens ?? 0,
    cacheWrite1h: nonNegative(request.cacheWrite1hTokens) ?? 0,
  }));
}

/** Tokens the helper agents that a provider's ledger reported with `done` used. */
function doneSubagentTokens(event: DoneEvent): number {
  return (event.subagentUsage ?? []).reduce((total, entry) => total + subagentUsageTokens(entry), 0);
}

export function buildTurnUsageRecord(input: {
  session: TurnUsageSessionFacts;
  event: DoneEvent;
  observation: TurnUsageObservation | null;
  projectRoot?: string | null;
  nowMs: number;
}): AdeTurnUsageRecord {
  const { session, event, observation, nowMs } = input;
  const provider = session.provider;
  const { split, contextTokens, contextWindow, derived } = turnTokens(provider, event, observation);
  // The model asked for when the turn began wins over the session's current
  // model, which a mid-turn switch has already changed.
  const requestedModel = observation?.requestedModel
    ?? toOptionalString(session.modelId)
    ?? toOptionalString(event.modelId)
    ?? toOptionalString(session.model)
    ?? toOptionalString(event.model);
  const servedModel = toOptionalString(event.servedModel);
  const priceModel = servedModel ?? toOptionalString(event.canonicalModel) ?? toOptionalString(event.model) ?? requestedModel;
  const cacheWrite1hTokens = nonNegative(event.usage?.cacheWrite1hTokens);
  const subagentTokens = (observation
    ? [...observation.subagentTokensByTask.values()].reduce((acc, n) => acc + n, 0)
    : 0) + doneSubagentTokens(event);
  const planUsage: AgentChatPlanUsage[] = (event.planUsage ?? [])
    .filter((entry) => toOptionalString(entry.unit) && finiteNumberOrNull(entry.amount) != null)
    .map((entry) => ({ unit: entry.unit, amount: entry.amount }));
  const costUsd = nonNegative(event.costUsd);
  const confidence = event.usageConfidence ?? (derived ? "derived" : split ? "measured" : null);
  const startedAtMs = observation?.firstSeenAtMs ?? null;
  return {
    v: 1,
    key: `${session.id}:${event.turnId}`,
    at: new Date(nowMs).toISOString(),
    startedAt: startedAtMs != null ? new Date(startedAtMs).toISOString() : null,
    sessionId: session.id,
    turnId: event.turnId,
    projectRoot: input.projectRoot ?? null,
    laneId: toOptionalString(session.laneId),
    surface: toOptionalString(session.surface),
    parentSessionId: toOptionalString(session.orchestrationParentSessionId),
    provider,
    status: event.status,
    requestedModel,
    servedModel,
    reasoningEffort: toOptionalString(session.reasoningEffort),
    account: event.account ?? null,
    accountKey: usageAccountId({
      provider: toOptionalString(event.account?.provider) ?? provider,
      instanceId: event.account?.instanceId,
      email: event.account?.email,
    }),
    inputTokens: split?.inputTokens ?? null,
    outputTokens: split?.outputTokens ?? null,
    cacheReadTokens: split?.cacheReadTokens ?? null,
    cacheWriteTokens: split?.cacheWriteTokens ?? null,
    cacheWrite1hTokens,
    reasoningTokens: split?.reasoningTokens ?? null,
    contextTokens,
    contextWindow,
    requestCount: nonNegative(event.usage?.requestCount),
    subagentTokens: subagentTokens > 0 ? subagentTokens : null,
    costUsd,
    // Claude's `total_cost_usd` arrives with no source, and it is the SDK's
    // list-price math, not a bill. Only a source that says so is a bill.
    costSource: costUsd != null ? (event.costSource ?? "list_price") : null,
    apiEquivalentUsd: apiEquivalentTurnUsd(priceModel, split, { contextTokens, cacheWrite1hTokens, timestampMs: nowMs, provider }),
    planUsage: planUsage.length ? planUsage : null,
    // Only a Factory amendment knows the session's credits.
    factoryCreditsSessionTotal: null,
    usageConfidence: confidence,
    durationMs: startedAtMs != null ? Math.max(0, nowMs - startedAtMs) : null,
    compactions: observation?.compactions ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function isRecordLine(value: unknown): value is AdeTurnUsageRecord {
  const row = value as AdeTurnUsageRecord | null;
  return Boolean(row && row.v === 1 && typeof row.key === "string" && typeof row.at === "string" && typeof row.provider === "string");
}

function isAmendmentLine(value: unknown): value is AdeTurnUsageAmendment {
  const row = value as AdeTurnUsageAmendment | null;
  return Boolean(row && row.v === 1 && typeof row.amend === "string" && row.patch && typeof row.patch === "object");
}

function isQuotaSampleLine(value: unknown): value is AdeQuotaSample {
  const row = value as AdeQuotaSample | null;
  return Boolean(row && row.v === 1 && typeof row.provider === "string" && typeof row.accountId === "string"
    && typeof row.windowType === "string" && finiteNumberOrNull(row.percentUsed) != null && typeof row.at === "string");
}

/** Parses one ledger line into `rows`. A blank, oversized, or torn line is skipped. */
function pushJsonLine(rows: unknown[], line: string): void {
  if (!line || line.length > MAX_LINE_BYTES) return;
  try {
    rows.push(JSON.parse(line));
  } catch {
    // A torn last line from a crash mid-append; the rest of the file is fine.
  }
}

type SkippedFileListener = (filePath: string, sizeBytes: number) => void;

/** A path that is not there (or whose parent is not a directory): nothing to read, not a failed read. */
function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Adds the parsed lines of one month file to `rows`, line by line, so a large
 * file never blocks the event loop. A file larger than `MAX_FILE_READ_BYTES`
 * is not read at all; `onSkip` hears about it, so the missing month is in the
 * log and not only in a total that reads low.
 *
 * True when the whole file is in `rows` (or it is gone). False when its rows
 * are missing: skipped for size, or it could not be opened. A stream that
 * fails mid-file throws.
 */
async function readJsonLines(filePath: string, rows: unknown[], onSkip: SkippedFileListener): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    return isMissingPathError(error);
  }
  if (stat.size > MAX_FILE_READ_BYTES) {
    onSkip(filePath, stat.size);
    return false;
  }
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) pushJsonLine(rows, line);
  } finally {
    lines.close();
  }
  return true;
}

/** `readJsonLines`, synchronously. Only the first quota snapshot's small seed read uses it. */
function readJsonLinesSync(filePath: string, rows: unknown[], onSkip: SkippedFileListener): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (stat.size > MAX_FILE_READ_BYTES) {
    onSkip(filePath, stat.size);
    return;
  }
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) pushJsonLine(rows, line);
}

/** The month files of one kind from `sinceMs`'s month on, oldest first. */
function monthFilePaths(dir: string, names: readonly string[], prefix: string, sinceMs: number): string[] {
  const since = monthIndex(monthKey(sinceMs)) ?? 0;
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .filter((name) => (monthIndex(name.slice(prefix.length, -".jsonl".length)) ?? -1) >= since)
    .sort()
    .map((name) => path.join(dir, name));
}

/** The month files to read, `[]` when the ledger has no directory yet, or null when the directory could not be listed. */
async function monthFiles(dir: string, prefix: string, sinceMs: number): Promise<string[] | null> {
  try {
    return monthFilePaths(dir, await fs.promises.readdir(dir), prefix, sinceMs);
  } catch (error) {
    return isMissingPathError(error) ? [] : null;
  }
}

function monthFilesSync(dir: string, prefix: string, sinceMs: number): string[] {
  try {
    return monthFilePaths(dir, fs.readdirSync(dir), prefix, sinceMs);
  } catch {
    return [];
  }
}

function quotaSamplesSince(lines: unknown[], sinceMs: number): AdeQuotaSample[] {
  return lines
    .filter(isQuotaSampleLine)
    .filter((row) => Date.parse(row.at) >= sinceMs)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Applies each amendment to its row, oldest amendment first. */
export function mergeTurnUsageLines(lines: unknown[]): AdeTurnUsageRecord[] {
  const byKey = new Map<string, AdeTurnUsageRecord>();
  const amendments: AdeTurnUsageAmendment[] = [];
  for (const line of lines) {
    // A row written before `compactions` existed reads back as 0 compactions.
    if (isRecordLine(line)) byKey.set(line.key, typeof line.compactions === "number" ? line : { ...line, compactions: 0 });
    else if (isAmendmentLine(line)) amendments.push(line);
  }
  amendments.sort((a, b) => a.at.localeCompare(b.at));
  for (const amendment of amendments) {
    const row = byKey.get(amendment.amend);
    if (row) byKey.set(amendment.amend, { ...row, ...amendment.patch });
  }
  return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** A turn read that says whether it saw the whole ledger. `ok: false` is a failed read, never "no turns". */
export type TurnUsageRead = { ok: true; rows: AdeTurnUsageRecord[] } | { ok: false };

export type TurnUsageLedgerStore = {
  readonly dir: string;
  appendTurn(record: AdeTurnUsageRecord): void;
  amendTurn(key: string, source: AdeTurnUsageAmendment["source"], patch: AdeTurnUsageAmendment["patch"]): void;
  appendQuotaSample(sample: AdeQuotaSample): void;
  /**
   * Reads the month files line by line, so up to 90 days of turns never block
   * the event loop. A read that fails, or skips a file, gives what it could
   * read (possibly `[]`) and logs once.
   */
  readTurns(args?: { sinceMs?: number }): Promise<AdeTurnUsageRecord[]>;
  /** `readTurns` for a caller that must not mistake a failed or partial read for a day with no turns. */
  readTurnsChecked(args?: { sinceMs?: number }): Promise<TurnUsageRead>;
  readQuotaSamples(args?: { sinceMs?: number }): Promise<AdeQuotaSample[]>;
  /** `readQuotaSamples`, synchronously, for the ledger's first quota snapshot: a few weeks of small rows. */
  readQuotaSamplesSync(args?: { sinceMs?: number }): AdeQuotaSample[];
};

export function createTurnUsageLedgerStore(args: {
  dir: string;
  logger?: Pick<Logger, "warn"> | null;
  nowMs?: () => number;
  retentionMonths?: number;
}): TurnUsageLedgerStore {
  const now = args.nowMs ?? Date.now;
  const retentionMonths = Math.max(1, args.retentionMonths ?? DEFAULT_RETENTION_MONTHS);
  const warned = new Set<string>();
  let prunedMonth: string | null = null;

  const warnOnce = (kind: string, error: unknown) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    args.logger?.warn("usage.turn_ledger_io_failed", { kind, error: getErrorMessage(error) });
  };
  // Once per file: each oversized month is a different gap in the totals.
  const warnSkippedFile = (filePath: string, sizeBytes: number) => {
    warnOnce(
      `file_too_large:${path.basename(filePath)}`,
      new Error(`ledger file ${path.basename(filePath)} of ${sizeBytes} bytes is over ${MAX_FILE_READ_BYTES} bytes and was skipped`),
    );
  };
  /** The parsed lines of every month file from `sinceMs` on; `complete` is false when a file or the listing could not be read. */
  const readMonthLines = async (prefix: string, sinceMs: number): Promise<{ rows: unknown[]; complete: boolean }> => {
    const rows: unknown[] = [];
    const files = await monthFiles(args.dir, prefix, sinceMs);
    if (!files) return { rows, complete: false };
    let complete = true;
    for (const filePath of files) {
      if (!(await readJsonLines(filePath, rows, warnSkippedFile))) complete = false;
    }
    return { rows, complete };
  };
  const turnsSince = (lines: unknown[], sinceMs: number): AdeTurnUsageRecord[] =>
    mergeTurnUsageLines(lines).filter((row) => Date.parse(row.at) >= sinceMs);

  const prune = (currentMonth: string) => {
    if (prunedMonth === currentMonth) return;
    prunedMonth = currentMonth;
    const oldest = (monthIndex(currentMonth) ?? 0) - retentionMonths;
    let names: string[] = [];
    try {
      names = fs.readdirSync(args.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const prefix = name.startsWith(TURN_FILE_PREFIX) ? TURN_FILE_PREFIX : name.startsWith(QUOTA_FILE_PREFIX) ? QUOTA_FILE_PREFIX : null;
      if (!prefix || !name.endsWith(".jsonl")) continue;
      const month = monthIndex(name.slice(prefix.length, -".jsonl".length));
      if (month == null || month >= oldest) continue;
      try {
        fs.unlinkSync(path.join(args.dir, name));
      } catch (error) {
        warnOnce("prune", error);
      }
    }
  };

  const append = (prefix: string, row: unknown) => {
    const line = JSON.stringify(row);
    if (line.length > MAX_LINE_BYTES) {
      warnOnce("line_too_long", new Error(`ledger line of ${line.length} bytes skipped`));
      return;
    }
    const month = monthKey(now());
    try {
      fs.mkdirSync(args.dir, { recursive: true });
      prune(month);
      fs.appendFileSync(path.join(args.dir, `${prefix}${month}.jsonl`), `${line}\n`, "utf8");
    } catch (error) {
      warnOnce("append", error);
    }
  };

  return {
    dir: args.dir,
    appendTurn: (record) => append(TURN_FILE_PREFIX, record),
    amendTurn: (key, source, patch) => {
      const amendment: AdeTurnUsageAmendment = { v: 1, amend: key, at: new Date(now()).toISOString(), source, patch };
      append(TURN_FILE_PREFIX, amendment);
    },
    appendQuotaSample: (sample) => append(QUOTA_FILE_PREFIX, sample),
    readTurns: async (options = {}) => {
      const sinceMs = options.sinceMs ?? 0;
      try {
        return turnsSince((await readMonthLines(TURN_FILE_PREFIX, sinceMs)).rows, sinceMs);
      } catch (error) {
        warnOnce("read_turns", error);
        return [];
      }
    },
    readTurnsChecked: async (options = {}) => {
      const sinceMs = options.sinceMs ?? 0;
      try {
        const read = await readMonthLines(TURN_FILE_PREFIX, sinceMs);
        return read.complete ? { ok: true, rows: turnsSince(read.rows, sinceMs) } : { ok: false };
      } catch (error) {
        warnOnce("read_turns", error);
        return { ok: false };
      }
    },
    readQuotaSamples: async (options = {}) => {
      const sinceMs = options.sinceMs ?? 0;
      try {
        return quotaSamplesSince((await readMonthLines(QUOTA_FILE_PREFIX, sinceMs)).rows, sinceMs);
      } catch (error) {
        warnOnce("read_quota", error);
        return [];
      }
    },
    readQuotaSamplesSync: (options = {}) => {
      const sinceMs = options.sinceMs ?? 0;
      try {
        const rows: unknown[] = [];
        for (const filePath of monthFilesSync(args.dir, QUOTA_FILE_PREFIX, sinceMs)) {
          readJsonLinesSync(filePath, rows, warnSkippedFile);
        }
        return quotaSamplesSince(rows, sinceMs);
      } catch (error) {
        warnOnce("read_quota", error);
        return [];
      }
    },
  };
}

/** The rows that finished on one machine-local day (`YYYY-MM-DD`), by the local day of `at`. */
export function turnsOnLocalDay(rows: readonly AdeTurnUsageRecord[], day: string): AdeTurnUsageRecord[] {
  return rows.filter((row) => localDayKey(row.at) === day);
}

/**
 * One machine-local day's rows, read with the store's streaming read. Empty
 * for a malformed day or a day with no turns; null when the ledger could not
 * be read in full, which is not the same as a day with no turns.
 */
export async function readTurnUsageDay(
  store: Pick<TurnUsageLedgerStore, "readTurnsChecked">,
  day: string,
): Promise<AdeTurnUsageRecord[] | null> {
  const start = localDayStart(day);
  if (!start) return [];
  const read = await store.readTurnsChecked({ sinceMs: start.getTime() });
  return read.ok ? turnsOnLocalDay(read.rows, day) : null;
}

// ---------------------------------------------------------------------------
// Quota samples
// ---------------------------------------------------------------------------

export function quotaSamplesFromSnapshot(snapshot: Pick<UsageSnapshot, "windows">, nowMs: number): AdeQuotaSample[] {
  const at = new Date(nowMs).toISOString();
  const samples: AdeQuotaSample[] = [];
  for (const window of snapshot.windows ?? []) {
    const percentUsed = finiteNumberOrNull(window.percentUsed);
    const resetsAt = toOptionalString(window.resetsAt);
    if (percentUsed == null || !resetsAt || !window.provider || !window.windowType) continue;
    samples.push({
      v: 1,
      at,
      provider: window.provider,
      accountId: toOptionalString(window.accountId) ?? usageAccountId({ provider: window.provider }),
      windowType: window.windowType,
      percentUsed,
      resetsAt,
    });
  }
  return samples;
}

/**
 * True when a new reading says something the last one did not: a new window
 * instance or a percent change big enough to count. A reset time that only
 * jitters (Claude's moves by microseconds on every poll) is the same window.
 */
export function quotaSampleChanged(previous: AdeQuotaSample | undefined, next: AdeQuotaSample): boolean {
  if (!previous) return true;
  if (!sameResetInstance(previous, next)) return true;
  return Math.abs(next.percentUsed - previous.percentUsed) >= MIN_QUOTA_PERCENT_DELTA;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function summarizeTurnUsage(
  records: AdeTurnUsageRecord[],
  groupBy: AdeTurnUsageGroupBy = DEFAULT_ADE_TURN_USAGE_GROUP_BY,
): AdeTurnUsageSummaryRow[] {
  type Acc = AdeTurnUsageSummaryRow & { contexts: number[]; plan: Map<AgentChatPlanUsage["unit"], number> };
  const groups = new Map<string, Acc>();
  for (const row of records) {
    const model = groupBy === "provider" ? null : (row.servedModel ?? row.requestedModel ?? null);
    const accountKey = groupBy === "provider_account_model" ? row.accountKey : null;
    const key = `${row.provider}|${accountKey ?? ""}|${model ?? ""}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        provider: row.provider,
        accountKey,
        model,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cacheHitRatio: null,
        apiEquivalentUsd: 0,
        pricedTurns: 0,
        providerCostUsd: 0,
        planUsage: [],
        medianContextTokens: null,
        maxContextTokens: null,
        servedModelMismatches: 0,
        contexts: [],
        plan: new Map(),
      };
      groups.set(key, acc);
    }
    acc.turns += 1;
    acc.inputTokens += row.inputTokens ?? 0;
    acc.outputTokens += row.outputTokens ?? 0;
    acc.cacheReadTokens += row.cacheReadTokens ?? 0;
    acc.cacheWriteTokens += row.cacheWriteTokens ?? 0;
    acc.reasoningTokens += row.reasoningTokens ?? 0;
    if (row.apiEquivalentUsd != null) {
      acc.apiEquivalentUsd += row.apiEquivalentUsd;
      acc.pricedTurns += 1;
    }
    if (row.costUsd != null && row.costSource === "provider") acc.providerCostUsd += row.costUsd;
    for (const entry of row.planUsage ?? []) acc.plan.set(entry.unit, (acc.plan.get(entry.unit) ?? 0) + entry.amount);
    if (row.contextTokens != null && row.contextTokens > 0) acc.contexts.push(row.contextTokens);
    if (isServedModelMismatch(row.requestedModel, row.servedModel)) acc.servedModelMismatches += 1;
  }
  return [...groups.values()].map(({ contexts, plan, ...row }) => {
    const inputSide = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    return {
      ...row,
      apiEquivalentUsd: round6(row.apiEquivalentUsd),
      providerCostUsd: round6(row.providerCostUsd),
      cacheHitRatio: inputSide > 0 ? Math.round((row.cacheReadTokens / inputSide) * 10_000) / 10_000 : null,
      planUsage: [...plan.entries()].map(([unit, amount]) => ({ unit, amount: Math.round(amount * 10_000) / 10_000 })),
      medianContextTokens: median(contexts),
      maxContextTokens: contexts.length ? Math.max(...contexts) : null,
    };
  }).sort((a, b) => b.apiEquivalentUsd - a.apiEquivalentUsd || b.turns - a.turns);
}

function clampWhole(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function projectRootKey(root: string | null | undefined): string | null {
  const trimmedRoot = root?.trim();
  return trimmedRoot ? pathKey(path.resolve(trimmedRoot)) : null;
}

/**
 * `usage.getTurnUsageSummary`: ledger totals by provider, account, and model,
 * plus what one percent of each subscription window has cost. The totals and
 * burn rates are machine-wide, because accounts and quotas belong to the
 * machine. The `recent` rows are one project's when the caller names a
 * project root, so one project never reads another project's turns.
 */
export async function buildTurnUsageLedgerSummary(
  ledger: Pick<TurnUsageLedger, "store"> | null,
  args: GetTurnUsageSummaryArgs,
  nowMs: number,
  options: { projectRoot?: string | null } = {},
): Promise<AdeTurnUsageLedgerSummary> {
  const days = clampWhole(args.days || ADE_TURN_USAGE_DEFAULT_DAYS, 1, ADE_TURN_USAGE_MAX_DAYS, ADE_TURN_USAGE_DEFAULT_DAYS);
  const sinceMs = nowMs - days * DAY_MS;
  const groupBy = isAdeTurnUsageGroupBy(args.groupBy) ? args.groupBy : DEFAULT_ADE_TURN_USAGE_GROUP_BY;
  const base = { since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString(), groupBy };
  if (!ledger) return { ...base, available: false, turns: 0, rows: [], burnRates: [] };
  const burnSinceMs = nowMs - DEFAULT_BURN_LOOKBACK_MS;
  // One read covers both spans; each span is a filter over the rows in hand.
  const readSinceMs = Math.min(sinceMs, burnSinceMs);
  const [rowsRead, samples] = await Promise.all([
    ledger.store.readTurns({ sinceMs: readSinceMs }),
    ledger.store.readQuotaSamples({ sinceMs: burnSinceMs }),
  ]);
  const turnsSince = (startMs: number): AdeTurnUsageRecord[] => (startMs <= readSinceMs
    ? rowsRead
    : rowsRead.filter((row) => Date.parse(row.at) >= startMs));
  const turns = turnsSince(sinceMs);
  const burnTurns = turnsSince(burnSinceMs);
  const recentCount = clampWhole(args.recent, 0, ADE_TURN_USAGE_MAX_RECENT, 0);
  const scopeKey = projectRootKey(options.projectRoot);
  const recentRows = (): AdeTurnUsageRecord[] => {
    const pool = scopeKey ? turns.filter((row) => projectRootKey(row.projectRoot) === scopeKey) : turns;
    return pool.slice(-recentCount);
  };
  return {
    ...base,
    available: true,
    turns: turns.length,
    rows: summarizeTurnUsage(turns, groupBy),
    burnRates: estimateQuotaBurnRates({
      samples,
      turns: burnTurns,
      nowMs,
      lookbackMs: DEFAULT_BURN_LOOKBACK_MS,
    }),
    ...(recentCount > 0 ? { recent: recentRows() } : {}),
  };
}

// ---------------------------------------------------------------------------
// The ledger the brain holds
// ---------------------------------------------------------------------------

export type TurnUsageLedger = {
  readonly store: TurnUsageLedgerStore;
  /**
   * Folds a chat event into its open turn. `sessionModel` is the model the
   * session asks for right now; the ledger keeps the value it had when it
   * first saw the turn. Never throws.
   */
  observe(sessionId: string, event: AgentChatEvent, sessionModel?: string | null): void;
  /**
   * Writes the finished turn's row and returns it. Never throws. Null when the
   * turn was already settled or its row could not be built; a failed write
   * still returns the row, and the store logs the failure once.
   */
  settle(args: { session: TurnUsageSessionFacts; event: DoneEvent; projectRoot?: string | null }): AdeTurnUsageRecord | null;
  amend(key: string, source: AdeTurnUsageAmendment["source"], patch: AdeTurnUsageAmendment["patch"]): void;
  /** Writes the quota readings that changed since the last snapshot. Never throws. */
  observeQuotaSnapshot(snapshot: Pick<UsageSnapshot, "windows">): void;
  /**
   * When the session's next turn started, if this brain saw one start after
   * `afterMs`. Open and settled turns both count. A reconcile uses it to keep
   * one turn's window out of the next turn.
   */
  nextTurnStartAfter(sessionId: string, afterMs: number): number | null;
};

export function createTurnUsageLedger(args: {
  store: TurnUsageLedgerStore;
  logger?: Pick<Logger, "warn"> | null;
  nowMs?: () => number;
}): TurnUsageLedger {
  const now = args.nowMs ?? Date.now;
  const openTurns = new Map<string, TurnUsageObservation>();
  const settledKeys = new Set<string>();
  /** Session id to its recent turns' start times, by turn id. Both maps are least recently used first. */
  const turnStarts = new Map<string, Map<string, number>>();
  let lastSamples: Map<string, AdeQuotaSample> | null = null;
  let warnedSettle = false;

  const rememberTurnStart = (sessionId: string, turnId: string, startMs: number): void => {
    const starts = turnStarts.get(sessionId) ?? new Map<string, number>();
    turnStarts.delete(sessionId);
    turnStarts.set(sessionId, starts);
    evictOldestEntries(turnStarts, MAX_TURN_START_SESSIONS);
    if (starts.has(turnId)) return;
    starts.set(turnId, startMs);
    evictOldestEntries(starts, MAX_TURN_STARTS_PER_SESSION);
  };

  const seedLastSamples = (): Map<string, AdeQuotaSample> => {
    if (lastSamples) return lastSamples;
    lastSamples = new Map();
    // After a restart, the newest reading on disk is the baseline, so an
    // unchanged window is not written again.
    for (const sample of args.store.readQuotaSamplesSync({ sinceMs: now() - 35 * DAY_MS })) {
      lastSamples.set(quotaSampleKey(sample), sample);
    }
    return lastSamples;
  };

  return {
    store: args.store,
    observe(sessionId, event, sessionModel) {
      try {
        const observation = observeTurnEvent(openTurns, sessionId, event, now(), sessionModel ?? null);
        const turnId = toOptionalString((event as { turnId?: unknown }).turnId);
        if (observation && turnId) rememberTurnStart(sessionId, turnId, observation.firstSeenAtMs);
      } catch {
        // Observation is advisory; a malformed event must not reach the chat.
      }
    },
    settle({ session, event, projectRoot }) {
      const key = `${session.id}:${event.turnId}`;
      const observation = openTurns.get(key) ?? null;
      openTurns.delete(key);
      if (settledKeys.has(key)) return null;
      settledKeys.add(key);
      evictOldestSetEntries(settledKeys, MAX_SETTLED_KEYS);
      try {
        const nowMs = now();
        // A turn that sent no event before `done` started no later than now.
        rememberTurnStart(session.id, event.turnId, observation?.firstSeenAtMs ?? nowMs);
        const record = buildTurnUsageRecord({ session, event, observation, projectRoot, nowMs });
        args.store.appendTurn(record);
        return record;
      } catch (error) {
        if (!warnedSettle) {
          warnedSettle = true;
          args.logger?.warn("usage.turn_ledger_settle_failed", { error: getErrorMessage(error) });
        }
        return null;
      }
    },
    amend(key, source, patch) {
      args.store.amendTurn(key, source, patch);
    },
    observeQuotaSnapshot(snapshot) {
      try {
        const last = seedLastSamples();
        for (const sample of quotaSamplesFromSnapshot(snapshot, now())) {
          const key = quotaSampleKey(sample);
          if (!quotaSampleChanged(last.get(key), sample)) continue;
          last.set(key, sample);
          args.store.appendQuotaSample(sample);
        }
      } catch {
        // Quota history is advisory.
      }
    },
    nextTurnStartAfter(sessionId, afterMs) {
      let next: number | null = null;
      for (const startMs of turnStarts.get(sessionId)?.values() ?? []) {
        if (startMs > afterMs && (next == null || startMs < next)) next = startMs;
      }
      return next;
    },
  };
}

const sharedLedgers = new Map<string, TurnUsageLedger>();

/**
 * One ledger per ADE home: every project scope in a brain writes the same
 * files, because accounts and quotas belong to the machine.
 */
export function getSharedTurnUsageLedger(adeDir: string, logger?: Pick<Logger, "warn"> | null): TurnUsageLedger {
  const dir = path.join(path.resolve(adeDir), LEDGER_DIR_NAME);
  const existing = sharedLedgers.get(dir);
  if (existing) return existing;
  const ledger = createTurnUsageLedger({ store: createTurnUsageLedgerStore({ dir, logger }), logger });
  sharedLedgers.set(dir, ledger);
  return ledger;
}
