import React, { useCallback, useEffect, useMemo } from "react";
import { ChatCircleDots, Terminal } from "@phosphor-icons/react";
import type { AgentChatPermissionMode } from "../../../shared/types";
import { batchLaunchSupportsFastMode, type BatchLaunchSessionType } from "../../lib/linearBatchLaunch";
import type { NativeControlState } from "../../lib/draftLaunchJobs";
import { useFastModeEnabled } from "../../lib/fastModePolicy";
import {
  applyClaudePermissionSelection,
  applyCodexPresetToControls,
  codexPresetFromControls,
  cursorModeChoices,
  cursorModeLabel,
  readUnifiedPermissionFromNativeControls,
  claudeSelectionMode,
} from "../../lib/nativeLaunchControls";
import { ModelPicker } from "./ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "./ModelPicker/ReasoningEffortPicker";
import { resolveModelDescriptorWithRuntimeCatalog } from "./ModelPicker/modelCatalog";
import { getModelById, resolveProviderGroupForModel } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { PermissionModePicker, type PermissionModePickerOption } from "./PermissionModePicker";
import {
  CLAUDE_MODE_OPTIONS,
  codexPermissionPickerOption,
  COPILOT_PERMISSION_OPTIONS,
  cursorPermissionPickerOption,
  DROID_PERMISSION_OPTIONS,
  MUSE_PERMISSION_OPTIONS,
  OPENCODE_PERMISSION_OPTIONS,
  type CodexPermissionPreset,
} from "./permissionModePickerOptions";
import { getPermissionOptions } from "./permissionOptions";
import { useRootAppStore } from "../../state/appStore";
import { resolveHarnessLaunchTarget } from "../settings/harnesses/harnessLaunchTarget";

const COMPOSER_TOOLBAR_PICKER_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-0";
const COMPOSER_MODEL_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-[4.5rem]";

function SessionTypeToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: BatchLaunchSessionType;
  onChange: (next: BatchLaunchSessionType) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Session type"
      className="inline-flex h-6 shrink-0 items-center rounded-md border border-fg/[0.08] bg-fg/[0.02] p-0.5"
    >
      {([
        { key: "chat", label: "Chat", Icon: ChatCircleDots },
        { key: "cli", label: "CLI", Icon: Terminal },
      ] as const).map(({ key, label, Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            title={key === "chat" ? "In-app chat agent" : "Terminal CLI agent"}
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium leading-none transition-colors",
              active ? "bg-fg/[0.1] text-fg" : "text-muted-fg/60 hover:text-fg/85",
              disabled && "cursor-not-allowed opacity-45",
            )}
          >
            <Icon size={11} weight={active ? "fill" : "regular"} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// The Codex presets the launch offers, in the composer's order and wording.
const CODEX_LAUNCH_PRESET_OPTIONS = getPermissionOptions({ family: "openai", isCliWrapped: true })
  .filter((option) => option.value === "default" || option.value === "edit" || option.value === "plan" || option.value === "full-auto" || option.value === "config-toml")
  .map(codexPermissionPickerOption);

// Muse's plan mode is a chat interaction mode the launch does not carry, so the
// launch offers its approval modes only.
const MUSE_LAUNCH_OPTIONS = MUSE_PERMISSION_OPTIONS.filter(
  (option): option is PermissionModePickerOption<NativeControlState["musePermissionMode"]> => option.value !== "plan",
);

/**
 * The permission pill for a launch: the same `PermissionModePicker`, options and
 * look as the chat composer, writing into the launch's native controls.
 */
function LaunchNativePermissionControls({
  modelId,
  nativeControls,
  onNativeControlsChange,
  disabled = false,
}: {
  modelId: string;
  nativeControls: NativeControlState;
  onNativeControlsChange: (next: NativeControlState) => void;
  disabled?: boolean;
}) {
  const descriptor = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
  const provider = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";

  if (provider === "claude") {
    return (
      <PermissionModePicker
        ariaLabel="Claude permission mode"
        selectedValue={claudeSelectionMode(nativeControls)}
        options={CLAUDE_MODE_OPTIONS}
        disabled={disabled}
        onSelect={(mode) => onNativeControlsChange(applyClaudePermissionSelection(mode, nativeControls))}
      />
    );
  }

  if (provider === "codex") {
    const preset = codexPresetFromControls(nativeControls);
    const options: Array<PermissionModePickerOption<CodexPermissionPreset>> = preset === "custom"
      ? [
        ...CODEX_LAUNCH_PRESET_OPTIONS,
        { value: "custom", label: "Custom", detail: "Custom Codex approval/sandbox combination.", tone: "slate", icon: "config" },
      ]
      : CODEX_LAUNCH_PRESET_OPTIONS;
    return (
      <PermissionModePicker
        ariaLabel="Codex permission mode"
        selectedValue={preset}
        options={options}
        disabled={disabled}
        onSelect={(next) => {
          if (next === "custom") return;
          onNativeControlsChange(applyCodexPresetToControls(next, nativeControls));
        }}
      />
    );
  }

  if (provider === "cursor") {
    return (
      <PermissionModePicker
        ariaLabel="Cursor mode"
        selectedValue={nativeControls.cursorModeId ?? "agent"}
        options={cursorModeChoices().map((modeId) => cursorPermissionPickerOption(modeId, cursorModeLabel(modeId)))}
        disabled={disabled}
        onSelect={(modeId) => onNativeControlsChange({ ...nativeControls, cursorModeId: modeId })}
      />
    );
  }

  if (provider === "droid") {
    return (
      <PermissionModePicker
        ariaLabel="Droid autonomy mode"
        selectedValue={nativeControls.droidPermissionMode}
        options={DROID_PERMISSION_OPTIONS}
        disabled={disabled}
        onSelect={(mode) => onNativeControlsChange({ ...nativeControls, droidPermissionMode: mode })}
      />
    );
  }

  if (provider === "muse") {
    return (
      <PermissionModePicker
        ariaLabel="Muse approval mode"
        selectedValue={nativeControls.musePermissionMode}
        options={MUSE_LAUNCH_OPTIONS}
        disabled={disabled}
        onSelect={(mode) => onNativeControlsChange({ ...nativeControls, musePermissionMode: mode })}
      />
    );
  }

  if (provider === "copilot") {
    return (
      <PermissionModePicker
        ariaLabel="Copilot permission mode"
        selectedValue={nativeControls.copilotPermissionMode ?? "ask"}
        options={COPILOT_PERMISSION_OPTIONS}
        disabled={disabled}
        onSelect={(mode) => onNativeControlsChange({ ...nativeControls, copilotPermissionMode: mode })}
      />
    );
  }

  // OpenCode, and the ACP providers, whose launch mode is carried in the
  // OpenCode field (see `applyUnifiedPermissionToNativeControls`).
  return (
    <PermissionModePicker
      ariaLabel="OpenCode permission mode"
      selectedValue={nativeControls.opencodePermissionMode}
      options={OPENCODE_PERMISSION_OPTIONS}
      disabled={disabled}
      onSelect={(mode) => onNativeControlsChange({ ...nativeControls, opencodePermissionMode: mode })}
    />
  );
}

export type SessionLaunchModelConfig = {
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  sessionType: BatchLaunchSessionType;
  nativeControls: NativeControlState;
  /** A Custom pick (saved preset or ad-hoc route id); null for a plain model. */
  presetId?: string | null;
};

export function SessionLaunchModelControls({
  config,
  onChange,
  disabled = false,
  showSessionType = true,
  onOpenHarnessSettings,
}: {
  config: SessionLaunchModelConfig;
  onChange: (patch: Partial<SessionLaunchModelConfig>) => void;
  disabled?: boolean;
  showSessionType?: boolean;
  /** Opens Settings › Providers › Custom from the Custom empty state. */
  onOpenHarnessSettings?: () => void;
}) {
  const patchNative = useCallback((nativeControls: NativeControlState) => {
    onChange({ nativeControls });
  }, [onChange]);
  const fastModeAllowed = useFastModeEnabled();
  // A launch form restored from a time Fast was allowed starts Standard, so
  // the create never carries a choice the account would refuse.
  useEffect(() => {
    if (!fastModeAllowed && config.fastMode) onChange({ fastMode: false });
  }, [fastModeAllowed, config.fastMode, onChange]);
  const harnessPresets = useRootAppStore((state) => state.harnessPresets);
  const activePreset = useMemo(() => {
    const target = resolveHarnessLaunchTarget(config.presetId, harnessPresets);
    return target ? { name: target.name, logo: target.logo } : null;
  }, [config.presetId, harnessPresets]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showSessionType ? (
        <SessionTypeToggle
          value={config.sessionType}
          onChange={(sessionType) => onChange({ sessionType })}
          disabled={disabled}
        />
      ) : null}
      <ModelPicker
        value={config.modelId}
        onChange={(modelId, options) => onChange({
          modelId,
          ...(options ? { fastMode: options.fastMode } : {}),
          // Every pick says whether it is a Custom one, so a plain model row
          // clears a preset chosen earlier instead of launching under it.
          presetId: options?.presetId ?? null,
        })}
        {...(activePreset ? { activePreset } : {})}
        activePresetId={config.presetId ?? null}
        compact
        triggerClassName={COMPOSER_MODEL_TRIGGER}
        // Custom shows in both modes; in CLI mode the CLIs that take no
        // endpoint from a launch are listed as unavailable, with the reason.
        harnessLaunchMode={config.sessionType === "cli" ? "cli" : "chat"}
        {...(onOpenHarnessSettings ? { onOpenHarnessSettings } : {})}
        fastMode={fastModeAllowed ? config.fastMode : false}
        onFastModeChange={(fastMode) => onChange({ fastMode })}
        fastModeSupported={batchLaunchSupportsFastMode(config.modelId)}
        fastModeAllowed={fastModeAllowed}
        disabled={disabled}
      />
      <ReasoningEffortPicker
        modelId={config.modelId}
        reasoningEffort={config.reasoningEffort}
        onChange={(reasoningEffort) => onChange({ reasoningEffort })}
        compact
        triggerClassName={COMPOSER_TOOLBAR_PICKER_TRIGGER}
        disabled={disabled}
      />
      <LaunchNativePermissionControls
        modelId={config.modelId}
        nativeControls={config.nativeControls}
        onNativeControlsChange={patchNative}
        disabled={disabled}
      />
    </div>
  );
}

export function resolveDisplayedPermissionMode(
  modelId: string,
  nativeControls: NativeControlState,
): AgentChatPermissionMode {
  return readUnifiedPermissionFromNativeControls(modelId, nativeControls);
}
