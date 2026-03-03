/**
 * metricsAndUsage.ts
 *
 * Metrics and usage: getMissionMetrics, setMissionMetricsConfig,
 * getAggregatedUsage, propagateAttemptTokenUsage, token usage tracking,
 * createContextCheckpoint, recordLaneDecision, recordMissionMetricSample.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import { randomUUID } from "node:crypto";
import type {
  OrchestratorContext,
} from "./orchestratorContext";
import {
  nowIso,
  clampLimit,
  parseJsonArray,
  parseJsonRecord,
  DEFAULT_METRIC_TOGGLES,
  KNOWN_METRIC_TOGGLES,
} from "./orchestratorContext";
import {
  getMissionIdentity,
  emitThreadEvent,
} from "./chatMessageService";
import type {
  MissionMetricsConfig,
  MissionMetricToggle,
  MissionMetricSample,
  SetMissionMetricsConfigArgs,
  GetMissionMetricsArgs,
  AggregatedUsageStats,
  GetAggregatedUsageArgs,
  UsageModelBreakdown,
  UsageRecentSession,
  UsageActiveSession,
  UsageMissionBreakdown,
  OrchestratorContextCheckpoint,
  OrchestratorLaneDecision,
} from "../../../shared/types";

// ── Token Cost Estimation ────────────────────────────────────────

const USAGE_TOKEN_COST: Record<string, { input: number; output: number }> = {
  "claude-opus": { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  "claude-sonnet": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  "claude-haiku": { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  "codex": { input: 2 / 1_000_000, output: 8 / 1_000_000 },
  "codex-mini": { input: 0.3 / 1_000_000, output: 1.2 / 1_000_000 },
  "default": { input: 3 / 1_000_000, output: 15 / 1_000_000 }
};

export function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  const lower = (model ?? "").toLowerCase();
  let rate = USAGE_TOKEN_COST["default"];
  if (lower.includes("opus")) rate = USAGE_TOKEN_COST["claude-opus"];
  else if (lower.includes("sonnet")) rate = USAGE_TOKEN_COST["claude-sonnet"];
  else if (lower.includes("haiku")) rate = USAGE_TOKEN_COST["claude-haiku"];
  else if (lower.includes("codex") && lower.includes("mini")) rate = USAGE_TOKEN_COST["codex-mini"];
  else if (lower.includes("codex") || lower.includes("gpt") || lower.includes("o3") || lower.includes("o4")) rate = USAGE_TOKEN_COST["codex"];
  return inputTokens * rate.input + outputTokens * rate.output;
}

// ── Mission Metrics Config ───────────────────────────────────────

export function setMissionMetricsConfig(
  ctx: OrchestratorContext,
  configArgs: SetMissionMetricsConfigArgs
): MissionMetricsConfig {
  const missionIdentity = getMissionIdentity(ctx, configArgs.missionId);
  if (!missionIdentity) throw new Error(`Mission not found: ${configArgs.missionId}`);
  const deduped: MissionMetricToggle[] = [];
  const seen = new Set<string>();
  for (const toggle of configArgs.toggles ?? []) {
    const normalized = String(toggle ?? "").trim();
    if (!normalized.length || seen.has(normalized)) continue;
    if (!KNOWN_METRIC_TOGGLES.has(normalized as MissionMetricToggle)) continue;
    seen.add(normalized);
    deduped.push(normalized as MissionMetricToggle);
  }
  const toggles = deduped.length > 0 ? deduped : [...DEFAULT_METRIC_TOGGLES];
  const config: MissionMetricsConfig = {
    missionId: configArgs.missionId,
    toggles,
    updatedAt: nowIso()
  };
  ctx.db.run(
    `
      insert into mission_metrics_config(
        mission_id,
        project_id,
        toggles_json,
        updated_at
      ) values (?, ?, ?, ?)
      on conflict(mission_id) do update set
        toggles_json = excluded.toggles_json,
        updated_at = excluded.updated_at
    `,
    [config.missionId, missionIdentity.projectId, JSON.stringify(config.toggles), config.updatedAt]
  );
  emitThreadEvent(ctx, {
    type: "metrics_updated",
    missionId: config.missionId,
    runId: null,
    reason: "metrics_config",
    metadata: {
      toggles: config.toggles
    }
  });
  return config;
}

// ── Mission Metrics ──────────────────────────────────────────────

export function getMissionMetrics(
  ctx: OrchestratorContext,
  metricArgs: GetMissionMetricsArgs
): {
  config: MissionMetricsConfig | null;
  samples: MissionMetricSample[];
} {
  const configRow = ctx.db.get<{ toggles_json: string | null; updated_at: string | null }>(
    `
      select toggles_json, updated_at
      from mission_metrics_config
      where mission_id = ?
      limit 1
    `,
    [metricArgs.missionId]
  );
  const config: MissionMetricsConfig | null = configRow
    ? {
        missionId: metricArgs.missionId,
        toggles: parseJsonArray(configRow.toggles_json)
          .map((entry) => String(entry ?? ""))
          .filter((entry): entry is MissionMetricToggle => KNOWN_METRIC_TOGGLES.has(entry as MissionMetricToggle)),
        updatedAt: configRow.updated_at ?? nowIso()
      }
    : null;
  const limit = clampLimit(metricArgs.limit, 200, 1_000);
  const sampleRows = ctx.db.all<{
    id: string;
    mission_id: string;
    run_id: string | null;
    attempt_id: string | null;
    metric: string;
    value: number;
    unit: string | null;
    metadata_json: string | null;
    created_at: string;
  }>(
    `
      select
        id,
        mission_id,
        run_id,
        attempt_id,
        metric,
        value,
        unit,
        metadata_json,
        created_at
      from orchestrator_metrics_samples
      where mission_id = ?
        and (? is null or run_id = ?)
      order by created_at desc
      limit ?
    `,
    [metricArgs.missionId, metricArgs.runId ?? null, metricArgs.runId ?? null, limit]
  );
  const samples: MissionMetricSample[] = sampleRows.map((row) => ({
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id ?? null,
    attemptId: row.attempt_id ?? null,
    metric: row.metric,
    value: Number(row.value ?? 0),
    unit: row.unit ?? null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at
  }));
  return {
    config,
    samples
  };
}

// ── Aggregated Usage ─────────────────────────────────────────────

export function getAggregatedUsage(
  ctx: OrchestratorContext,
  usageArgs: GetAggregatedUsageArgs
): AggregatedUsageStats {
  const since = usageArgs.since ?? null;
  const usageLimit = usageArgs.limit ?? 100;
  const missionFilter = usageArgs.missionId ?? null;
  // When filtering by mission, scope ai_usage_log queries to sessions linked to that mission
  const missionSessionClause = missionFilter
    ? ` and session_id in (
        select oa.executor_session_id from orchestrator_attempts oa
        join orchestrator_runs orr on orr.id = oa.run_id
        where orr.mission_id = ? and oa.executor_session_id is not null
      )`
    : "";
  const modelRows = ctx.db.all(`
    select provider, model, count(*) as sessions,
      coalesce(sum(input_tokens), 0) as input_tokens,
      coalesce(sum(output_tokens), 0) as output_tokens,
      coalesce(sum(duration_ms), 0) as duration_ms
    from ai_usage_log
    where (? is null or timestamp >= ?)${missionSessionClause}
    group by provider, model order by sessions desc
  `, missionFilter ? [since, since, missionFilter] : [since, since]) as Array<{
    provider: string; model: string; sessions: number;
    input_tokens: number; output_tokens: number; duration_ms: number;
  }>;
  const byModel: UsageModelBreakdown[] = modelRows.map((r) => {
    const inp = Number(r.input_tokens) || 0;
    const out = Number(r.output_tokens) || 0;
    return {
      provider: r.provider ?? "unknown", model: r.model ?? "unknown",
      sessions: Number(r.sessions) || 0, inputTokens: inp, outputTokens: out,
      durationMs: Number(r.duration_ms) || 0,
      costEstimateUsd: estimateTokenCost(r.model ?? "", inp, out)
    };
  });
  const recentRows = ctx.db.all(`
    select id, feature, provider, model,
      coalesce(input_tokens, 0) as input_tokens, coalesce(output_tokens, 0) as output_tokens,
      coalesce(duration_ms, 0) as duration_ms, success, timestamp
    from ai_usage_log where (? is null or timestamp >= ?)${missionSessionClause}
    order by timestamp desc limit ?
  `, missionFilter ? [since, since, missionFilter, usageLimit] : [since, since, usageLimit]) as Array<{
    id: string; feature: string; provider: string; model: string;
    input_tokens: number; output_tokens: number; duration_ms: number;
    success: number; timestamp: string;
  }>;
  const recentSessions: UsageRecentSession[] = recentRows.map((r) => ({
    id: r.id, feature: r.feature ?? "", provider: r.provider ?? "unknown",
    model: r.model ?? "unknown", inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0, durationMs: Number(r.duration_ms) || 0,
    success: r.success === 1 || (r.success as unknown) === true, timestamp: r.timestamp
  }));
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const activeRows = ctx.db.all(`
    select id, feature, provider, model, timestamp from ai_usage_log
    where timestamp >= ? and (success is null or success = 0)${missionSessionClause}
    order by timestamp desc limit 20
  `, missionFilter ? [fiveMinAgo, missionFilter] : [fiveMinAgo]) as Array<{
    id: string; feature: string; provider: string; model: string; timestamp: string;
  }>;
  const activeSessions: UsageActiveSession[] = activeRows.map((r) => ({
    id: r.id, feature: r.feature ?? "", provider: r.provider ?? "unknown",
    model: r.model ?? "unknown", startedAt: r.timestamp,
    elapsedMs: Date.now() - new Date(r.timestamp).getTime()
  }));
  const missionRows = ctx.db.all(`
    select oms.mission_id,
      coalesce(sum(case when oms.metric = 'tokens' then oms.value else 0 end), 0) as total_tokens,
      coalesce(sum(case when oms.metric = 'cost' then oms.value else 0 end), 0) as cost_estimate_usd,
      m.title as mission_title
    from orchestrator_metrics_samples oms
    left join missions m on m.id = oms.mission_id
    where (? is null or oms.mission_id = ?) and (? is null or oms.created_at >= ?)
    group by oms.mission_id order by total_tokens desc limit 50
  `, [missionFilter, missionFilter, since, since]) as Array<{
    mission_id: string; total_tokens: number; cost_estimate_usd: number; mission_title: string | null;
  }>;
  const missionBreakdown: UsageMissionBreakdown[] = missionRows.map((r) => ({
    missionId: r.mission_id, missionTitle: r.mission_title ?? r.mission_id.slice(0, 8),
    totalTokens: Number(r.total_tokens) || 0, costEstimateUsd: Number(r.cost_estimate_usd) || 0
  }));
  const totalSessions = byModel.reduce((a, x) => a + x.sessions, 0);
  const totalInputTokens = byModel.reduce((a, x) => a + x.inputTokens, 0);
  const totalOutputTokens = byModel.reduce((a, x) => a + x.outputTokens, 0);
  const totalDurationMs = byModel.reduce((a, x) => a + x.durationMs, 0);
  const totalCostEstimateUsd = byModel.reduce((a, x) => a + x.costEstimateUsd, 0);
  return {
    summary: { totalSessions, activeSessions: activeSessions.length, totalInputTokens, totalOutputTokens, totalDurationMs, totalCostEstimateUsd },
    byModel, recentSessions, activeSessions, missionBreakdown
  };
}

// ── Token Consumption Propagation ──────────────────────────────

export function propagateAttemptTokenUsage(
  ctx: OrchestratorContext,
  runId: string,
  attemptId: string
): void {
  try {
    // Get tokens from the attempt's AI sessions
    const attempt = ctx.db.get<{ session_id: string | null }>(
      "select session_id from orchestrator_attempts where id = ? limit 1",
      [attemptId]
    );
    if (!attempt?.session_id) return;

    const usage = ctx.db.get<{ total_input: number; total_output: number }>(
      `select coalesce(sum(input_tokens), 0) as total_input, coalesce(sum(output_tokens), 0) as total_output
       from ai_usage_log where session_id = ?`,
      [attempt.session_id]
    );
    if (!usage) return;

    const attemptTokens = (usage.total_input ?? 0) + (usage.total_output ?? 0);
    if (attemptTokens <= 0) return;

    // Update run metadata
    const run = ctx.db.get<{ metadata_json: string | null }>(
      "select metadata_json from orchestrator_runs where id = ? limit 1",
      [runId]
    );
    const currentMeta = run?.metadata_json ? JSON.parse(run.metadata_json) : {};
    const currentTokens = typeof currentMeta.tokensConsumed === "number" ? currentMeta.tokensConsumed : 0;
    currentMeta.tokensConsumed = currentTokens + attemptTokens;

    ctx.db.run(
      "update orchestrator_runs set metadata_json = ? where id = ?",
      [JSON.stringify(currentMeta), runId]
    );

    ctx.logger.debug("ai_orchestrator.tokens_propagated", {
      runId, attemptId,
      attemptTokens,
      totalTokens: currentMeta.tokensConsumed
    });
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.token_propagation_failed", {
      runId, attemptId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// ── Context Checkpoint Recording ─────────────────────────────────

export function createContextCheckpoint(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    runId?: string | null;
    trigger: OrchestratorContextCheckpoint["trigger"];
    summary: string;
    source: OrchestratorContextCheckpoint["source"];
  }
): OrchestratorContextCheckpoint | null {
  const missionIdentity = getMissionIdentity(ctx, args.missionId);
  if (!missionIdentity) return null;
  const checkpoint: OrchestratorContextCheckpoint = {
    id: randomUUID(),
    missionId: args.missionId,
    runId: args.runId ?? null,
    trigger: args.trigger,
    summary: args.summary,
    source: {
      digestCount: Math.max(0, Math.floor(Number(args.source.digestCount) || 0)),
      chatMessageCount: Math.max(0, Math.floor(Number(args.source.chatMessageCount) || 0)),
      compressedMessageCount: Math.max(0, Math.floor(Number(args.source.compressedMessageCount) || 0))
    },
    createdAt: nowIso()
  };
  ctx.db.run(
    `
      insert into orchestrator_context_checkpoints(
        id,
        project_id,
        mission_id,
        run_id,
        trigger,
        summary,
        source_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      checkpoint.id,
      missionIdentity.projectId,
      checkpoint.missionId,
      checkpoint.runId,
      checkpoint.trigger,
      checkpoint.summary,
      JSON.stringify(checkpoint.source),
      checkpoint.createdAt
    ]
  );
  return checkpoint;
}

// ── Lane Decision Recording ──────────────────────────────────────

export function recordLaneDecision(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    runId?: string | null;
    stepId?: string | null;
    stepKey?: string | null;
    laneId?: string | null;
    decisionType: OrchestratorLaneDecision["decisionType"];
    validatorOutcome: OrchestratorLaneDecision["validatorOutcome"];
    ruleHits?: string[];
    rationale: string;
    metadata?: Record<string, unknown> | null;
  }
): OrchestratorLaneDecision | null {
  const missionIdentity = getMissionIdentity(ctx, args.missionId);
  if (!missionIdentity) return null;
  const decision: OrchestratorLaneDecision = {
    id: randomUUID(),
    missionId: args.missionId,
    runId: args.runId ?? null,
    stepId: args.stepId ?? null,
    stepKey: args.stepKey ?? null,
    laneId: args.laneId ?? null,
    decisionType: args.decisionType,
    validatorOutcome: args.validatorOutcome,
    ruleHits: Array.isArray(args.ruleHits) ? args.ruleHits.slice(0, 64) : [],
    rationale: args.rationale,
    metadata: args.metadata ?? null,
    createdAt: nowIso()
  };
  ctx.db.run(
    `
      insert into orchestrator_lane_decisions(
        id,
        project_id,
        mission_id,
        run_id,
        step_id,
        step_key,
        lane_id,
        decision_type,
        validator_outcome,
        rule_hits_json,
        rationale,
        metadata_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      decision.id,
      missionIdentity.projectId,
      decision.missionId,
      decision.runId,
      decision.stepId,
      decision.stepKey,
      decision.laneId,
      decision.decisionType,
      decision.validatorOutcome,
      JSON.stringify(decision.ruleHits),
      decision.rationale,
      decision.metadata ? JSON.stringify(decision.metadata) : null,
      decision.createdAt
    ]
  );
  return decision;
}

// ── Mission Metric Sample Recording ──────────────────────────────

export function recordMissionMetricSample(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    runId?: string | null;
    attemptId?: string | null;
    metric: MissionMetricToggle | string;
    value: number;
    unit?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): MissionMetricSample | null {
  const missionIdentity = getMissionIdentity(ctx, args.missionId);
  if (!missionIdentity) return null;
  const numericValue = Number(args.value);
  if (!Number.isFinite(numericValue)) return null;
  const sample: MissionMetricSample = {
    id: randomUUID(),
    missionId: args.missionId,
    runId: args.runId ?? null,
    attemptId: args.attemptId ?? null,
    metric: args.metric,
    value: numericValue,
    unit: args.unit ?? null,
    metadata: args.metadata ?? null,
    createdAt: nowIso()
  };
  ctx.db.run(
    `
      insert into orchestrator_metrics_samples(
        id,
        project_id,
        mission_id,
        run_id,
        attempt_id,
        metric,
        value,
        unit,
        metadata_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      sample.id,
      missionIdentity.projectId,
      sample.missionId,
      sample.runId,
      sample.attemptId,
      sample.metric,
      sample.value,
      sample.unit,
      sample.metadata ? JSON.stringify(sample.metadata) : null,
      sample.createdAt
    ]
  );
  emitThreadEvent(ctx, {
    type: "metrics_updated",
    missionId: sample.missionId,
    runId: sample.runId ?? null,
    reason: "metric_sample",
    metadata: {
      metric: sample.metric,
      sampleId: sample.id
    }
  });
  return sample;
}
