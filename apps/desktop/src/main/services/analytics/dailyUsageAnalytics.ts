import type { AdeUsageStats } from "../../../shared/types";
import { localDayKey, localDayOffset } from "../usage/localDay";
import type { ProductAnalyticsService } from "./productAnalyticsService";

export type CompletedDailyUsageAnalyticsTarget = {
  /** Completed machine-local calendar day represented by the aggregate. */
  day: string;
  /** Last instant in that completed day, used for both querying and event time. */
  occurredAt: string;
};

export function completedDailyUsageAnalyticsTarget(
  now: Date | string | number = Date.now(),
): CompletedDailyUsageAnalyticsTarget | null {
  const currentDayStart = localDayOffset(now, 0);
  const completedDayStart = localDayOffset(now, -1);
  if (!currentDayStart || !completedDayStart) return null;
  return {
    day: localDayKey(completedDayStart),
    occurredAt: new Date(currentDayStart.getTime() - 1).toISOString(),
  };
}

function coarseProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  // Pi is the harness, so a Pi-routed model reports as Pi rather than as the
  // upstream provider its id happens to name.
  if (normalized === "pi" || normalized.startsWith("pi/")) return "pi";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("openai")) return "openai";
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "claude";
  if (normalized.includes("cursor")) return "cursor";
  if (normalized.includes("droid") || normalized.includes("factory")) return "droid";
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("gemini") || normalized.includes("google")) return "gemini";
  if (normalized.includes("local") || normalized.includes("ollama")) return "local";
  return "other";
}

function coarseModelFamily(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (/gpt[-_ ]?5/.test(normalized)) return "gpt_5";
  if (/\b(o[134]|o3|o4)\b/.test(normalized)) return "openai_reasoning";
  if (normalized.includes("sonnet")) return "claude_sonnet";
  if (normalized.includes("opus")) return "claude_opus";
  if (normalized.includes("haiku")) return "claude_haiku";
  if (normalized.includes("cursor")) return "cursor";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("grok")) return "grok";
  if (normalized.includes("local") || normalized.includes("ollama")) return "local";
  return "other";
}

function hasReportableActivity(stats: AdeUsageStats): boolean {
  const summary = stats.summary;
  const counters = [
    summary.totalInteractions,
    summary.chatSessions,
    summary.terminalSessions,
    summary.lanesCreated,
    summary.lanesArchived,
    summary.commitsCreated,
    summary.pushOperations,
    summary.prLandings,
    summary.filesChanged,
    summary.artifactsCaptured,
    summary.automationRuns,
    summary.workerRuns,
    summary.adeTotalTokens,
    summary.trackedAdeTokens,
    summary.trackedAdeCalls,
    summary.trackedAdeDurationMs,
  ];
  return counters.some((value) => typeof value === "number" && value > 0)
    || (stats.adeProviders ?? stats.providers).some((provider) => provider.totalTokens > 0)
    || (stats.adeModels ?? stats.models).some((model) => model.totalTokens > 0 || model.calls > 0);
}

export function captureDailyUsageAnalytics(args: {
  analytics: ProductAnalyticsService;
  stats: AdeUsageStats;
  projectId: string;
  reportDay?: string;
  occurredAt?: string;
}): number {
  if (!hasReportableActivity(args.stats)) return 0;
  const day = args.reportDay ?? args.stats.generatedAt.slice(0, 10);
  const occurredAt = args.occurredAt ?? args.stats.generatedAt;
  let accepted = 0;
  const capture = (
    dimension: string,
    surface: "desktop" | "mobile" | "tui" | "web" | "api",
    properties: Record<string, string | number | boolean | null>,
  ) => {
    const result = args.analytics.captureInternal({
      event: "ade_daily_usage_summary",
      surface,
      projectId: args.projectId,
      occurredAt,
      dedupeKey: `daily-usage:${args.projectId}:${day}:${dimension}`,
      minimumIntervalMs: 24 * 60 * 60 * 1_000,
      properties,
    });
    if (result.accepted) accepted += 1;
  };

  const summary = args.stats.summary;
  capture("overall", "api", {
    summary_kind: "overall",
    interaction_count: summary.totalInteractions ?? 0,
    chat_session_count: summary.chatSessions ?? 0,
    terminal_session_count: summary.terminalSessions ?? 0,
    active_lane_count: summary.activeLanes ?? 0,
    lanes_created: summary.lanesCreated ?? 0,
    lanes_archived: summary.lanesArchived ?? 0,
    commits_created: summary.commitsCreated,
    push_operations: summary.pushOperations,
    pr_landings: summary.prLandings,
    files_changed: summary.filesChanged,
    artifacts_captured: summary.artifactsCaptured ?? 0,
    automation_runs: summary.automationRuns ?? 0,
    worker_runs: summary.workerRuns ?? 0,
    active_days: summary.activeDays ?? 0,
    current_streak_days: summary.currentStreakDays ?? 0,
    token_count: summary.adeTotalTokens ?? summary.trackedAdeTokens ?? 0,
    call_count: summary.trackedAdeCalls ?? 0,
    duration_ms: summary.trackedAdeDurationMs ?? 0,
    provider_count: (args.stats.adeProviders ?? args.stats.providers).length,
    model_count: (args.stats.adeModels ?? args.stats.models).length,
  });

  const providers = new Map<string, { total: number; input: number; output: number }>();
  for (const provider of args.stats.adeProviders ?? args.stats.providers) {
    const key = coarseProvider(provider.provider);
    const current = providers.get(key) ?? { total: 0, input: 0, output: 0 };
    current.total += provider.totalTokens;
    current.input += provider.inputTokens;
    current.output += provider.outputTokens;
    providers.set(key, current);
  }
  const topProvider = [...providers.entries()].sort((a, b) => b[1].total - a[1].total)[0];
  if (topProvider) {
    const [provider, totals] = topProvider;
    capture(`provider:${provider}`, "api", {
      summary_kind: "provider",
      provider,
      token_count: totals.total,
      input_token_count: totals.input,
      output_token_count: totals.output,
    });
  }

  const models = new Map<string, { provider: string; family: string; total: number; input: number; output: number; calls: number }>();
  for (const model of args.stats.adeModels ?? args.stats.models) {
    const provider = coarseProvider(model.provider);
    const family = coarseModelFamily(model.model);
    const key = `${provider}:${family}`;
    const current = models.get(key) ?? { provider, family, total: 0, input: 0, output: 0, calls: 0 };
    current.total += model.totalTokens;
    current.input += model.inputTokens;
    current.output += model.outputTokens;
    current.calls += model.calls;
    models.set(key, current);
  }
  const topModel = [...models.values()].sort((a, b) => b.total - a.total)[0];
  if (topModel) {
    capture(`model:${topModel.provider}:${topModel.family}`, "api", {
      summary_kind: "model",
      provider: topModel.provider,
      model_family: topModel.family,
      token_count: topModel.total,
      input_token_count: topModel.input,
      output_token_count: topModel.output,
      call_count: topModel.calls,
    });
  }

  return accepted;
}
