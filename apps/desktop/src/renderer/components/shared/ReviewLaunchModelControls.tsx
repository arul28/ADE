import React from "react";
import type { AiSettingsStatus } from "../../../shared/types";
import { resolveModelDescriptor, selectSupportedReasoningEffort } from "../../../shared/modelRegistry";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { ModelPicker } from "./ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "./ModelPicker/ReasoningEffortPicker";
import { cn } from "../ui/cn";

type ReviewLaunchModelControlsProps = {
  modelId: string;
  reasoningEffort: string;
  fastMode?: boolean;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onFastModeChange?: (value: boolean) => void;
  disabled?: boolean;
  className?: string;
};

export function ReviewLaunchModelControls({
  modelId,
  reasoningEffort,
  fastMode = false,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  disabled = false,
  className,
}: ReviewLaunchModelControlsProps) {
  const [availableModelIds, setAvailableModelIds] = React.useState<string[]>([]);

  const handleModelChange = React.useCallback((nextModelId: string) => {
    const descriptor = resolveModelDescriptor(nextModelId);
    const tiers = descriptor?.reasoningTiers ?? [];
    const nextReasoning = selectSupportedReasoningEffort({
      tiers,
      preferred: reasoningEffort,
      advertisedDefault: descriptor?.defaultReasoningEffort,
    }) ?? "";
    onModelChange(nextModelId);
    if (nextReasoning !== reasoningEffort) onReasoningEffortChange(nextReasoning);
  }, [onModelChange, onReasoningEffortChange, reasoningEffort]);

  React.useEffect(() => {
    let cancelled = false;
    const aiBridge = (window as Window & {
      ade?: {
        ai?: {
          getStatus?: () => Promise<AiSettingsStatus | null | undefined>;
        };
      };
    }).ade?.ai;
    const getStatus = aiBridge?.getStatus;
    if (typeof getStatus !== "function") {
      setAvailableModelIds([]);
      return;
    }
    void getStatus()
      .then((status) => {
        if (cancelled) return;
        setAvailableModelIds(deriveConfiguredModelIds(status));
      })
      .catch(() => {
        if (!cancelled) setAvailableModelIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <ModelPicker
        value={modelId}
        onChange={handleModelChange}
        surfaceKey="review-launch"
        availableModelIds={availableModelIds}
        disabled={disabled}
        fastModeActive={fastMode}
        onFastModeToggle={onFastModeChange}
      />
      <ReasoningEffortPicker
        modelId={modelId}
        reasoningEffort={reasoningEffort || null}
        onChange={(next) => onReasoningEffortChange(next ?? "")}
        disabled={disabled}
      />
    </div>
  );
}
