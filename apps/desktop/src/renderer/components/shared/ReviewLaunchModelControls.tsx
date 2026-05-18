import React from "react";
import type { AiSettingsStatus } from "../../../shared/types";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { ModelPicker } from "./ModelPicker/ModelPicker";

type ReviewLaunchModelControlsProps = {
  modelId: string;
  reasoningEffort: string;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

export function ReviewLaunchModelControls({
  modelId,
  reasoningEffort,
  onModelChange,
  onReasoningEffortChange,
  disabled = false,
  className,
}: ReviewLaunchModelControlsProps) {
  const [availableModelIds, setAvailableModelIds] = React.useState<string[]>([]);

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
    <ModelPicker
      value={modelId}
      onChange={onModelChange}
      surfaceKey="review-launch"
      availableModelIds={availableModelIds}
      disabled={disabled}
      showReasoning
      reasoningEffort={reasoningEffort || null}
      onReasoningEffortChange={(next) => onReasoningEffortChange(next ?? "")}
      {...(className ? { className } : {})}
    />
  );
}
