/**
 * metricsAndUsage.ts
 *
 * Metrics and usage: getMissionMetrics, setMissionMetricsConfig,
 * getAggregatedUsage, propagateAttemptTokenUsage, token usage tracking.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
} from "./orchestratorContext";
import {
  nowIso,
  toOptionalString,
  DEFAULT_METRIC_TOGGLES,
  KNOWN_METRIC_TOGGLES,
} from "./orchestratorContext";
import type {
  MissionMetricsConfig,
  MissionMetricToggle,
  SetMissionMetricsConfigArgs,
  AggregatedUsageStats,
  GetAggregatedUsageArgs,
  UsageModelBreakdown,
  UsageRecentSession,
  UsageActiveSession,
  UsageMissionBreakdown,
} from "../../../shared/types";

// ── Token Cost Estimation ────────────────────────────────────────

const USAGE_TOKEN_COST: Record<string, { input: number; output: number }> = {
  "sonnet": { input: 3, output: 15 },
  "haiku": { input: 0.25, output: 1.25 },
  "opus": { input: 15, output: 75 },
  "gpt-4o": { input: 2.5, output: 10 },
  "codex": { input: 0.5, output: 2 },
  "deepseek": { input: 0.27, output: 1.10 },
  "mistral": { input: 2, output: 6 },
  "grok": { input: 5, output: 15 },
  "gemini": { input: 1.25, output: 5 },
  "llama": { input: 0.2, output: 0.2 },
  "groq": { input: 0.05, output: 0.10 },
  "together": { input: 0.2, output: 0.2 },
  "ollama": { input: 0, output: 0 },
  "openrouter": { input: 2, output: 6 },
};

export function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  const lower = (model ?? "").toLowerCase();
  for (const [key, cost] of Object.entries(USAGE_TOKEN_COST)) {
    if (lower.includes(key)) {
      return (inputTokens * cost.input + outputTokens * cost.output) / 1_000_000;
    }
  }
  // Fallback: sonnet pricing
  return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
}

// ── Aggregated Usage ─────────────────────────────────────────────

export function getAggregatedUsage(
  ctx: OrchestratorContext,
  usageArgs: GetAggregatedUsageArgs
): AggregatedUsageStats {
  const since = usageArgs.since ?? null;
  const usageLimit = usageArgs.limit ?? 100;
  const missionFilter = usageArgs.missionId ?? null;

  const missionSessionClause = missionFilter
    ? `AND cs.id IN (
         SELECT session_id FROM orchestrator_attempt_sessions
         WHERE run_id IN (SELECT id FROM orchestrator_runs WHERE mission_id = ?)
       )`
    : "";

  const modelRows = ctx.db.all(
    `SELECT cs.model, cs.provider,
            COUNT(*) as sessions,
            SUM(cs.input_tokens) as input_tokens,
            SUM(cs.output_tokens) as output_tokens,
            SUM(COALESCE(
              (julianday(cs.ended_at) - julianday(cs.created_at)) * 86400000,
              0
            )) as duration_ms
     FROM chat_sessions cs
     WHERE cs.created_at >= COALESCE(?, cs.created_at)
       ${missionSessionClause}
     GROUP BY cs.model, cs.provider
     ORDER BY sessions DESC`,
    missionFilter ? [since, missionFilter] : [since]
  ) as Array<{ model: string; provider: string; sessions: number; input_tokens: number; output_tokens: number; duration_ms: number }>;

  const byModel: UsageModelBreakdown[] = modelRows.map((r) => {
    const inp = Number(r.input_tokens) || 0;
    const out = Number(r.output_tokens) || 0;
    return {
      provider: r.provider ?? "unknown",
      model: r.model ?? "unknown",
      sessions: Number(r.sessions) || 0,
      inputTokens: inp,
      outputTokens: out,
      durationMs: Number(r.duration_ms) || 0,
      costEstimateUsd: estimateTokenCost(r.model ?? "", inp, out)
    };
  });

  const recentRows = ctx.db.all(
    `SELECT cs.id, cs.model, cs.provider, cs.feature,
            cs.input_tokens, cs.output_tokens,
            COALESCE(
              (julianday(cs.ended_at) - julianday(cs.created_at)) * 86400000,
              0
            ) as duration_ms,
            cs.ended_at IS NOT NULL as success,
            cs.created_at
     FROM chat_sessions cs
     WHERE cs.created_at >= COALESCE(?, cs.created_at)
     ORDER BY cs.created_at DESC
     LIMIT ?`,
    [since, usageLimit]
  ) as Array<{ id: string; model: string; provider: string; feature: string; input_tokens: number; output_tokens: number; duration_ms: number; success: number; created_at: string }>;

  const recentSessions: UsageRecentSession[] = recentRows.map((r) => ({
    id: r.id,
    feature: r.feature ?? "unknown",
    provider: r.provider ?? "unknown",
    model: r.model ?? "unknown",
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    durationMs: Number(r.duration_ms) || 0,
    success: Boolean(r.success),
    timestamp: r.created_at
  }));

  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const activeRows = ctx.db.all(
    `SELECT cs.id, cs.model, cs.provider, cs.feature, cs.created_at
     FROM chat_sessions cs
     WHERE cs.ended_at IS NULL AND cs.created_at >= ?
     ORDER BY cs.created_at DESC`,
    [fiveMinAgo]
  ) as Array<{ id: string; model: string; provider: string; feature: string; created_at: string }>;

  const now = Date.now();
  const activeSessions: UsageActiveSession[] = activeRows.map((r) => ({
    id: r.id,
    feature: r.feature ?? "unknown",
    provider: r.provider ?? "unknown",
    model: r.model ?? "unknown",
    startedAt: r.created_at,
    elapsedMs: now - Date.parse(r.created_at)
  }));

  const missionRows = ctx.db.all(
    `SELECT r.mission_id,
            SUM(cs.input_tokens) as input_tokens,
            SUM(cs.output_tokens) as output_tokens,
            COUNT(DISTINCT cs.id) as sessions,
            m.title as mission_title
     FROM orchestrator_runs r
     JOIN orchestrator_attempt_sessions oas ON oas.run_id = r.id
     JOIN chat_sessions cs ON cs.id = oas.session_id
     LEFT JOIN missions m ON m.id = r.mission_id
     WHERE cs.created_at >= COALESCE(?, cs.created_at)
     GROUP BY r.mission_id
     ORDER BY sessions DESC`,
    [since]
  ) as Array<{ mission_id: string; input_tokens: number; output_tokens: number; sessions: number; mission_title: string | null }>;

  const missionBreakdown: UsageMissionBreakdown[] = missionRows.map((r) => {
    const inp = Number(r.input_tokens) || 0;
    const out = Number(r.output_tokens) || 0;
    return {
      missionId: r.mission_id,
      missionTitle: r.mission_title ?? "Unknown",
      totalTokens: inp + out,
      costEstimateUsd: estimateTokenCost("sonnet", inp, out)
    };
  });

  const totalSessions = byModel.reduce((a, x) => a + x.sessions, 0);
  const totalInputTokens = byModel.reduce((a, x) => a + x.inputTokens, 0);
  const totalOutputTokens = byModel.reduce((a, x) => a + x.outputTokens, 0);
  const totalDurationMs = byModel.reduce((a, x) => a + x.durationMs, 0);
  const totalCostEstimateUsd = byModel.reduce((a, x) => a + x.costEstimateUsd, 0);

  return {
    summary: {
      totalSessions,
      activeSessions: activeSessions.length,
      totalInputTokens,
      totalOutputTokens,
      totalDurationMs,
      totalCostEstimateUsd,
    },
    byModel,
    recentSessions,
    activeSessions,
    missionBreakdown
  };
}

// ── Attempt Token Usage Propagation ──────────────────────────────

export function propagateAttemptTokenUsage(
  ctx: OrchestratorContext,
  runId: string,
  attemptId: string
): void {
  try {
    const attempt = ctx.db.get<{ session_id: string | null }>(
      `SELECT session_id FROM orchestrator_attempts WHERE id = ? LIMIT 1`,
      [attemptId]
    );
    if (!attempt?.session_id) return;

    const usage = ctx.db.get<{ total_input: number; total_output: number }>(
      `SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output
       FROM chat_sessions WHERE id = ?`,
      [attempt.session_id]
    );
    if (!usage) return;

    const attemptTokens = (usage.total_input ?? 0) + (usage.total_output ?? 0);
    if (attemptTokens <= 0) return;

    const run = ctx.db.get<{ metadata_json: string | null }>(
      `SELECT metadata_json FROM orchestrator_runs WHERE id = ? LIMIT 1`,
      [runId]
    );
    const currentMeta = run?.metadata_json ? JSON.parse(run.metadata_json) : {};
    const currentTokens = typeof currentMeta.tokensConsumed === "number" ? currentMeta.tokensConsumed : 0;
    currentMeta.tokensConsumed = currentTokens + attemptTokens;

    ctx.db.run(
      `UPDATE orchestrator_runs SET metadata_json = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(currentMeta), nowIso(), runId]
    );
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.propagate_token_usage_failed", {
      runId,
      attemptId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// ── Mission Metrics Config ───────────────────────────────────────

export function setMissionMetricsConfig(
  ctx: OrchestratorContext,
  configArgs: SetMissionMetricsConfigArgs,
  deps: {
    getMissionMetadata: (missionId: string) => Record<string, unknown>;
    updateMissionMetadata: (missionId: string, mutate: (metadata: Record<string, unknown>) => void) => void;
  }
): MissionMetricsConfig {
  const missionId = toOptionalString(configArgs.missionId);
  if (!missionId) throw new Error("missionId is required");

  const toggles: MissionMetricToggle[] = Array.isArray(configArgs.toggles)
    ? configArgs.toggles.filter((t): t is MissionMetricToggle => KNOWN_METRIC_TOGGLES.has(t as MissionMetricToggle))
    : DEFAULT_METRIC_TOGGLES;

  const config: MissionMetricsConfig = {
    missionId,
    toggles,
    updatedAt: nowIso()
  };

  deps.updateMissionMetadata(missionId, (metadata) => {
    metadata.metricsConfig = config;
  });

  return config;
}
