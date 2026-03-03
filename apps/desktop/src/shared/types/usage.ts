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
