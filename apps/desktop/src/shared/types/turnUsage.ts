import type { AgentChatPlanUsage, AgentChatUsageAccount, AgentChatUsageConfidence } from "./chat";

// ---------------------------------------------------------------------------
// Per-turn usage ledger (machine-local; the router's input)
// ---------------------------------------------------------------------------

/**
 * One finished chat turn as the machine-local usage ledger records it.
 *
 * Token fields use one meaning for every provider: `inputTokens` is the
 * uncached input only, so input + cache read + cache write is the whole input
 * side. Codex reports input with the cached part inside it; the ledger takes
 * that part out before it writes the row.
 *
 * The ledger writes every field on every row. A field it could not learn is
 * null, never absent.
 */
export type AdeTurnUsageRecord = {
  v: 1;
  /** `<sessionId>:<turnId>`, the key an amendment names. */
  key: string;
  /** ISO time the turn finished. */
  at: string;
  /** ISO time ADE first saw an event for the turn, when it saw one. */
  startedAt: string | null;
  sessionId: string;
  turnId: string;
  projectRoot: string | null;
  laneId: string | null;
  surface: string | null;
  /** Set on a chat that another chat spawned (a delegated worker). */
  parentSessionId: string | null;
  provider: string;
  status: "completed" | "interrupted" | "failed";
  /** The model the session asked for (its model id, else its model token). */
  requestedModel: string | null;
  /** The model that answered, when the runtime or a later reconcile reports it. */
  servedModel: string | null;
  reasoningEffort: string | null;
  account: AgentChatUsageAccount | null;
  /**
   * Join key for `UsageAccount.id` in a usage snapshot: `<provider>:<instanceId>`,
   * else `<provider>:<email>`, else `<provider>:local` (see `usageAccountId`).
   * Always set: a turn with no account identity gets `<provider>:local`.
   */
  accountKey: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  /** Input side of the turn's last request: what the next request starts from. */
  contextTokens: number | null;
  contextWindow: number | null;
  requestCount: number | null;
  /** Tokens that the turn's subagents and helper agents reported. Not in the fields above. */
  subagentTokens: number | null;
  /** The provider's own bill for the turn, or ADE's list-price figure (see `costSource`). */
  costUsd: number | null;
  costSource: "provider" | "list_price" | null;
  /**
   * The turn priced at the served model's public API list price, whatever the
   * account pays. This is the one currency that compares a subscription turn
   * with an API-key turn. Null when models.dev has no list price for the model.
   */
  apiEquivalentUsd: number | null;
  planUsage: AgentChatPlanUsage[] | null;
  /**
   * Factory credits that the Droid session had used when this turn ended.
   * The turn writes null; a later Factory amendment fills it in.
   */
  factoryCreditsSessionTotal: number | null;
  usageConfidence: AgentChatUsageConfidence | null;
  durationMs: number | null;
  /**
   * Context compactions the provider finished during the turn (a
   * `context_compact` that is not `started`, or a completed
   * `codex_context_compaction`), counted once per compaction id. A row written
   * before this field existed reads back as 0.
   */
  compactions: number;
};

/** A later correction to a ledger row, written as its own line. */
export type AdeTurnUsageAmendment = {
  v: 1;
  amend: string;
  at: string;
  source: "cursor_dashboard" | "factory_sessions";
  patch: Partial<Omit<AdeTurnUsageRecord, "v" | "key" | "sessionId" | "turnId">>;
};

/** One quota reading, written only when the percent or the reset time changes. */
export type AdeQuotaSample = {
  v: 1;
  at: string;
  provider: string;
  /** `UsageWindow.accountId`, or `<provider>:local` when the host sent none. */
  accountId: string;
  windowType: string;
  percentUsed: number;
  resetsAt: string;
};

/** Totals for one group of ledger rows (for example one provider and model). */
export type AdeTurnUsageSummaryRow = {
  provider: string;
  /** Null unless the summary groups by account. */
  accountKey: string | null;
  model: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** cache read / (input + cache read + cache write), or null with no input side. */
  cacheHitRatio: number | null;
  apiEquivalentUsd: number;
  /** Turns that had an API list price. */
  pricedTurns: number;
  providerCostUsd: number;
  planUsage: AgentChatPlanUsage[];
  medianContextTokens: number | null;
  maxContextTokens: number | null;
  /** Turns where the served model differs from the requested model. */
  servedModelMismatches: number;
};

/**
 * What one percent of a subscription window cost, learned from the quota
 * readings and the ledger rows between them.
 *
 * The ledger sees ADE turns only. Other clients on the same login (a terminal
 * Claude Code, the Cursor IDE) also move the percent, so `usdPerPercent` is a
 * lower bound. That is the safe side for headroom: the true headroom is at
 * least `headroomUsd`.
 */
export type AdeQuotaBurnRate = {
  provider: string;
  accountId: string;
  windowType: string;
  /** API-equivalent dollars of ADE turns for each percent the window moved. */
  usdPerPercent: number | null;
  turnsPerPercent: number | null;
  /** Percent points that the estimate covers. */
  observedPercent: number;
  observedUsd: number;
  observedTurns: number;
  latestPercentUsed: number | null;
  latestResetsAt: string | null;
  headroomUsd: number | null;
  confidence: "none" | "low" | "medium" | "high";
};

/** How `usage.getTurnUsageSummary` groups ledger rows. The CLI, the service, and the action contract read this list. */
export const ADE_TURN_USAGE_GROUP_BY = ["provider", "provider_model", "provider_account_model"] as const;

export type AdeTurnUsageGroupBy = (typeof ADE_TURN_USAGE_GROUP_BY)[number];

/** The grouping a summary uses when the caller names none. */
export const DEFAULT_ADE_TURN_USAGE_GROUP_BY: AdeTurnUsageGroupBy = "provider_account_model";

/** The most days of ledger one summary reads. */
export const ADE_TURN_USAGE_MAX_DAYS = 90;
/** The days of ledger a summary reads when the caller names none. */
export const ADE_TURN_USAGE_DEFAULT_DAYS = 7;
/** The most newest rows one summary returns in `recent`. */
export const ADE_TURN_USAGE_MAX_RECENT = 200;

export function isAdeTurnUsageGroupBy(value: unknown): value is AdeTurnUsageGroupBy {
  return typeof value === "string" && (ADE_TURN_USAGE_GROUP_BY as readonly string[]).includes(value);
}

export type GetTurnUsageSummaryArgs = {
  /** Days of ledger to read, 1 to `ADE_TURN_USAGE_MAX_DAYS`. Defaults to `ADE_TURN_USAGE_DEFAULT_DAYS`. */
  days?: number;
  /** Defaults to `DEFAULT_ADE_TURN_USAGE_GROUP_BY`. */
  groupBy?: AdeTurnUsageGroupBy;
  /**
   * Also return up to this many of the newest rows (max `ADE_TURN_USAGE_MAX_RECENT`).
   * A project scope returns only its own project's rows; the totals stay machine-wide.
   */
  recent?: number;
};

/** `usage.getTurnUsageSummary`: the router's view of what this machine's turns cost. */
export type AdeTurnUsageLedgerSummary = {
  /** False when this host keeps no ledger (an in-process test host, an older brain). */
  available: boolean;
  since: string;
  until: string;
  turns: number;
  groupBy: AdeTurnUsageGroupBy;
  rows: AdeTurnUsageSummaryRow[];
  burnRates: AdeQuotaBurnRate[];
  recent?: AdeTurnUsageRecord[];
};
