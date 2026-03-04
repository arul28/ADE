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
import { resolveCallTypeModel, modelConfigToServiceModel } from "../../../shared/modelProfiles";
import { resolveModelDescriptor } from "../../../shared/modelRegistry";

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
          const modelIdRaw = typeof callConfig.modelId === "string" ? callConfig.modelId.trim() : "";
          const descriptor = resolveModelDescriptor(modelIdRaw);
          const resolvedModelId = descriptor?.id ?? defaults.model;
          const resolvedDescriptor = resolveModelDescriptor(resolvedModelId);
          const providerFromModel =
            resolvedDescriptor?.family === "anthropic"
              ? "claude"
              : resolvedDescriptor?.family === "openai"
                ? "codex"
                : defaults.provider;
          return {
            provider: providerFromModel,
            model: resolvedModelId,
            reasoningEffort: typeof callConfig.thinkingLevel === "string" ? callConfig.thinkingLevel : defaults.reasoningEffort,
          };
        }
      }
    }
  } catch { /* ignore parse errors */ }
  // Priority 3: Built-in defaults per call type
  return defaults;
}

const DEFAULT_ORCHESTRATOR_MODEL_CONFIG: ModelConfig = {
  modelId: "anthropic/claude-sonnet-4-6",
  provider: "anthropic",
  thinkingLevel: "medium"
};

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

/** Resolve a per-call-type ModelConfig from mission metadata. */
export function resolveOrchestratorModelConfig(
  ctx: OrchestratorContext,
  missionId: string,
  callType: OrchestratorCallType
): ModelConfig {
  const metadata = getMissionMetadata(ctx, missionId);
  const missionModelConfig = metadata?.modelConfig as MissionModelConfig | undefined;

  if (missionModelConfig) {
    return resolveCallTypeModel(
      callType,
      missionModelConfig.intelligenceConfig,
      missionModelConfig.orchestratorModel
    );
  }

  return DEFAULT_ORCHESTRATOR_MODEL_CONFIG;
}

/** Resolve the orchestrator model for AI decision calls. */
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
