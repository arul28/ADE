import React from "react";
import { UnifiedModelSelector } from "../../shared/UnifiedModelSelector";

type ModelSelectorProps = {
  model: string;
  reasoningLevel: string;
  onChange: (model: string, reasoningLevel: string) => void;
};

export function ModelSelector({ model, reasoningLevel, onChange }: ModelSelectorProps) {
  return (
    <UnifiedModelSelector
      value={model}
      onChange={(modelId) => onChange(modelId, reasoningLevel)}
      showReasoning
      reasoningEffort={reasoningLevel}
      onReasoningEffortChange={(effort) => onChange(model, effort ?? "medium")}
    />
  );
}
