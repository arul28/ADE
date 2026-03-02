import React, { useCallback, useMemo } from "react";
import type { ModelConfig, ModelProvider, ThinkingLevel } from "../../../shared/types";
import {
  getModelsForProvider,
  getThinkingLevels,
  findModel,
} from "../../../shared/modelProfiles";
import type { ModelEntry } from "../../../shared/modelProfiles";
import {
  MODEL_REGISTRY,
  type ProviderFamily,
} from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type ModelSelectorProps = {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  compact?: boolean;
  showRecommendedBadge?: boolean;
  /** When provided, only models whose registry id is in this set are shown. */
  availableModelIds?: string[];
};

const selectStyle: React.CSSProperties = {
  height: 28,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "0 6px",
  outline: "none",
  borderRadius: 0,
};

const compactSelectStyle: React.CSSProperties = {
  ...selectStyle,
  height: 24,
  fontSize: 11,
  padding: "0 4px",
};

const PROVIDER_TO_FAMILY: Record<ModelProvider, ProviderFamily> = {
  claude: "anthropic",
  codex: "openai",
};

function getRecommendedModel(provider: ModelProvider): ModelEntry | undefined {
  return getModelsForProvider(provider).find((m) => m.recommended);
}

function detectProvider(modelId: string): ModelProvider {
  const entry = findModel(modelId);
  if (entry) return entry.provider;
  // Check registry for broader family detection
  const descriptor = MODEL_REGISTRY.find((m) => m.id === modelId || m.sdkModelId === modelId);
  if (descriptor?.family === "anthropic") return "claude";
  if (descriptor?.family === "openai") return "codex";
  if (
    modelId.startsWith("claude") ||
    modelId.startsWith("opus") ||
    modelId.startsWith("sonnet") ||
    modelId.startsWith("haiku")
  ) {
    return "claude";
  }
  return "codex";
}

type ProviderOption = { value: ModelProvider; label: string; family: ProviderFamily };

