// ---------------------------------------------------------------------------
// Usage dashboard types
// ---------------------------------------------------------------------------

export type UsageModelBreakdown = {
  provider: string;
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costEstimateUsd: number;
};

export type UsageRecentSession = {
  id: string;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
  timestamp: string;
};

export type UsageActiveSession = {
  id: string;
  feature: string;
  provider: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
};

export type AggregatedUsageStats = {
  summary: {
    totalSessions: number;
    activeSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    totalCostEstimateUsd: number;
  };
  byModel: UsageModelBreakdown[];
  recentSessions: UsageRecentSession[];
  activeSessions: UsageActiveSession[];
};

export type GetAggregatedUsageArgs = {
  since?: string | null;
  limit?: number;
};

export const ADE_USAGE_RANGE_PRESETS = ["today", "7d", "30d", "year", "all"] as const;

export type AdeUsageRangePreset = (typeof ADE_USAGE_RANGE_PRESETS)[number];

export function isAdeUsageRangePreset(value: unknown): value is AdeUsageRangePreset {
  return typeof value === "string"
    && (ADE_USAGE_RANGE_PRESETS as readonly string[]).includes(value);
}

export type AdeUsageClientSurface = "desktop" | "mobile" | "tui" | "web" | "api";

/**
 * Scope of provider-ledger metrics.
 * - `machine` — every session found in the provider's local ledgers (codeburn-comparable).
 * - `project` — only sessions attributable to the current project root (cwd match).
 * GitHub and ADE-DB metrics are always project/repo scoped regardless of this value.
 */
export const ADE_USAGE_SCOPES = ["machine", "project"] as const;

export type AdeUsageScope = (typeof ADE_USAGE_SCOPES)[number];

export function isAdeUsageScope(value: unknown): value is AdeUsageScope {
  return typeof value === "string" && (ADE_USAGE_SCOPES as readonly string[]).includes(value);
}

/**
 * How a provider's token counts were obtained.
 * - `exact` — provider-recorded token counts.
 * - `chars` — estimated from character length (chars/4).
 * - `distribution` — real session totals spread across calls/days (per-day values synthetic).
 * - `mixed` — some entries exact, some estimated.
 */
export type AdeUsageEstimationKind = "exact" | "chars" | "distribution" | "mixed";

export type GetAdeUsageStatsArgs = {
  preset?: AdeUsageRangePreset;
  since?: string | null;
  until?: string | null;
  /** Defaults to "machine" (legacy behavior). */
  scope?: AdeUsageScope;
};

export type AdeUsageProviderSummary = {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  rangeCostUsd: number;
  todayCostUsd: number;
  last30dCostUsd: number;
  /** Omitted/`exact` when counts are provider-recorded. */
  estimation?: AdeUsageEstimationKind;
  /** False when this provider's ledger cannot be filtered to a project (machine-only). */
  scopeSupported?: boolean;
  /** Tokens attributed to ADE-originated sessions (subset of totalTokens). */
  adeOriginatedTokens?: number;
  /** Tokens from sessions launched outside ADE (subset of totalTokens). */
  externalTokens?: number;
};

