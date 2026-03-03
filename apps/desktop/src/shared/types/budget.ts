// ---------------------------------------------------------------------------
// Budget types
// ---------------------------------------------------------------------------

import type { ModelProvider } from "./models";

/** Smart token budget configuration */
export type SmartBudgetConfig = {
  enabled: boolean;
  /** Cost threshold (USD) for 5-hour window before steering kicks in */
  fiveHourThresholdUsd: number;
  /** Cost threshold (USD) for weekly window before steering kicks in */
  weeklyThresholdUsd: number;
  /** Current 5-hour spend (populated at runtime, not persisted) */
  currentFiveHourSpendUsd?: number;
  /** Current weekly spend (populated at runtime, not persisted) */
  currentWeeklySpendUsd?: number;
  /** Per-provider tier ceilings (user-set, keyed by ModelProvider) */
  providerLimits?: Partial<Record<ModelProvider, import("./models").ProviderBudgetLimits>>;
  /** Hard stop: pause mission at this % of 5-hour limit (e.g. 80 = 80%) */
  fiveHourHardStopPercent?: number;
  /** Hard stop: pause mission at this % of weekly limit (e.g. 95 = 95%) */
  weeklyHardStopPercent?: number;
  /** Hard stop: max API-key spend in USD before pausing */
  apiKeyMaxSpendUsd?: number;
};

export type MissionBudgetPressure = "normal" | "warning" | "critical";

export type MissionBudgetScopeSnapshot = {
  maxTokens?: number | null;
  maxTimeMs?: number | null;
  maxCostUsd?: number | null;
  usedTokens: number;
  usedTimeMs: number;
  usedCostUsd: number;
  remainingTokens?: number | null;
  remainingTimeMs?: number | null;
  remainingCostUsd?: number | null;
};

export type MissionPhaseBudgetSnapshot = MissionBudgetScopeSnapshot & {
  phaseKey: string;
  phaseName: string;
  stepCount: number;
};

export type MissionWorkerBudgetSnapshot = MissionBudgetScopeSnapshot & {
  stepId: string;
  stepKey: string;
  title: string;
  phaseKey: string;
  phaseName: string;
};

export type MissionBudgetProviderWindow = {
  usedTokens: number;
  limitTokens: number | null;
  usedPct: number | null;
  usedCostUsd: number;
  timeUntilResetMs: number | null;
};

export type MissionBudgetProviderSnapshot = {
  provider: string;
  fiveHour: MissionBudgetProviderWindow;
  weekly: MissionBudgetProviderWindow;
};

export type MissionBudgetHardCapStatus = {
  fiveHourHardStopPercent: number | null;
  weeklyHardStopPercent: number | null;
  apiKeyMaxSpendUsd: number | null;
  apiKeySpentUsd: number;
  fiveHourTriggered: boolean;
  weeklyTriggered: boolean;
  apiKeyTriggered: boolean;
};

export type MissionBudgetRateLimit = {
  provider: string;
  remainingTokens: number | null;
  resetAt: string | null;
  source: "runtime" | "claude-local" | "unknown";
};

export type MissionBudgetSnapshot = {
  missionId: string;
  runId: string | null;
  computedAt: string;
  mode: "subscription" | "api-key";
  pressure: MissionBudgetPressure;
  mission: MissionBudgetScopeSnapshot;
  perPhase: MissionPhaseBudgetSnapshot[];
  perWorker: MissionWorkerBudgetSnapshot[];
  perProvider: MissionBudgetProviderSnapshot[];
  hardCaps: MissionBudgetHardCapStatus;
  activeWorkers: number;
  recommendation: string;
  estimatedRemainingCapacity: {
    steps: number | null;
    durationMs: number | null;
  };
  rateLimits: MissionBudgetRateLimit[];
  dataSources: string[];
};

export type GetMissionBudgetStatusArgs = {
  missionId: string;
  runId?: string | null;
};
