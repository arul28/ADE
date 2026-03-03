/**
 * modelConfigResolver.ts
 *
 * Model and call-type configuration resolution: resolves orchestrator model
 * configs, call-type settings, planner models, decision timeout caps.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
  ResolvedCallTypeConfig,
} from "./orchestratorContext";
import {
  isRecord,
  CALL_TYPE_DEFAULTS,
  DECISION_TIMEOUT_CAP_MS_BY_HOURS,
} from "./orchestratorContext";
import { getMissionMetadata } from "./chatMessageService";
import type { ModelConfig, OrchestratorCallType, MissionModelConfig } from "../../../shared/types";
import { resolveCallTypeModel, modelConfigToServiceModel, legacyToModelConfig } from "../../../shared/modelProfiles";

function budgetToEffort(budget: number): "low" | "medium" | "high" {
  return budget < 1000 ? "low" : budget < 5000 ? "medium" : "high";
}

const CALL_TYPE_CONFIG_TTL_MS = 30_000;

export function resolveCallTypeConfig(
  ctx: OrchestratorContext,
  missionId: string,
  callType: OrchestratorCallType
): ResolvedCallTypeConfig {
  const cacheKey = `${missionId}:${callType}`;
  const cached = ctx.callTypeConfigCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.config;
  const config = resolveCallTypeConfigUncached(ctx, missionId, callType);
  ctx.callTypeConfigCache.set(cacheKey, { config, expiresAt: Date.now() + CALL_TYPE_CONFIG_TTL_MS });
  return config;
}

function resolveCallTypeConfigUncached(
  ctx: OrchestratorContext,
  missionId: string,
  callType: OrchestratorCallType
): ResolvedCallTypeConfig {
  const defaults = CALL_TYPE_DEFAULTS[callType];
  try {
    const row = ctx.db.get<{ metadata_json: string | null }>(
      "select metadata_json from missions where id = ? limit 1",
      [missionId]
    );
    if (row?.metadata_json) {
      const metadata = JSON.parse(row.metadata_json);
      const launch = isRecord(metadata.launch) ? metadata.launch : null;

      // Priority 1: Per-call-type intelligence config (most specific)
      const intelligenceConfig = launch && isRecord(launch.intelligenceConfig) ? launch.intelligenceConfig : null;
      if (intelligenceConfig) {
        const callConfig = isRecord(intelligenceConfig[callType]) ? intelligenceConfig[callType] : null;
        if (callConfig) {
          return {
            provider: typeof callConfig.provider === "string" ? callConfig.provider as "claude" | "codex" : defaults.provider,
            model: typeof callConfig.modelId === "string" ? callConfig.modelId : defaults.model,
            reasoningEffort: typeof callConfig.thinkingLevel === "string" ? callConfig.thinkingLevel : defaults.reasoningEffort,
          };
        }
      }

      // Priority 2: Top-level orchestratorModel (applies to all call types)
      const topLevelModel = typeof launch?.orchestratorModel === "string" ? launch.orchestratorModel.trim().toLowerCase() : null;
      if (topLevelModel && (topLevelModel === "opus" || topLevelModel === "sonnet" || topLevelModel === "haiku")) {
        // Also check thinkingBudgets for per-call-type reasoning effort override
        const thinkingBudgets = launch && isRecord(launch.thinkingBudgets) ? launch.thinkingBudgets : null;
        const budgetForCallType = thinkingBudgets && typeof thinkingBudgets[callType] === "number" ? thinkingBudgets[callType] : null;
        const budgetEffort = budgetForCallType != null ? budgetToEffort(budgetForCallType as number) : null;
        return {
          provider: "claude",
          model: topLevelModel,
          reasoningEffort: budgetEffort ?? defaults.reasoningEffort,
        };
      }

      // Also check thinkingBudgets even without explicit model override
      const thinkingBudgets = launch && isRecord(launch.thinkingBudgets) ? launch.thinkingBudgets : null;
      if (thinkingBudgets) {
        const budgetForCallType = typeof thinkingBudgets[callType] === "number" ? thinkingBudgets[callType] : null;
        if (budgetForCallType != null) {
          const budgetEffort = budgetToEffort(budgetForCallType as number);
          return { ...defaults, reasoningEffort: budgetEffort };
        }
      }
    }
  } catch { /* ignore parse errors */ }
  // Priority 3: Built-in defaults per call type
  return defaults;
}

export function resolveMissionLaunchPlannerModel(
  ctx: OrchestratorContext,
  missionId: string
): "opus" | "sonnet" | "haiku" | null {
  const row = ctx.db.get<{ metadata_json: string | null }>(
    `
      select metadata_json
      from missions
      where id = ?
      limit 1
    `,
    [missionId]
  );
  if (!row?.metadata_json) return null;
  try {
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const launch = isRecord(metadata.launch) ? (metadata.launch as Record<string, unknown>) : null;
    const raw = typeof launch?.orchestratorModel === "string" ? launch.orchestratorModel.trim().toLowerCase() : "";
    if (raw === "opus" || raw === "sonnet" || raw === "haiku") return raw;
    return null;
  } catch {
    return null;
  }
}

export function resolveMissionDecisionTimeoutCapMs(
  ctx: OrchestratorContext,
  missionId: string
): number {
  const metadata = getMissionMetadata(ctx, missionId);
  const modelConfig = isRecord(metadata.modelConfig) ? metadata.modelConfig : null;
  const rawHours = Number(modelConfig?.decisionTimeoutCapHours ?? Number.NaN);
  const normalizedHours = Number.isFinite(rawHours) ? Math.floor(rawHours) : 24;
  return DECISION_TIMEOUT_CAP_MS_BY_HOURS[normalizedHours] ?? DECISION_TIMEOUT_CAP_MS_BY_HOURS[24];
}

export function resolveAiDecisionLikeTimeoutMs(
  _ctx: OrchestratorContext,
  _missionId: string
): number | null {
  return null;
}

/** Resolve a per-call-type ModelConfig from mission metadata, with fallback to legacy model */
export function resolveOrchestratorModelConfig(
  ctx: OrchestratorContext,
  missionId: string,
  callType: OrchestratorCallType
): ModelConfig {
  // Try to load full MissionModelConfig from mission metadata
  const metadata = getMissionMetadata(ctx, missionId);
  const missionModelConfig = metadata?.modelConfig as MissionModelConfig | undefined;

  if (missionModelConfig) {
    return resolveCallTypeModel(
      callType,
      missionModelConfig.intelligenceConfig,
      missionModelConfig.orchestratorModel
    );
  }

  // Fallback: use legacy orchestratorModel from launch metadata
  const legacyModel = resolveMissionLaunchPlannerModel(ctx, missionId);
  return legacyToModelConfig(legacyModel);
}

/** Resolve the orchestrator model for AI decision calls — defaults to "sonnet" (backward compat wrapper) */
export function resolveOrchestratorModel(
  ctx: OrchestratorContext,
  missionId: string
): string {
  const config = resolveOrchestratorModelConfig(ctx, missionId, "coordinator");
  return modelConfigToServiceModel(config);
}

export function resolveMissionModelConfig(
  ctx: OrchestratorContext,
  missionId: string
): MissionModelConfig | null {
  const metadata = getMissionMetadata(ctx, missionId);
  const modelConfig = metadata?.modelConfig;
  return isRecord(modelConfig) ? (modelConfig as MissionModelConfig) : null;
}