export type AdeUsageModelSummary = {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type AdeUsageAgentProviderSummary = {
  provider: string;
  sessions: number;
  models: number;
  latestAt: string | null;
};

export type AdeUsageAgentModelSummary = {
  provider: string;
  model: string;
  sessions: number;
  latestAt: string | null;
};

export type AdeUsageFeatureSummary = {
  feature: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  successRate: number;
};

export type AdeUsageLaneSummary = {
  laneId: string;
  laneName: string;
  sessions: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type AdeUsageActivitySummary = {
  kind: string;
  count: number;
};

export type AdeUsageClientSummary = {
  client: AdeUsageClientSurface;
  interactions: number;
  activeDays: number;
  sessions: number;
  lastActiveAt: string | null;
};

export type AdeUsageDailyPoint = {
  /** Local calendar day (YYYY-MM-DD in the machine's timezone). */
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cache-read tokens for the day (provider ledgers). */
  cachedTokens?: number;
  /** Local (ADE DB / git operations) measures — never merged with GitHub values. */
  commits: number;
  prs: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  sessions: number;
  durationMs?: number;
  interactions?: number;
  clients?: Partial<Record<AdeUsageClientSurface, number>>;
  /** GitHub-reported measures for the same day, kept separate from local ones. */
  githubCommits?: number;
  githubPrs?: number;
  githubAdditions?: number;
  githubDeletions?: number;
};

/** GitHub-scoped activity, reported separately from local activity (never max-merged). */
export type AdeUsageGithubActivity = {
  commits: number;
  prsTracked: number;
  prsOpen: number;
  prsMerged: number;
  prsClosed: number;
  prAdditions: number;
  prDeletions: number;
};

/** Current-project ADE DB / git-operation activity, reported separately from GitHub. */
export type AdeUsageLocalActivity = {
  commits: number;
  pushOperations: number;
  prLandings: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type AdeUsageStats = {
  generatedAt: string;
  /** Scope the provider-ledger metrics were computed at. Absent = machine (legacy hosts). */
  scope?: AdeUsageScope;
  range: {
    preset: AdeUsageRangePreset;
    since: string | null;
    until: string;
  };
  summary: {
    totalTokens: number;
    tokenTotalSource: "provider_logs" | "ade_db" | "combined";
    observedProviderTokens: number;
    observedProviderInputTokens: number;
    observedProviderOutputTokens: number;
    observedProviderCachedTokens: number;
    observedProviderCostRangeUsd: number;
    observedProviderCost30dUsd: number;
    observedProviderCostTodayUsd: number;
    adeRuntimeTokens?: number;
    adeRuntimeInputTokens?: number;
    adeRuntimeOutputTokens?: number;
    adeRuntimeCachedTokens?: number;
    adeRuntimeCostRangeUsd?: number;
    adeRuntimeCost30dUsd?: number;
    adeRuntimeCostTodayUsd?: number;
    adeTotalTokens?: number;
    adeTotalCostRangeUsd?: number;
    trackedAdeTokens?: number;
    trackedAdeInputTokens?: number;
    trackedAdeOutputTokens?: number;
    trackedAdeCalls?: number;
    trackedAdeDurationMs?: number;
    workerTokens?: number;
    workerCostUsd?: number;
    chatSessions?: number;
    terminalSessions?: number;
    activeLanes?: number;
    lanesCreated?: number;
    lanesArchived?: number;
    lanesDeleted?: number;
    commitsCreated: number;
    pushOperations: number;
    prLandings: number;
    prsTracked: number;
    prsOpen: number;
    prsMerged: number;
    prsClosed: number;
    prAdditions: number;
    prDeletions: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
    artifactsCaptured?: number;
    automationRuns?: number;
    workerRuns?: number;
    totalInteractions?: number;
    activeDays?: number;
    currentStreakDays?: number;
    longestStreakDays?: number;
    longestSessionMs?: number;
  };
  /**
   * GitHub vs local activity as separate labeled groups. When present, the UI
   * must prefer these over the legacy max-merged summary fields.
   */
  githubActivity?: AdeUsageGithubActivity;
  localActivity?: AdeUsageLocalActivity;
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
  adeProviders?: AdeUsageProviderSummary[];
  adeModels?: AdeUsageModelSummary[];
  agentProviders?: AdeUsageAgentProviderSummary[];
  agentModels?: AdeUsageAgentModelSummary[];
  features?: AdeUsageFeatureSummary[];
  lanes?: AdeUsageLaneSummary[];
  activities?: AdeUsageActivitySummary[];
  clients?: AdeUsageClientSummary[];
  daily: AdeUsageDailyPoint[];
  github: {
    repo: string | null;
    available: boolean;
    lastFetchedAt: string | null;
    error: string | null;
  };
  sourceNotes?: string[];
  freshness?: {
    state: "fresh" | "refreshing" | "stale";
    providerUpdatedAt: string | null;
    githubUpdatedAt: string | null;
  };
};

// ---------------------------------------------------------------------------
// Live quota tracking types (Claude/Codex API windows plus local runtime cost scans)
// ---------------------------------------------------------------------------

export type UsageProvider = "claude" | "codex" | "cursor";

export type UsageWindowType = "five_hour" | "weekly" | "monthly" | "weekly_oauth_apps" | "weekly_cowork";

export type UsageWindow = {
  provider: UsageProvider;
  windowType: UsageWindowType;
  modelBreakdown?: Record<string, number>;
  percentUsed: number;
  resetsAt: string;
  resetsInMs: number;
  windowDurationMs?: number;
  /** Pace of this specific window (ahead/behind a steady burn). Computed per-window. */
  pacing?: UsagePacing;
};

export type UsagePacingStatus =
  | "far-behind"
  | "behind"
  | "slightly-behind"
  | "on-track"
  | "slightly-ahead"
  | "ahead"
  | "far-ahead";

export type UsagePacing = {
  status: UsagePacingStatus;
  /** Projected usage % at the end of the tracked quota window. */
  projectedWeeklyPercent: number;
  /** % of the tracked quota window that has elapsed. */
  weekElapsedPercent: number;
  /** Expected usage % at this point if usage were perfectly linear */
  expectedPercent: number;
  /** Actual - expected (positive = using faster than pace) */
  deltaPercent: number;
  /** Hours until 100% at current rate, null if rate is ~0 */
  etaHours: number | null;
  /** Whether current rate will last until the tracked reset */
  willLastToReset: boolean;
  /** Hours until the tracked window resets */
  resetsInHours: number;
};

export type UsagePacingByProvider = Partial<Record<UsageProvider, UsagePacing>>;

/**
 * Per-provider freshness/health for the most recent poll. Lets the UI keep
 * showing last-good numbers while signalling a quiet retry, instead of wiping
 * data and surfacing a raw error string.
 *
 * - `ok`       — this poll returned fresh windows.
 * - `stale`    — this poll failed, but we are still showing carried-forward data.
 * - `unauthed` — no credentials for this provider (sign-in required).
 * - `error`    — this poll failed and there is no prior data to fall back to.
 */
export type UsageProviderState = "ok" | "stale" | "unauthed" | "error";

export type UsageProviderSource = "oauth" | "http" | "cli";

export type UsageProviderErrorKind =
  | "auth"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unavailable"
  | "unknown";

export type UsageProviderStatus = {
  state: UsageProviderState;
  /** ISO timestamp of the last poll that returned real windows, if any. */
  lastSuccessAt: string | null;
  /** Provider source that produced the displayed windows. */
  source?: UsageProviderSource;
  /** ISO timestamp of the data currently being displayed. */
  updatedAt?: string | null;
  /** ISO timestamp of the most recent attempted refresh. */
  lastAttemptAt?: string | null;
  /** Typed failure classification for stale/error/unauthed states. */
  errorKind?: UsageProviderErrorKind;
  /** ISO timestamp before which automatic refresh should remain backed off. */
  nextRetryAt?: string | null;
  /** Friendly, log-free reason for a non-ok state (e.g. "Couldn't reach Claude"). */
  message?: string;
};

export type UsageProviderStatusMap = Partial<Record<UsageProvider, UsageProviderStatus>>;

export type CostTokenBreakdown = {
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
  costUsd?: number;
};

export type CostSnapshot = {
  provider: string;
  last30dCostUsd: number;
  todayCostUsd: number;
  costUsdByPreset?: Partial<Record<AdeUsageRangePreset, number>>;
  tokenBreakdown: Record<string, CostTokenBreakdown>;
  tokenBreakdownByPreset?: Partial<Record<AdeUsageRangePreset, Record<string, CostTokenBreakdown>>>;
  dailyTokenBreakdownByPreset?: Partial<Record<AdeUsageRangePreset, Record<string, Record<string, CostTokenBreakdown>>>>;
  dailyTokensByPreset?: Partial<Record<AdeUsageRangePreset, Record<string, number>>>;
  /** How this provider's token counts were obtained. Omitted = exact. */
  estimation?: AdeUsageEstimationKind;
  /** False when this ledger cannot be filtered to a project scope. */
  scopeSupported?: boolean;
  /** Tokens attributed to ADE-originated sessions, by preset. */
  adeOriginatedTokensByPreset?: Partial<Record<AdeUsageRangePreset, number>>;
};

export type ExtraUsage = {
  provider: UsageProvider;
  isEnabled: boolean;
  usedCreditsUsd: number;
  monthlyLimitUsd: number;
  utilization: number | null;
  currency: string;
};

export type UsageProviderMessage = {
  provider: UsageProvider;
  id: string;
  kind: "headline" | "announcement" | "unknown";
  message: string;
  createdAt?: string | null;
};

export type UsageSnapshot = {
  windows: UsageWindow[];
  pacing: UsagePacing;
  pacingByProvider?: UsagePacingByProvider;
  /** Per-provider freshness/health for the latest poll (drives quiet-retry UI). */
  providerStatus?: UsageProviderStatusMap;
  providerMessages?: UsageProviderMessage[];
  costs: CostSnapshot[];
  /** Local runtime usage that can be attributed specifically to ADE-originated sessions. */
  adeCosts?: CostSnapshot[];
  extraUsage: ExtraUsage[];
  /** Per-provider daily token usage for the last 7 calendar days, oldest first. */
  dailyUsage7d?: Partial<Record<UsageProvider, number[]>>;
  /** ISO timestamp of the last poll that included local cost/history scans. */
  costsLastPolledAt?: string;
  lastPolledAt: string;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Budget cap types for shared automation usage enforcement
// ---------------------------------------------------------------------------

export type BudgetCapScope =
  | "global"
  | "automation-rule";

export type BudgetCapType =
  | "weekly-percent"
  | "five-hour-percent"
  | "usd-per-run"
  | "usd-per-day";

export type BudgetCapAction = "pause" | "warn" | "block";

export type BudgetCapProvider = "claude" | "codex" | "any";

export type BudgetCap = {
  id: string;
  scope: BudgetCapScope;
  scopeId?: string;
  capType: BudgetCapType;
  provider: BudgetCapProvider;
  limit: number;
  action: BudgetCapAction;
};

export type BudgetCheckResult = {
  allowed: boolean;
  reason?: string;
  remainingPercent?: number;
  remainingUsd?: number;
  warnings: string[];
};

export type BudgetCheckContext = {
  /** Usage records for `usd-per-run` are keyed to the active run, not the rule. */
  runScopeId?: string | null;
};

export type BudgetCheckArgs = {
  scope: BudgetCapScope;
  scopeId?: string;
  provider: BudgetCapProvider;
  runScopeId?: string | null;
};

export type BudgetUsageRecord = {
  id: string;
  scope: BudgetCapScope;
  scopeId: string;
  provider: string;
  tokensUsed: number;
  costUsd: number;
  weekKey: string;
  recordedAt: string;
};

export type BudgetPreset = "conservative" | "maximize" | "fixed";

export type BudgetCapConfig = {
  refreshIntervalMin?: number;
  budgetCaps?: Array<{
    scope: BudgetCapScope;
    scopeId?: string;
    capType: BudgetCapType;
    provider: BudgetCapProvider;
    limit: number;
    action: BudgetCapAction;
  }>;
  alertAtWeeklyPercent?: number;
  preset?: BudgetPreset;
};
