import type {
  SmartBudgetConfig,
  BudgetPressureSnapshot,
  BudgetPressureLevel,
  BudgetSteeringAction
} from "../../../shared/types";

/**
 * Computes the current budget pressure for a mission based on
 * actual spend vs configured thresholds.
 */
export function computeBudgetPressure(
  config: SmartBudgetConfig,
  currentFiveHourSpendUsd: number,
  currentWeeklySpendUsd: number
): BudgetPressureSnapshot {
  if (!config.enabled) {
    return {
      level: "none",
      fiveHourSpendUsd: currentFiveHourSpendUsd,
      weeklySpendUsd: currentWeeklySpendUsd,
      fiveHourThresholdUsd: config.fiveHourThresholdUsd,
      weeklyThresholdUsd: config.weeklyThresholdUsd,
      fiveHourPct: 0,
      weeklyPct: 0,
      activeActions: [],
      message: "Smart budget disabled."
    };
  }

  const fiveHourPct = config.fiveHourThresholdUsd > 0
    ? (currentFiveHourSpendUsd / config.fiveHourThresholdUsd) * 100
    : 0;
  const weeklyPct = config.weeklyThresholdUsd > 0
    ? (currentWeeklySpendUsd / config.weeklyThresholdUsd) * 100
    : 0;

  const maxPct = Math.max(fiveHourPct, weeklyPct);

  let level: BudgetPressureLevel;
  const actions: BudgetSteeringAction[] = [];
  let message: string;

  if (maxPct >= 100) {
    level = "exceeded";
    // Budget pressure emits advisories; orchestrator AI decides execution changes.
    actions.push(
      "downgrade_models",
      "inject_conciseness",
      "warn_workers",
      "switch_provider"
    );
    message = `Budget exceeded (${maxPct.toFixed(0)}% of threshold). All cost reduction measures active.`;
  } else if (maxPct >= 75) {
    level = "approaching";
    // Apply moderate actions
    actions.push("downgrade_models", "inject_conciseness", "warn_workers");
    message = `Approaching budget limit (${maxPct.toFixed(0)}% of threshold). Cost reduction active.`;
  } else {
    level = "none";
    message = `Budget healthy (${maxPct.toFixed(0)}% of threshold).`;
  }

  return {
    level,
    fiveHourSpendUsd: currentFiveHourSpendUsd,
    weeklySpendUsd: currentWeeklySpendUsd,
    fiveHourThresholdUsd: config.fiveHourThresholdUsd,
    weeklyThresholdUsd: config.weeklyThresholdUsd,
    fiveHourPct,
    weeklyPct,
    activeActions: actions,
    message
  };
}

/**
 * Generates a conciseness directive string for injection into worker prompts
 * when budget pressure is active.
 */
export function generateBudgetDirective(pressure: BudgetPressureSnapshot): string | null {
  if (pressure.level === "none") return null;

  const parts: string[] = [];

  if (pressure.activeActions.includes("inject_conciseness")) {
    parts.push("Be concise in your responses and tool usage. Minimize unnecessary exploration.");
  }

  if (pressure.activeActions.includes("downgrade_models")) {
    parts.push("Prefer efficient approaches over thorough ones. Skip optional analysis.");
  }

  if (pressure.activeActions.includes("skip_optional_phases")) {
    parts.push("Skip optional validation and review steps where possible.");
  }

  if (pressure.level === "exceeded") {
    parts.push(`Token budget is ${pressure.fiveHourPct.toFixed(0)}% of the 5-hour limit. Work efficiently.`);
  } else {
    parts.push(`Token budget is at ${Math.max(pressure.fiveHourPct, pressure.weeklyPct).toFixed(0)}% of limit. Be mindful of token usage.`);
  }

  return parts.join(" ");
}

/**
 * Given budget pressure, determine which optional phases should be skipped.
 */
export function getSkippablePhases(pressure: BudgetPressureSnapshot): string[] {
  void pressure;
  // Optional phase skipping is now AI-directed at runtime via transition/recovery decisions.
  return [];
}

/**
 * Given budget pressure, return the max parallelism factor.
 * Parallelism is now AI-directed; this helper keeps a neutral multiplier.
 */
export function getParallelismFactor(pressure: BudgetPressureSnapshot): number {
  void pressure;
  return 1.0;
}
