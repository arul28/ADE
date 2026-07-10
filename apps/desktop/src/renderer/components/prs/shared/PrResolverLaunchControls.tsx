import React from "react";
import {
  getModelById,
  resolveProviderGroupForModel,
  selectSupportedReasoningEffort,
  type ModelDescriptor,
  type ModelProviderGroup,
} from "../../../../shared/modelRegistry";
import type { AiPermissionMode, AgentChatPermissionMode, PrAgentPermissionMode } from "../../../../shared/types";
import { deriveConfiguredModelIds } from "../../../lib/modelOptions";
import { ModelPicker } from "../../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../../shared/ModelPicker/ReasoningEffortPicker";
import { cn } from "../../ui/cn";
import { getPermissionOptions, safetyColors } from "../../shared/permissionOptions";

type PrResolverLaunchControlsBaseProps = {
  modelId: string;
  reasoningEffort: string;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  disabled?: boolean;
  permissionLocked?: boolean;
  className?: string;
};

type PrResolverLaunchControlsProps = PrResolverLaunchControlsBaseProps & (
  | {
      permissionValueMode?: "chat";
      permissionMode: PrAgentPermissionMode;
      onPermissionModeChange: (mode: PrAgentPermissionMode) => void;
    }
  | {
      permissionValueMode: "legacy";
      permissionMode: AiPermissionMode;
      onPermissionModeChange: (mode: AiPermissionMode) => void;
    }
);

function selectReasoningEffortForModel(descriptor: ModelDescriptor | undefined, current: string): string {
  const tiers = descriptor?.reasoningTiers ?? [];
  return selectSupportedReasoningEffort({
    tiers,
    preferred: current,
    advertisedDefault: descriptor?.defaultReasoningEffort,
  }) ?? "";
}

function permissionOptionsForModel(descriptor: ModelDescriptor | undefined, valueMode: "chat" | "legacy" = "chat") {
  const family = descriptor?.family ?? "opencode";
  const providerGroup = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";
  const options = getPermissionOptions({
    family,
    isCliWrapped: descriptor?.isCliWrapped ?? false,
  });

  if (providerGroup === "codex") {
    return options.filter((option) =>
      option.value === "default" ||
      option.value === "plan" ||
      option.value === "full-auto" ||
      (valueMode === "chat" && option.value === "config-toml"),
    );
  }
  if (providerGroup === "claude") {
    return options.filter((option) =>
      (valueMode === "chat" && option.value === "default") ||
      option.value === "edit" ||
      option.value === "plan" ||
      option.value === "full-auto",
    );
  }
  return options.filter((option) =>
    option.value === "default" ||
    option.value === "edit" ||
    option.value === "plan" ||
    option.value === "full-auto",
  );
}

function defaultPermissionForProvider(providerGroup: ModelProviderGroup): AgentChatPermissionMode {
  if (providerGroup === "opencode" || providerGroup === "droid") return "edit";
  return "default";
}

function normalizePermissionModeForModel(
  mode: PrAgentPermissionMode,
  descriptor: ModelDescriptor | undefined,
  valueMode: "chat" | "legacy" = "chat",
): AgentChatPermissionMode {
  const providerGroup = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";
  const options = permissionOptionsForModel(descriptor, valueMode).map((option) => option.value);
  let candidate: AgentChatPermissionMode;

  switch (mode) {
    case "read_only":
      candidate = "plan";
      break;
    case "guarded_edit":
      candidate = providerGroup === "codex" ? "default" : "edit";
      break;
    case "full_edit":
      candidate = "full-auto";
      break;
    default:
      candidate = mode;
      break;
  }

  if (options.includes(candidate)) return candidate;
  const defaultMode = defaultPermissionForProvider(providerGroup);
  return options.includes(defaultMode) ? defaultMode : (options[0] ?? "plan");
}

function toLegacyPermissionMode(mode: AgentChatPermissionMode, providerGroup: ModelProviderGroup): AiPermissionMode {
  if (mode === "plan") return "read_only";
  if (mode === "full-auto") return "full_edit";
  if (providerGroup === "codex" && mode === "default") return "guarded_edit";
  return "guarded_edit";
}

function labelForPermissionOption(value: AgentChatPermissionMode, label: string, providerGroup: ModelProviderGroup): string {
  if (providerGroup === "claude") {
    if (value === "default") return "Manual";
    if (value === "edit") return "Accept edits";
    if (value === "plan") return "Plan";
    if (value === "full-auto") return "Bypass";
  }
  return label;
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
  permissionValueMode = "chat",
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
  const providerGroup = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";
  const permissionOptions = permissionOptionsForModel(descriptor, permissionValueMode);
  const activePermissionMode = normalizePermissionModeForModel(permissionMode, descriptor, permissionValueMode);

  const emitPermissionMode = React.useCallback((nextAgentMode: AgentChatPermissionMode) => {
    const nextMode = permissionValueMode === "legacy"
      ? toLegacyPermissionMode(nextAgentMode, providerGroup)
      : nextAgentMode;
    onPermissionModeChange(nextMode as AiPermissionMode & PrAgentPermissionMode);
  }, [onPermissionModeChange, permissionValueMode, providerGroup]);

  const handleModelChange = React.useCallback((nextModelId: string) => {
    const nextDescriptor = getModelById(nextModelId);
    const nextReasoning = selectReasoningEffortForModel(nextDescriptor, reasoningEffort);
    const nextAgentPermission = normalizePermissionModeForModel(permissionMode, nextDescriptor, permissionValueMode);
    const nextPermission = permissionValueMode === "legacy"
      ? toLegacyPermissionMode(nextAgentPermission, nextDescriptor ? resolveProviderGroupForModel(nextDescriptor) : "opencode")
      : nextAgentPermission;

    onModelChange(nextModelId);
    if (nextReasoning !== reasoningEffort) {
      onReasoningEffortChange(nextReasoning);
    }
    if (nextPermission !== permissionMode) {
      onPermissionModeChange(nextPermission as AiPermissionMode & PrAgentPermissionMode);
    }
  }, [onModelChange, onPermissionModeChange, onReasoningEffortChange, permissionMode, permissionValueMode, reasoningEffort]);

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <ModelPicker
        value={modelId}
        onChange={handleModelChange}
        surfaceKey="pr-resolver-launch"
        availableModelIds={availableModelIds}
        disabled={disabled}
      />
      <ReasoningEffortPicker
        modelId={modelId}
        reasoningEffort={reasoningEffort || null}
        onChange={(next) => onReasoningEffortChange(next ?? "")}
        disabled={disabled}
      />
      <div className="flex items-center gap-px border border-border/10 bg-surface-recessed/40">
        {permissionOptions.map((option) => {
          const colors = safetyColors(option.safety);
          const active = activePermissionMode === option.value;
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
              onClick={() => emitPermissionMode(option.value)}
              title={permissionLocked ? "Permission is fixed for the current resolver session." : option.shortDesc}
            >
              {labelForPermissionOption(option.value, option.label, providerGroup)}
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
