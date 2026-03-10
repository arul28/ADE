// ---------------------------------------------------------------------------
// Adaptive Runtime — classifyTaskComplexity, parallelism scaling, model downgrade
// ---------------------------------------------------------------------------

import type {
  TeamComplexityAssessment,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// Task Complexity Classification
// ---------------------------------------------------------------------------

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex";

/**
 * Classifies a task description into a complexity bucket based on heuristics.
 * Used to scale parallelism caps and budget allocation.
 *
 * VAL-ENH-001: classifyTaskComplexity returns correct complexity for representative inputs.
 */
export function classifyTaskComplexity(description: string): TaskComplexity {
  const text = (description ?? "").trim().toLowerCase();
  if (!text.length) return "trivial";

  // Word count as primary signal
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Complexity indicators
  const complexIndicators = [
    "parallel", "concurrent", "multi-service", "microservice", "distributed",
    "migration", "refactor entire", "rewrite", "overhaul", "architecture",
    "cross-cutting", "end-to-end", "full-stack", "multiple teams",
    "database migration", "schema redesign", "api redesign",
  ];
  const moderateIndicators = [
    "integrate", "test suite", "component", "service", "endpoint",
    "feature", "module", "api", "database", "auth", "workflow",
    "deployment", "ci/cd", "pipeline", "refactor",
  ];
  const simpleIndicators = [
    "fix bug", "update", "rename", "change", "add field",
    "modify", "adjust", "tweak", "patch", "bump",
  ];
  const trivialIndicators = [
    "typo", "comment", "formatting", "whitespace", "lint",
    "readme", "docs", "changelog", "version bump",
  ];

  const hasComplexSignals = complexIndicators.some((ind) => text.includes(ind));
  const hasModerateSignals = moderateIndicators.some((ind) => text.includes(ind));
  const hasSimpleSignals = simpleIndicators.some((ind) => text.includes(ind));
  const hasTrivialSignals = trivialIndicators.some((ind) => text.includes(ind));

  // Multiple file mentions suggest higher complexity
  const fileRefs = (text.match(/\b\w+\.\w{1,5}\b/g) ?? []).length;

  // Scoring
  if (hasTrivialSignals && wordCount < 20 && !hasModerateSignals && !hasComplexSignals) {
    return "trivial";
  }
  if (hasComplexSignals || (wordCount > 200 && hasModerateSignals) || fileRefs > 10) {
    return "complex";
  }
  if (hasModerateSignals || wordCount > 80 || fileRefs > 4) {
    return "moderate";
  }
  if (hasSimpleSignals || wordCount < 40) {
    return "simple";
  }

  // Default based on word count
  if (wordCount > 120) return "complex";
  if (wordCount > 60) return "moderate";
  if (wordCount > 20) return "simple";
  return "trivial";
}

// ---------------------------------------------------------------------------
// Parallelism Cap Scaling
// ---------------------------------------------------------------------------

/**
 * Determines the parallelism cap based on estimated scope from TeamComplexityAssessment.
 *
 * VAL-ENH-003: TeamManifest.parallelismCap scales with estimatedScope.
 */
export function scaleParallelismCap(estimatedScope: TeamComplexityAssessment["estimatedScope"]): number {
  switch (estimatedScope) {
    case "small":
      return 1;
    case "medium":
      return 2;
    case "large":
      return 4;
    case "very_large":
      return 6;
    default:
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Model Downgrade
// ---------------------------------------------------------------------------

export type ModelDowngradeResult = {
  downgraded: boolean;
  originalModelId: string;
  resolvedModelId: string;
  reason: string | null;
};

/**
 * Checks whether the current usage exceeds the model downgrade threshold and
 * returns an alternate (cheaper) model ID if so.
 *
 * VAL-USAGE-003 / VAL-ENH runtime: Model downgraded when usage threshold exceeded.
 */
export function evaluateModelDowngrade(args: {
  currentModelId: string;
  downgradeThresholdPct: number | null | undefined;
  currentUsagePct: number | null | undefined;
  cheaperModelId?: string;
}): ModelDowngradeResult {
  const { currentModelId, downgradeThresholdPct, currentUsagePct, cheaperModelId } = args;

  if (
    !downgradeThresholdPct ||
    downgradeThresholdPct <= 0 ||
    currentUsagePct == null ||
    currentUsagePct < downgradeThresholdPct
  ) {
    return {
      downgraded: false,
      originalModelId: currentModelId,
      resolvedModelId: currentModelId,
      reason: null,
    };
  }

  const fallback = cheaperModelId ?? resolveCheaperModel(currentModelId);
  if (fallback === currentModelId) {
    return {
      downgraded: false,
      originalModelId: currentModelId,
      resolvedModelId: currentModelId,
      reason: `Usage at ${Math.round(currentUsagePct)}% exceeds threshold ${downgradeThresholdPct}%, but no cheaper model available.`,
    };
  }

  return {
    downgraded: true,
    originalModelId: currentModelId,
    resolvedModelId: fallback,
    reason: `Usage at ${Math.round(currentUsagePct)}% exceeds downgrade threshold ${downgradeThresholdPct}%. Downgrading from ${currentModelId} to ${fallback}.`,
  };
}

/**
 * Simple heuristic for picking a cheaper model tier.
 */
function resolveCheaperModel(modelId: string): string {
  const lower = modelId.toLowerCase();
  // Anthropic: downgrade from opus -> sonnet, sonnet -> haiku
  if (lower.includes("opus")) return modelId.replace(/opus/i, "sonnet");
  if (lower.includes("sonnet") && !lower.includes("haiku")) return modelId.replace(/sonnet[^/]*/i, "haiku-3-5");
  // OpenAI: downgrade from gpt-5 -> gpt-4o
  if (lower.includes("gpt-5")) return modelId.replace(/gpt-5[^/]*/i, "gpt-4o");
  if (lower.includes("gpt-4o") && !lower.includes("mini")) return modelId.replace(/gpt-4o/i, "gpt-4o-mini");
  return modelId;
}
