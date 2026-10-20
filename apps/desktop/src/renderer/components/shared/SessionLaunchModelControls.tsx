import { useCallback, useMemo } from "react";
import { ChatCircleDots, Terminal } from "@phosphor-icons/react";
import type { AgentChatPermissionMode } from "../../../shared/types";
import { batchLaunchSupportsFastMode, type BatchLaunchSessionType } from "../../lib/linearBatchLaunch";
import type { NativeControlState } from "../../lib/draftLaunchJobs";
import {
  applyClaudePermissionSelection,
  applyCodexPresetToControls,
  codexPresetFromControls,
  readUnifiedPermissionFromNativeControls,
  claudeSelectionMode,
} from "../../lib/nativeLaunchControls";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  CURSOR_PERMISSION_MODES,
  DROID_PERMISSION_MODES,
  MUSE_PERMISSION_MODES,
  OPENCODE_PERMISSION_MODES,
} from "../../../shared/modelPermissions";
import { ModelPicker } from "./ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "./ModelPicker/ReasoningEffortPicker";
import { resolveModelDescriptorWithRuntimeCatalog } from "./ModelPicker/modelCatalog";
import { getModelById, resolveProviderGroupForModel } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { PermissionModePicker, type PermissionModePickerOption } from "./PermissionModePicker";
import { COPILOT_PERMISSION_PICKER_OPTIONS, modelPermissionPickerOptions } from "../../lib/modelPermissionOptions";
import { useRootAppStore } from "../../state/appStore";
import { resolveHarnessLaunchTarget } from "../settings/harnesses/harnessLaunchTarget";

const COMPOSER_TOOLBAR_PICKER_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-0";
const COMPOSER_MODEL_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-[4.5rem]";

/** Codex's preset word, including the two states ADE has no preset row for. */
type CodexPermissionPreset = ReturnType<typeof codexPresetFromControls>;

/** Codex's launch presets; config.toml joins only when it is already the state. */
const CODEX_LAUNCH_PRESETS = CODEX_PERMISSION_MODES.filter(
  (mode): mode is (typeof mode) & { value: Exclude<CodexPermissionPreset, "custom" | "config-toml"> } => mode.value !== "config-toml",
);
const CODEX_CONFIG_TOML_MODE = CODEX_PERMISSION_MODES.find((mode) => mode.value === "config-toml")!;

const CURSOR_PICKER_OPTIONS = modelPermissionPickerOptions("cursor", CURSOR_PERMISSION_MODES);
const DROID_PICKER_OPTIONS = modelPermissionPickerOptions("droid", DROID_PERMISSION_MODES);
const MUSE_PICKER_OPTIONS = modelPermissionPickerOptions("muse", MUSE_PERMISSION_MODES);
const OPENCODE_PICKER_OPTIONS = modelPermissionPickerOptions("opencode", OPENCODE_PERMISSION_MODES);

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

  // Every provider opens the chat composer's own permission menu
  // (`PermissionModePicker`), never a lookalike: it portals into the dialog it
  // is opened from and places itself against the viewport, so a scrolling
  // dialog body cannot clip it. Copilot has its own arm: its launch reads
  // `copilotPermissionMode`, not OpenCode's field.
  if (provider === "claude") {
    return (
      <PermissionModePicker
        ariaLabel="Claude permission mode"
        selectedValue={claudeSelectionMode(nativeControls)}
        options={modelPermissionPickerOptions("claude", CLAUDE_PERMISSION_MODES)}
        disabled={disabled}
        onSelect={(mode) => onNativeControlsChange(applyClaudePermissionSelection(mode, nativeControls))}
      />
    );
  }

  if (provider === "codex") {
    const preset = codexPresetFromControls(nativeControls);
    const options: Array<PermissionModePickerOption<CodexPermissionPreset>> =
      modelPermissionPickerOptions("codex", CODEX_LAUNCH_PRESETS);
    // A flags combination ADE has no preset for still names itself, so the pill
    // never claims to be on a preset the person did not choose. Picking that row
    // is a no-op; it is there to describe the current state.
    if (preset === "config-toml") {
      options.push(...modelPermissionPickerOptions("codex", [CODEX_CONFIG_TOML_MODE]));
    } else if (preset === "custom") {
      options.push({
        value: "custom",
        label: "Custom",
        detail: "A custom Codex approval and sandbox combination.",
        tone: "slate",
        icon: "config",
      });
    }
    return (
      <PermissionModePicker
        ariaLabel="Codex permission mode"
        selectedValue={preset}
        options={options}
        disabled={disabled}
        onSelect={(next) => {
          if (next === "custom" || next === "config-toml") return;
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
        options={CURSOR_PICKER_OPTIONS}
        disabled={disabled}
        onSelect={(cursorModeId) => onNativeControlsChange({ ...nativeControls, cursorModeId })}
      />
    );
  }

  if (provider === "droid") {
    return (
      <PermissionModePicker
        ariaLabel="Droid autonomy mode"
        selectedValue={nativeControls.droidPermissionMode}
        options={DROID_PICKER_OPTIONS}
        disabled={disabled}
        onSelect={(droidPermissionMode) => onNativeControlsChange({ ...nativeControls, droidPermissionMode })}
      />
    );
  }

  if (provider === "muse") {
    return (
      <PermissionModePicker
        ariaLabel="Muse approval mode"
        selectedValue={nativeControls.musePermissionMode}
        options={MUSE_PICKER_OPTIONS}
        disabled={disabled}
        onSelect={(musePermissionMode) => onNativeControlsChange({ ...nativeControls, musePermissionMode })}
      />
    );
  }

  if (provider === "copilot") {
    return (
      <PermissionModePicker
        ariaLabel="Copilot permission mode"
        selectedValue={nativeControls.copilotPermissionMode ?? "ask"}
        options={COPILOT_PERMISSION_PICKER_OPTIONS}
        disabled={disabled}
        onSelect={(copilotPermissionMode) => onNativeControlsChange({ ...nativeControls, copilotPermissionMode })}
      />
    );
  }

  return (
    <PermissionModePicker
      ariaLabel="OpenCode permission mode"
      selectedValue={nativeControls.opencodePermissionMode}
      options={OPENCODE_PICKER_OPTIONS}
      disabled={disabled}
      onSelect={(opencodePermissionMode) => onNativeControlsChange({ ...nativeControls, opencodePermissionMode })}
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
        fastMode={config.fastMode}
        onFastModeChange={(fastMode) => onChange({ fastMode })}
        fastModeSupported={batchLaunchSupportsFastMode(config.modelId)}
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
