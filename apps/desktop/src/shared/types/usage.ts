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

export type UsageMissionBreakdown = {
  missionId: string;
  missionTitle: string;
  totalTokens: number;
  costEstimateUsd: number;
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
  missionBreakdown: UsageMissionBreakdown[];
};

export type GetAggregatedUsageArgs = {
  since?: string | null;
  limit?: number;
  missionId?: string | null;
};

// ---------------------------------------------------------------------------
// Live usage tracking types (Claude + Codex provider polling)
// ---------------------------------------------------------------------------

export type UsageProvider = "claude" | "codex";

export type UsageWindowType = "five_hour" | "weekly" | "weekly_oauth_apps" | "weekly_cowork";

export type UsageWindow = {
  provider: UsageProvider;
  windowType: UsageWindowType;
  modelBreakdown?: Record<string, number>;
  percentUsed: number;
  resetsAt: string;
  resetsInMs: number;
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
  /** Projected usage % at end of the weekly window */
  projectedWeeklyPercent: number;
  /** % of the weekly window that has elapsed */
  weekElapsedPercent: number;
  /** Expected usage % at this point if usage were perfectly linear */
  expectedPercent: number;
  /** Actual - expected (positive = using faster than pace) */
  deltaPercent: number;
  /** Hours until 100% at current rate, null if rate is ~0 */
  etaHours: number | null;
  /** Whether current rate will last until the weekly reset */
  willLastToReset: boolean;
  /** Hours until the weekly window resets */
  resetsInHours: number;
};

export type CostSnapshot = {
  provider: UsageProvider;
  last30dCostUsd: number;
  todayCostUsd: number;
  tokenBreakdown: Record<string, { input: number; output: number; cached: number }>;
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
  costs: CostSnapshot[];
  extraUsage: ExtraUsage[];
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
