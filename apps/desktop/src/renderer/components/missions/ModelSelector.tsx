import React, { useCallback, useMemo } from "react";
import type { ModelConfig, ModelProvider, ThinkingLevel } from "../../../shared/types";
import { getModelById, resolveModelDescriptor } from "../../../shared/modelRegistry";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";

type ModelSelectorProps = {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  compact?: boolean;
  showRecommendedBadge?: boolean;
  /** When provided, only models whose registry id is in this set are shown. */
  availableModelIds?: string[];
  onOpenAiSettings?: () => void;
};

function providerFromFamily(modelId: string): ModelProvider | undefined {
  const descriptor = resolveModelDescriptor(modelId);
  if (!descriptor) return undefined;
  if (descriptor.family === "anthropic") return "claude";
  if (descriptor.family === "openai") return "codex";
  return descriptor.family;
}

function normalizeModelId(modelId: string): string {
  const descriptor = resolveModelDescriptor(modelId);
  return descriptor?.id ?? modelId;
}

function toThinkingLevel(value: string | null): ThinkingLevel | undefined {
  if (!value) return undefined;
  return value as ThinkingLevel;
}

export function ModelSelector({
  value,
  onChange,
  compact,
  showRecommendedBadge: _showRecommendedBadge,
  availableModelIds,
  onOpenAiSettings,
}: ModelSelectorProps) {
  const resolvedModelId = useMemo(() => normalizeModelId(value.modelId), [value.modelId]);
  const selectedDescriptor = useMemo(() => getModelById(resolvedModelId), [resolvedModelId]);

  const handleModelChange = useCallback((modelId: string) => {
    const normalizedId = normalizeModelId(modelId);
    const provider = providerFromFamily(normalizedId);
    onChange({
      modelId: normalizedId,
      thinkingLevel: value.thinkingLevel ?? "medium",
      ...(provider ? { provider } : {}),
    });
  }, [onChange, value.thinkingLevel]);

  const handleReasoningChange = useCallback((nextReasoning: string | null) => {
    const provider = providerFromFamily(resolvedModelId);
    onChange({
      modelId: resolvedModelId,
      thinkingLevel: toThinkingLevel(nextReasoning),
      ...(provider ? { provider } : {}),
    });
  }, [onChange, resolvedModelId]);

  return (
    <ProviderModelSelector
      value={selectedDescriptor?.id ?? resolvedModelId}
      onChange={handleModelChange}
      availableModelIds={availableModelIds}
      className={compact ? "scale-[0.95] origin-left" : undefined}
      showReasoning
      reasoningEffort={value.thinkingLevel ?? null}
      onReasoningEffortChange={handleReasoningChange}
      onOpenAiSettings={onOpenAiSettings}
    />
  );
}
