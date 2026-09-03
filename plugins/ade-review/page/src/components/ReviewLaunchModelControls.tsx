/**
 * The model and reasoning controls, moved from
 * `apps/desktop/src/renderer/components/shared/ReviewLaunchModelControls.tsx` (81).
 *
 * The compiled component mounted ADE's own `ModelPicker` and
 * `ReasoningEffortPicker` and read the configured model ids out of
 * `window.ade.ai.getStatus()`. A guest can mount neither and read neither, and
 * the answer is NOT a re-implemented combobox: `ModelPicker` carries recents,
 * per-provider grouping, brand icons, a fast-mode toggle and a search, and a
 * page-local select would be a worse copy of all five that then drifted.
 *
 * So the page asks the HOST to open the real ones — `ui.pickModel`,
 * `ui.pickReasoningEffort` — and draws only the trigger: the same chrome the
 * compiled trigger wore, showing the current value. The reader presses it, ADE's
 * own picker opens over the guest, and the choice comes back.
 *
 * A host with no picker still gets a usable form. The trigger becomes a plain
 * text field with the same label, because a model id typed by hand is worse than
 * a picker and far better than a launch the reader cannot configure.
 */

import React from "react";
import { CaretDown, Lightning } from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import { hostPickers, pickModel, pickReasoningEffort } from "../host/ui";
import { REVIEW_INPUT, REVIEW_INPUT_FOCUS } from "./ReviewShell";

export type ReviewLaunchModelControlsProps = {
  modelId: string;
  provider: string | null;
  reasoningEffort: string;
  fastMode?: boolean;
  onModelChange: (modelId: string, provider: string | null) => void;
  onReasoningEffortChange: (value: string) => void;
  onFastModeChange?: (value: boolean) => void;
  disabled?: boolean;
  className?: string;
};

function PickerTrigger({
  label,
  value,
  onPress,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onPress: () => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={label}
      data-review-picker={testId}
      className={cn(
        "inline-flex h-9 min-w-0 items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[var(--color-muted)]/55 px-3 text-sm text-[#F5FAFF] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        REVIEW_INPUT_FOCUS,
      )}
    >
      <span className="truncate">{value}</span>
      <CaretDown size={12} className="shrink-0 text-[#8FA1B8]" />
    </button>
  );
}

export function ReviewLaunchModelControls({
  modelId,
  provider,
  reasoningEffort,
  fastMode = false,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  disabled = false,
  className,
}: ReviewLaunchModelControlsProps) {
  // Read once per mount, not per render: which pickers a host answers is a
  // property of the host, and it cannot change while the page is open.
  const pickers = React.useMemo(() => hostPickers(), []);

  const handlePickModel = React.useCallback(async () => {
    const choice = await pickModel();
    // Null is both "dismissed" and "this host has no picker", and both mean
    // leave the field exactly as the reader left it.
    if (!choice?.modelId) return;
    onModelChange(choice.modelId, choice.provider ?? null);
  }, [onModelChange]);

  const handlePickEffort = React.useCallback(async () => {
    const choice = await pickReasoningEffort({ provider, model: modelId });
    if (!choice?.effort) return;
    onReasoningEffortChange(choice.effort);
  }, [modelId, onReasoningEffortChange, provider]);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {pickers.model ? (
        <PickerTrigger
          label="Model"
          value={modelId || "Choose a model"}
          onPress={() => void handlePickModel()}
          disabled={disabled}
          testId="model"
        />
      ) : (
        <label className="grid gap-1">
          <span className="sr-only">Model</span>
          <input
            aria-label="Model"
            value={modelId}
            onChange={(event) => onModelChange(event.target.value, provider)}
            disabled={disabled}
            placeholder="openai/gpt-5.6-sol"
            className={cn(REVIEW_INPUT, "pr-3", REVIEW_INPUT_FOCUS)}
          />
        </label>
      )}

      {pickers.reasoningEffort ? (
        <PickerTrigger
          label="Reasoning effort"
          value={reasoningEffort || "Default effort"}
          onPress={() => void handlePickEffort()}
          disabled={disabled}
          testId="reasoning-effort"
        />
      ) : (
        <label className="grid gap-1">
          <span className="sr-only">Reasoning effort</span>
          <input
            aria-label="Reasoning effort"
            value={reasoningEffort}
            onChange={(event) => onReasoningEffortChange(event.target.value)}
            disabled={disabled}
            placeholder="low"
            className={cn(REVIEW_INPUT, "pr-3", REVIEW_INPUT_FOCUS)}
          />
        </label>
      )}

      {onFastModeChange ? (
        <button
          type="button"
          onClick={() => onFastModeChange(!fastMode)}
          disabled={disabled}
          aria-pressed={fastMode}
          data-review-action="fast-mode"
          title="Run on the provider's fast service tier."
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            fastMode
              ? "border-amber-400/40 bg-amber-400/[0.10] text-amber-100"
              : "border-white/[0.08] bg-[var(--color-muted)]/55 text-[#94A3B8] hover:text-[#F5FAFF]",
          )}
        >
          <Lightning size={12} weight={fastMode ? "fill" : "regular"} />
          Fast
        </button>
      ) : null}
    </div>
  );
}
