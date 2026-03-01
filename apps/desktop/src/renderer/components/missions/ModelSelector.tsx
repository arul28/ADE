import React, { useCallback, useMemo } from "react";
import type { ModelConfig, ModelProvider, ThinkingLevel } from "../../../shared/types";
import {
  ALL_MODELS,
  getModelsForProvider,
  getThinkingLevels,
  findModel,
} from "../../../shared/modelProfiles";
import type { ModelEntry } from "../../../shared/modelProfiles";
import {
  MODEL_REGISTRY,
  MODEL_FAMILIES,
  type ProviderFamily,
  type ModelDescriptor,
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

// Map MODEL_REGISTRY families to legacy ModelProvider for backward compat
const FAMILY_TO_PROVIDER: Partial<Record<ProviderFamily, ModelProvider>> = {
  anthropic: "claude",
  openai: "codex",
};

function familyToProvider(family: ProviderFamily): ModelProvider {
  return FAMILY_TO_PROVIDER[family] ?? (family as ModelProvider);
}

function getRecommendedModel(provider: ModelProvider): ModelEntry | undefined {
  return getModelsForProvider(provider).find((m) => m.recommended);
}

function detectProvider(modelId: string): ModelProvider {
  const entry = findModel(modelId);
  if (entry) return entry.provider;
  // Check registry for broader family detection
  const descriptor = MODEL_REGISTRY.find((m) => m.id === modelId || m.sdkModelId === modelId);
  if (descriptor) return familyToProvider(descriptor.family);
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
    const familySet = new Set<ProviderFamily>();
    for (const m of MODEL_REGISTRY) {
      if (m.deprecated) continue;
      if (allowedSet && !allowedSet.has(m.id)) continue;
      familySet.add(m.family);
    }
    return [...familySet].map((family) => ({
      value: familyToProvider(family),
      label: MODEL_FAMILIES[family]?.displayName ?? family,
      family,
    }));
  }, [allowedSet]);

  // Get models for the current provider from both legacy and registry
  const models = useMemo(() => getModelsForProvider(value.provider), [value.provider]);

  // Get registry models grouped by family for the current provider
  const registryModelsGrouped = useMemo(() => {
    const currentFamily = providers.find((p) => p.value === value.provider)?.family;
    if (!currentFamily) return [];
    return MODEL_REGISTRY.filter((m) => {
      if (m.family !== currentFamily || m.deprecated) return false;
      if (allowedSet && !allowedSet.has(m.id)) return false;
      return true;
    });
  }, [value.provider, providers, allowedSet]);

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
        label: t.charAt(0).toUpperCase() + t.slice(1).replace("_", " "),
      }));
    }
    return thinkingLevels;
  }, [registryDescriptor, thinkingLevels]);

  const handleProviderChange = useCallback(
    (newProvider: ModelProvider) => {
      // Try legacy models first, fall back to registry
      const recommended = getRecommendedModel(newProvider);
      let modelId = recommended?.modelId;
      if (!modelId) {
        const legacyModels = getModelsForProvider(newProvider);
        modelId = legacyModels[0]?.modelId;
      }
      if (!modelId) {
        // Use registry to find the first model for this provider's family
        const family = providers.find((p) => p.value === newProvider)?.family;
        const registryModel = family
          ? MODEL_REGISTRY.find((m) => m.family === family && !m.deprecated)
          : undefined;
        modelId = registryModel?.sdkModelId ?? "";
      }
      const levels = getThinkingLevels(newProvider);
      const thinkingLevel =
        value.thinkingLevel && levels.some((l) => l.value === value.thinkingLevel)
          ? value.thinkingLevel
          : "medium";
      onChange({ provider: newProvider, modelId, thinkingLevel });
    },
    [onChange, value.thinkingLevel, providers]
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
