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

export type UsageWindowType = "five_hour" | "weekly";

export type UsageWindow = {
  provider: UsageProvider;
  windowType: UsageWindowType;
  modelBreakdown?: Record<string, number>;
  percentUsed: number;
  resetsAt: string;
  resetsInMs: number;
};

export type UsagePacingStatus = "on-track" | "ahead" | "behind";

export type UsagePacing = {
  status: UsagePacingStatus;
  projectedWeeklyPercent: number;
  weekElapsedPercent: number;
};

export type CostSnapshot = {
  provider: UsageProvider;
  last30dCostUsd: number;
  todayCostUsd: number;
  tokenBreakdown: Record<string, { input: number; output: number; cached: number }>;
};

export type UsageSnapshot = {
  windows: UsageWindow[];
  pacing: UsagePacing;
  costs: CostSnapshot[];
  lastPolledAt: string;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Budget cap types (automation + Night Shift enforcement)
// ---------------------------------------------------------------------------

export type BudgetCapScope =
  | "global"
  | "automation-rule"
  | "night-shift-run"
  | "night-shift-global";

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
  nightShiftReservePercent?: number;
  alertAtWeeklyPercent?: number;
  preset?: BudgetPreset;
};
