import React, { useCallback, useMemo } from "react";
import type { ModelConfig, ModelProvider, ThinkingLevel } from "../../../shared/types";
import { getModelById, resolveModelDescriptor } from "../../../shared/modelRegistry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";

type ModelSelectorProps = {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  compact?: boolean;
  showRecommendedBadge?: boolean;
  /** When provided, only models whose registry id is in this set are shown. */
  availableModelIds?: string[];
  onOpenAiSettings?: () => void;
  /** Stable id used by the picker to remember per-surface defaults. */
  surfaceKey?: string;
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
  surfaceKey = "missions/phase-or-action",
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

  const effectiveModelId = selectedDescriptor?.id ?? resolvedModelId;

  return (
    <div className="inline-flex items-center gap-1.5">
      <ModelPicker
        value={effectiveModelId}
        onChange={handleModelChange}
        surfaceKey={surfaceKey}
        compact={compact ?? false}
        {...(availableModelIds ? { availableModelIds } : {})}
        {...(onOpenAiSettings ? { onOpenSignIn: onOpenAiSettings } : {})}
      />
      <ReasoningEffortPicker
        modelId={effectiveModelId}
        reasoningEffort={value.thinkingLevel ?? null}
        onChange={handleReasoningChange}
        compact={compact ?? false}
      />
    </div>
  );
}
