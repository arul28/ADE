import React, { useCallback } from "react";
import { CaretDown, ChatCircleDots, Check, Terminal } from "@phosphor-icons/react";
import type { AgentChatPermissionMode } from "../../../shared/types";
import { batchLaunchSupportsFastMode, type BatchLaunchSessionType } from "../../lib/linearBatchLaunch";
import type { NativeControlState } from "../../lib/draftLaunchJobs";
import {
  applyClaudePermissionSelection,
  applyCodexPresetToControls,
  CLAUDE_PERMISSION_OPTIONS,
  codexPresetFromControls,
  CODEX_PERMISSION_PRESETS,
  cursorModeChoices,
  cursorModeLabel,
  DROID_PERMISSION_OPTIONS,
  OPENCODE_PERMISSION_OPTIONS,
  readUnifiedPermissionFromNativeControls,
  claudeSelectionMode,
} from "../../lib/nativeLaunchControls";
import { ModelPicker } from "./ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "./ModelPicker/ReasoningEffortPicker";
import { resolveModelDescriptorWithRuntimeCatalog } from "./ModelPicker/modelCatalog";
import { getModelById, resolveProviderGroupForModel } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { PERMISSION_TRIGGER_CLASS } from "./PermissionModePicker";

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
      className="inline-flex h-6 shrink-0 items-center rounded-md border border-white/[0.08] bg-white/[0.02] p-0.5"
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
              active ? "bg-white/[0.1] text-fg" : "text-muted-fg/60 hover:text-fg/85",
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
  const [claudeOpen, setClaudeOpen] = React.useState(false);
  const [codexOpen, setCodexOpen] = React.useState(false);
  const claudeRef = React.useRef<HTMLDivElement | null>(null);
  const codexRef = React.useRef<HTMLDivElement | null>(null);
  const descriptor = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
  const provider = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";

  React.useEffect(() => {
    if (!claudeOpen && !codexOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (claudeOpen && claudeRef.current && !claudeRef.current.contains(target)) setClaudeOpen(false);
      if (codexOpen && codexRef.current && !codexRef.current.contains(target)) setCodexOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [claudeOpen, codexOpen]);

  if (provider === "claude") {
    const selected = CLAUDE_PERMISSION_OPTIONS.find((o) => o.value === claudeSelectionMode(nativeControls)) ?? CLAUDE_PERMISSION_OPTIONS[0]!;
    return (
      <div ref={claudeRef} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setClaudeOpen((open) => !open)}
          className={cn(PERMISSION_TRIGGER_CLASS, claudeOpen && "border-violet-400/30 bg-violet-500/[0.08]")}
          title={selected.detail}
        >
          <span className="truncate font-medium">{selected.label}</span>
          <CaretDown size={9} weight="bold" className="text-muted-fg/50" />
        </button>
        {claudeOpen ? (
          <div className="absolute bottom-full left-0 z-[120] mb-1.5 w-56 overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md">
            <ul className="py-1">
              {CLAUDE_PERMISSION_OPTIONS.map((option) => {
                const active = option.value === claudeSelectionMode(nativeControls);
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      onClick={() => {
                        onNativeControlsChange(applyClaudePermissionSelection(option.value, nativeControls));
                        setClaudeOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors",
                        active ? "bg-white/[0.06] text-fg" : "text-fg/72 hover:bg-white/[0.04]",
                      )}
                      title={option.detail}
                    >
                      <span className="flex-1">{option.label}</span>
                      {active ? <Check size={10} weight="bold" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (provider === "codex") {
    const preset = codexPresetFromControls(nativeControls);
    const activePreset = CODEX_PERMISSION_PRESETS.find((o) => o.value === preset);
    const label = preset === "custom" ? "Custom" : activePreset?.label ?? "Default";
    return (
      <div ref={codexRef} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setCodexOpen((open) => !open)}
          className={cn(PERMISSION_TRIGGER_CLASS, codexOpen && "border-violet-400/30 bg-violet-500/[0.08]")}
          title={activePreset?.detail}
        >
          <span className="truncate font-medium">{label}</span>
          <CaretDown size={9} weight="bold" className="text-muted-fg/50" />
        </button>
        {codexOpen ? (
          <div className="absolute bottom-full left-0 z-[120] mb-1.5 w-56 overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md">
            <ul className="py-1">
              {CODEX_PERMISSION_PRESETS.map((option) => {
                const active = preset === option.value;
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      onClick={() => {
                        onNativeControlsChange(applyCodexPresetToControls(option.value, nativeControls));
                        setCodexOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors",
                        active ? "bg-white/[0.06] text-fg" : "text-fg/72 hover:bg-white/[0.04]",
                      )}
                      title={option.detail}
                    >
                      <span className="flex-1">{option.label}</span>
                      {active ? <Check size={10} weight="bold" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (provider === "cursor") {
    const modeValue = nativeControls.cursorModeId ?? "agent";
    return (
      <label className="inline-flex h-6 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-fg/55">Mode</span>
        <select
          value={modeValue}
          disabled={disabled}
          onChange={(event) => onNativeControlsChange({ ...nativeControls, cursorModeId: event.target.value })}
          className="max-w-[7rem] bg-transparent text-[10.5px] text-fg/82 outline-none disabled:opacity-45"
        >
          {cursorModeChoices().map((modeId) => (
            <option key={modeId} value={modeId}>{cursorModeLabel(modeId)}</option>
          ))}
        </select>
      </label>
    );
  }

  if (provider === "droid") {
    return (
      <label className="inline-flex h-6 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-fg/55">Autonomy</span>
        <select
          value={nativeControls.droidPermissionMode}
          disabled={disabled}
          onChange={(event) => onNativeControlsChange({
            ...nativeControls,
            droidPermissionMode: event.target.value as NativeControlState["droidPermissionMode"],
          })}
          className="max-w-[7rem] bg-transparent text-[10.5px] text-fg/82 outline-none disabled:opacity-45"
        >
          {DROID_PERMISSION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} title={option.detail}>{option.label}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="inline-flex h-6 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-fg/55">Permissions</span>
      <select
        value={nativeControls.opencodePermissionMode}
        disabled={disabled}
        onChange={(event) => onNativeControlsChange({
          ...nativeControls,
          opencodePermissionMode: event.target.value as NativeControlState["opencodePermissionMode"],
        })}
        className="max-w-[7rem] bg-transparent text-[10.5px] text-fg/82 outline-none disabled:opacity-45"
      >
        {OPENCODE_PERMISSION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export type SessionLaunchModelConfig = {
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  sessionType: BatchLaunchSessionType;
  nativeControls: NativeControlState;
};

export function SessionLaunchModelControls({
  config,
  onChange,
  surfaceKey,
  disabled = false,
  showSessionType = true,
}: {
  config: SessionLaunchModelConfig;
  onChange: (patch: Partial<SessionLaunchModelConfig>) => void;
  surfaceKey: string;
  disabled?: boolean;
  showSessionType?: boolean;
}) {
  const patchNative = useCallback((nativeControls: NativeControlState) => {
    onChange({ nativeControls });
  }, [onChange]);

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
        onChange={(modelId) => onChange({ modelId })}
        surfaceKey={surfaceKey}
        compact
        triggerClassName={COMPOSER_MODEL_TRIGGER}
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
