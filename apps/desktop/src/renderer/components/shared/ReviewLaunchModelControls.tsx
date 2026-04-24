import React from "react";
import { useNavigate } from "react-router-dom";
import type { AiSettingsStatus } from "../../../shared/types";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { ProviderModelSelector } from "./ProviderModelSelector";

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
  const navigate = useNavigate();
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
    <ProviderModelSelector
      value={modelId}
      onChange={onModelChange}
      availableModelIds={availableModelIds}
      disabled={disabled}
      showReasoning
      reasoningEffort={reasoningEffort || null}
      onReasoningEffortChange={(next) => onReasoningEffortChange(next ?? "")}
      onOpenAiSettings={() => navigate("/settings?tab=ai#ai-providers")}
      className={className}
    />
  );
}
