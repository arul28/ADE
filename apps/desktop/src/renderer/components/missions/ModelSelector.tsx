import React, { useCallback, useMemo } from "react";
import type { ModelConfig, ModelProvider, ThinkingLevel } from "../../../shared/types";
import {
  ALL_MODELS,
  getModelsForProvider,
  getThinkingLevels,
  findModel,
} from "../../../shared/modelProfiles";
import type { ModelEntry } from "../../../shared/modelProfiles";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type ModelSelectorProps = {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  compact?: boolean;
  showRecommendedBadge?: boolean;
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

function getRecommendedModel(provider: ModelProvider): ModelEntry | undefined {
  return getModelsForProvider(provider).find((m) => m.recommended);
}

function detectProvider(modelId: string): ModelProvider {
  const entry = findModel(modelId);
  if (entry) return entry.provider;
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

export function ModelSelector({
  value,
  onChange,
  compact,
  showRecommendedBadge,
}: ModelSelectorProps) {
  const style = compact ? compactSelectStyle : selectStyle;

  const providers: Array<{ value: ModelProvider; label: string }> = useMemo(
    () => [
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
    ],
    []
  );

  const models = useMemo(() => getModelsForProvider(value.provider), [value.provider]);
  const thinkingLevels = useMemo(() => getThinkingLevels(value.provider), [value.provider]);

  const handleProviderChange = useCallback(
    (newProvider: ModelProvider) => {
      const recommended = getRecommendedModel(newProvider);
      const modelId = recommended ? recommended.modelId : getModelsForProvider(newProvider)[0].modelId;
      const levels = getThinkingLevels(newProvider);
      const thinkingLevel =
        value.thinkingLevel && levels.some((l) => l.value === value.thinkingLevel)
          ? value.thinkingLevel
          : "medium";
      onChange({ provider: newProvider, modelId, thinkingLevel });
    },
    [onChange, value.thinkingLevel]
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
        {models.map((m) => (
          <option key={m.modelId} value={m.modelId}>
            {m.displayName}
            {showRecommendedBadge && m.recommended ? " \u2605 RECOMMENDED" : ""}
          </option>
        ))}
      </select>

      {/* Thinking Level */}
      <select
        style={{ ...style, minWidth: compact ? 64 : 80 }}
        value={value.thinkingLevel ?? "medium"}
        onChange={(e) => handleThinkingChange(e.target.value as ThinkingLevel)}
      >
        {thinkingLevels.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
