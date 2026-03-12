import React from "react";
import { getModelById } from "../../../../shared/modelRegistry";
import type { AiPermissionMode, AgentChatPermissionMode } from "../../../../shared/types";
import { deriveConfiguredModelIds } from "../../../lib/modelOptions";
import { UnifiedModelSelector } from "../../shared/UnifiedModelSelector";
import { cn } from "../../ui/cn";
import { getPermissionOptions, safetyColors } from "../../shared/permissionOptions";

type PrResolverLaunchControlsProps = {
  modelId: string;
  reasoningEffort: string;
  permissionMode: AiPermissionMode;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: AiPermissionMode) => void;
  disabled?: boolean;
  permissionLocked?: boolean;
  className?: string;
};

function fromAgentPermissionMode(mode: AgentChatPermissionMode): AiPermissionMode | null {
  if (mode === "full-auto") return "full_edit";
  if (mode === "edit") return "guarded_edit";
  if (mode === "plan") return "read_only";
  return null;
}

export function PrResolverLaunchControls({
  modelId,
  reasoningEffort,
  permissionMode,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  disabled = false,
  permissionLocked = false,
  className,
}: PrResolverLaunchControlsProps) {
  const [availableModelIds, setAvailableModelIds] = React.useState<string[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void window.ade.ai.getStatus()
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

  const descriptor = getModelById(modelId);
  const family = descriptor?.family ?? "openai";
  const permissionOptions = getPermissionOptions({
    family,
    isCliWrapped: descriptor?.isCliWrapped ?? true,
  }).filter((option) => option.value === "plan" || option.value === "edit" || option.value === "full-auto");

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <UnifiedModelSelector
        value={modelId}
        onChange={onModelChange}
        availableModelIds={availableModelIds}
        disabled={disabled}
        showReasoning
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={(next) => onReasoningEffortChange(next ?? "")}
      />
      <div className="flex items-center gap-px border border-border/10 bg-surface-recessed/40">
        {permissionOptions.map((option) => {
          const mapped = fromAgentPermissionMode(option.value);
          if (!mapped) return null;
          const colors = safetyColors(option.safety);
          const active = permissionMode === mapped;
          return (
            <button
              key={option.value}
              type="button"
              className={cn(
                "px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
                active ? `${colors.activeBg} text-fg/80` : "text-muted-fg/35 hover:text-muted-fg/60",
                permissionLocked || disabled ? "cursor-not-allowed opacity-50" : "",
              )}
              disabled={disabled || permissionLocked}
              onClick={() => onPermissionModeChange(mapped)}
              title={permissionLocked ? "Permission is fixed for the current resolver session." : option.shortDesc}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {permissionLocked ? (
        <span className="font-mono text-[10px] text-fg/45">
          Launch-time permission locked for this resolver session.
        </span>
      ) : null}
    </div>
  );
}