export function ModelSelector({
  value,
  onChange,
  compact,
  showRecommendedBadge,
  availableModelIds,
}: ModelSelectorProps) {
  const style = compact ? compactSelectStyle : selectStyle;
  const allowedSet = useMemo(() => availableModelIds ? new Set(availableModelIds) : null, [availableModelIds]);

  // Build provider list from MODEL_REGISTRY families that have non-deprecated models
  const providers: ProviderOption[] = useMemo(() => {
    const options: ProviderOption[] = [];
    for (const provider of ["claude", "codex"] as const) {
      const family = PROVIDER_TO_FAMILY[provider];
      const hasModel = MODEL_REGISTRY.some((model) => {
        if (model.deprecated || !model.isCliWrapped) return false;
        if (model.family !== family) return false;
        if (allowedSet && !allowedSet.has(model.id)) return false;
        return true;
      });
      if (!hasModel) continue;
      options.push({
        value: provider,
        label: provider === "claude" ? "Anthropic" : "OpenAI",
        family,
      });
    }
    if (options.length > 0) return options;
    return (["claude", "codex"] as const).map((provider) => ({
      value: provider,
      label: provider === "claude" ? "Anthropic" : "OpenAI",
      family: PROVIDER_TO_FAMILY[provider],
    }));
  }, [allowedSet]);

  // Get models for the current provider from both legacy and registry
  const models = useMemo(() => getModelsForProvider(value.provider), [value.provider]);

  // Get registry models grouped by family for the current provider
  const registryModelsGrouped = useMemo(() => {
    const currentFamily = PROVIDER_TO_FAMILY[value.provider];
    if (!currentFamily) return [];
    return MODEL_REGISTRY.filter((m) => {
      if (m.family !== currentFamily || m.deprecated || !m.isCliWrapped) return false;
      if (allowedSet && !allowedSet.has(m.id)) return false;
      return true;
    });
  }, [value.provider, allowedSet]);

  const thinkingLevels = useMemo(() => getThinkingLevels(value.provider), [value.provider]);

  // Get reasoning tiers from registry descriptor if available
  const registryDescriptor = useMemo(() => {
    return MODEL_REGISTRY.find((m) =>
      m.sdkModelId === value.modelId || m.id === value.modelId || m.shortId === value.modelId
    );
  }, [value.modelId]);

  const reasoningTiers = useMemo(() => {
    if (registryDescriptor?.reasoningTiers?.length) {
      return registryDescriptor.reasoningTiers.map((t) => ({
        value: t as ThinkingLevel,
        label: t === "xhigh" ? "Extra High" : t.charAt(0).toUpperCase() + t.slice(1).replace("_", " "),
      }));
    }
    return thinkingLevels;
  }, [registryDescriptor, thinkingLevels]);

  const handleProviderChange = useCallback(
    (newProvider: ModelProvider) => {
      // Try legacy models first, fall back to registry
      const recommended = getRecommendedModel(newProvider);
      const providerFamily = PROVIDER_TO_FAMILY[newProvider];
      const providerRegistryModels = MODEL_REGISTRY
        .filter((model) => {
          if (model.deprecated || !model.isCliWrapped) return false;
          if (model.family !== providerFamily) return false;
          if (allowedSet && !allowedSet.has(model.id)) return false;
          return true;
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      const recommendedRegistryModel = recommended
        ? providerRegistryModels.find((model) =>
            model.sdkModelId === recommended.modelId
            || model.shortId === recommended.modelId
            || model.id === recommended.modelId
          )
        : undefined;
      let modelId = recommendedRegistryModel?.sdkModelId;
      if (!modelId) modelId = providerRegistryModels[0]?.sdkModelId;
      if (!modelId) modelId = getModelsForProvider(newProvider)[0]?.modelId;
      if (!modelId) {
        modelId = "";
      }
      const levels = getThinkingLevels(newProvider);
      const thinkingLevel =
        value.thinkingLevel && levels.some((l) => l.value === value.thinkingLevel)
          ? value.thinkingLevel
          : "medium";
      onChange({ provider: newProvider, modelId, thinkingLevel });
    },
    [allowedSet, onChange, value.thinkingLevel]
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      const detectedProvider = detectProvider(modelId);
      onChange({ ...value, provider: detectedProvider, modelId });
    },
    [value, onChange]
  );

  const handleThinkingChange = useCallback(
    (level: ThinkingLevel) => {
      onChange({ ...value, thinkingLevel: level });
    },
    [value, onChange]
  );

  return (
    <div className="flex items-center gap-1.5">
      {/* Provider */}
      <select
        style={style}
        value={value.provider}
        onChange={(e) => handleProviderChange(e.target.value as ModelProvider)}
      >
        {providers.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>

      {/* Model */}
      <select
        style={{ ...style, minWidth: compact ? 120 : 150 }}
        value={value.modelId}
        onChange={(e) => handleModelChange(e.target.value)}
      >
        {registryModelsGrouped.length > 0
          ? registryModelsGrouped.map((m) => (
              <option key={m.id} value={m.sdkModelId}>
                {m.displayName}
                {showRecommendedBadge
                  && getRecommendedModel(value.provider)?.modelId
                  && (
                    m.sdkModelId === getRecommendedModel(value.provider)?.modelId
                    || m.shortId === getRecommendedModel(value.provider)?.modelId
                  )
                    ? " ★ RECOMMENDED"
                    : ""}
              </option>
            ))
          : models.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.displayName}
                {showRecommendedBadge && m.recommended ? " \u2605 RECOMMENDED" : ""}
              </option>
            ))
        }
      </select>

      {/* Thinking Level / Reasoning Tiers */}
      <select
        style={{ ...style, minWidth: compact ? 64 : 80 }}
        value={value.thinkingLevel ?? "medium"}
        onChange={(e) => handleThinkingChange(e.target.value as ThinkingLevel)}
      >
        {reasoningTiers.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
