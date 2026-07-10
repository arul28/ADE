import type { CSSProperties, RefObject } from "react";
import { Info, PaperPlaneTilt, SpinnerGap, Stop, X } from "@phosphor-icons/react";
import type { AgentChatPermissionMode } from "../../../shared/types";
import { modelSupportsFastMode, type ModelDescriptor } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { chatAccentContrast } from "../chat/chatSurfaceTheme";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";

export type ProjectlessComposerVariant = "hero" | "docked";

export function ProjectlessComposer({
  variant,
  appearanceStyle,
  accentColor,
  draft,
  onDraftChange,
  onSubmit,
  sending,
  turnActive,
  models,
  availableModelIds,
  modelId,
  onModelChange,
  catalogReady,
  reasoningEffort,
  onReasoningChange,
  permissionMode,
  onPermissionChange,
  fastMode,
  onFastModeToggle,
  selectedDescriptor,
  canStartSend,
  showInterrupt,
  onInterrupt,
  error,
  onDismissError,
  textareaRef,
}: {
  variant: ProjectlessComposerVariant;
  appearanceStyle: CSSProperties;
  accentColor: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  sending: boolean;
  turnActive: boolean;
  models: readonly ModelDescriptor[];
  availableModelIds: string[];
  modelId: string;
  onModelChange: (id: string) => void;
  catalogReady: boolean;
  reasoningEffort: string | null;
  onReasoningChange: (next: string | null) => void;
  permissionMode: AgentChatPermissionMode;
  onPermissionChange: (next: AgentChatPermissionMode) => void;
  fastMode: boolean;
  onFastModeToggle: (next: boolean) => void;
  selectedDescriptor: ModelDescriptor | undefined;
  canStartSend: boolean;
  showInterrupt: boolean;
  onInterrupt: () => void;
  error: string | null;
  onDismissError: () => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
}) {
  const controlsDisabled = sending || turnActive;
  const sendDisabled = !draft.trim() || sending || !canStartSend;
  return (
    <div
      data-chat-appearance-root
      data-composer-variant={variant}
      style={appearanceStyle}
      className={cn(
        "w-full",
        variant === "docked"
          && "mx-auto max-w-[860px] motion-safe:animate-[ade-chat-dock-in_0.28s_ease-out]",
      )}
    >
      {error ? (
        <div role="alert" className="mb-1.5 flex items-start justify-between gap-2 rounded-lg border border-rose-400/20 bg-rose-500/[0.09] px-3 py-2 font-sans text-[11px] leading-4 text-rose-200/80">
          <span>{error}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss error" className="mt-0.5 shrink-0 text-rose-200/60 hover:text-rose-100"><X size={12} /></button>
        </div>
      ) : null}
      <div className="rounded-2xl border border-white/[0.09] bg-[color:var(--color-surface-raised)]/95 p-2 shadow-[0_24px_80px_-42px_rgba(0,0,0,0.9)] backdrop-blur-xl transition-colors focus-within:border-[color:color-mix(in_srgb,var(--chat-accent)_35%,transparent)]">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            // isComposing: Enter confirms an in-progress IME composition
            // (CJK input) and must not send the message.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          autoFocus
          placeholder="Message an ADE agent…"
          aria-label="Message an ADE agent"
          className="max-h-44 min-h-[54px] w-full resize-none bg-transparent px-2 py-1.5 font-sans text-[13px] leading-5 text-fg/88 outline-none placeholder:text-muted-fg/32"
        />
        <div className="flex min-w-0 items-center gap-1.5 pt-1">
          <ModelPicker
            value={modelId}
            onChange={onModelChange}
            surfaceKey="personal-chat"
            models={models}
            availableModelIds={availableModelIds}
            constrainToAvailableModelIds
            compact
            disabled={sending || turnActive || !catalogReady || availableModelIds.length === 0}
            fastModeActive={fastMode}
            fastModeSupported={modelSupportsFastMode(selectedDescriptor)}
            onFastModeToggle={onFastModeToggle}
          />
          <ReasoningEffortPicker modelId={modelId} reasoningEffort={reasoningEffort} compact disabled={controlsDisabled} onChange={onReasoningChange} />
          <select value={permissionMode} disabled={controlsDisabled} onChange={(event) => onPermissionChange(event.target.value as AgentChatPermissionMode)} className="h-7 max-w-[112px] rounded-md border border-white/[0.06] bg-white/[0.025] px-2 font-sans text-[10px] text-fg/60 outline-none" aria-label="Permission mode">
            <option value="default">Default</option>
            <option value="plan">Plan</option>
            <option value="full-auto">Full access</option>
          </select>
          <div className="flex-1" />
          {showInterrupt ? (
            <button type="button" onClick={onInterrupt} className="flex h-8 w-8 items-center justify-center rounded-full border border-rose-300/20 bg-rose-500/10 text-rose-200" aria-label="Stop response"><Stop size={13} weight="fill" /></button>
          ) : (
            <button
              type="button"
              disabled={sendDisabled}
              onClick={onSubmit}
              style={{ color: chatAccentContrast(accentColor) }}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--chat-accent)] transition-opacity disabled:opacity-30"
              aria-label="Send message"
            >
              {sending ? <SpinnerGap size={14} className="animate-spin" /> : <PaperPlaneTilt size={14} weight="fill" />}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-center gap-1.5 pt-2 font-sans text-[10px] text-muted-fg/40">
        <Info size={12} className="shrink-0" />
        <span title="Agents in a projectless chat run with no repository working directory. Open a project to give them file and git access.">
          Projectless chat — agents have no project working directory
        </span>
      </div>
    </div>
  );
}
