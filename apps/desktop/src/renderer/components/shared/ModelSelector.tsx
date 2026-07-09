import { useCallback, useMemo } from "react";
import type { ModelConfig, ModelProvider, ThinkingLevel } from "../../../shared/types";
import { getModelById, resolveModelDescriptor, selectSupportedReasoningEffort } from "../../../shared/modelRegistry";
import { ModelPicker } from "./ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "./ModelPicker/ReasoningEffortPicker";

type ModelSelectorProps = {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  compact?: boolean;
  availableModelIds?: string[];
  onOpenAiSettings?: () => void;
  surfaceKey?: string;
  fastModeActive?: boolean;
  onFastModeToggle?: (next: boolean) => void;
  fastModeSupported?: boolean;
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
  availableModelIds,
  onOpenAiSettings,
  surfaceKey = "automations/model",
  fastModeActive,
  onFastModeToggle,
  fastModeSupported,
}: ModelSelectorProps) {
  const resolvedModelId = useMemo(() => normalizeModelId(value.modelId), [value.modelId]);
  const selectedDescriptor = useMemo(() => getModelById(resolvedModelId), [resolvedModelId]);

  const handleModelChange = useCallback((modelId: string) => {
    const normalizedId = normalizeModelId(modelId);
    const provider = providerFromFamily(normalizedId);
    const descriptor = getModelById(normalizedId);
    const tiers = descriptor?.reasoningTiers ?? [];
    const currentThinking = toThinkingLevel(selectSupportedReasoningEffort({
      tiers,
      preferred: value.thinkingLevel,
      advertisedDefault: descriptor?.defaultReasoningEffort,
    }));
    onChange({
      modelId: normalizedId,
      ...(currentThinking ? { thinkingLevel: currentThinking } : {}),
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
        {...(fastModeActive !== undefined ? { fastModeActive } : {})}
        {...(onFastModeToggle ? { onFastModeToggle } : {})}
        {...(fastModeSupported !== undefined ? { fastModeSupported } : {})}
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
