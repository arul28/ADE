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

export type AdeUsageRangePreset = "today" | "7d" | "30d" | "all";

export type GetAdeUsageStatsArgs = {
  preset?: AdeUsageRangePreset;
  since?: string | null;
  until?: string | null;
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

export type AdeUsageDailyPoint = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  commits: number;
  prs: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  sessions: number;
};

export type AdeUsageStats = {
  generatedAt: string;
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
  };
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
  adeProviders?: AdeUsageProviderSummary[];
  adeModels?: AdeUsageModelSummary[];
  agentProviders?: AdeUsageAgentProviderSummary[];
  agentModels?: AdeUsageAgentModelSummary[];
  features?: AdeUsageFeatureSummary[];
  lanes?: AdeUsageLaneSummary[];
  activities?: AdeUsageActivitySummary[];
  daily: AdeUsageDailyPoint[];
  github: {
    repo: string | null;
    available: boolean;
    lastFetchedAt: string | null;
    error: string | null;
  };
  sourceNotes?: string[];
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
};

export type ExtraUsage = {
  provider: UsageProvider;
  isEnabled: boolean;
  usedCreditsUsd: number;
  monthlyLimitUsd: number;
  utilization: number | null;
  currency: string;
};

export type UsageSnapshot = {
  windows: UsageWindow[];
  pacing: UsagePacing;
  pacingByProvider?: UsagePacingByProvider;
  costs: CostSnapshot[];
  /** Local runtime usage that can be attributed specifically to ADE-originated sessions. */
  adeCosts?: CostSnapshot[];
  extraUsage: ExtraUsage[];
  /** Per-provider daily token usage for the last 7 calendar days, oldest first. */
  dailyUsage7d?: Partial<Record<UsageProvider, number[]>>;
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
