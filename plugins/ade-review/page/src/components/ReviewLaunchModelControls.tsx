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
 * So the page asks the HOST to open the real ones — `ui.pickModel({ value })`,
 * `ui.pickReasoningEffort({ model, value })` — and draws only the trigger: the
 * same chrome the compiled trigger wore, showing the current value. The reader
 * presses it, ADE's own picker opens over the guest, and the choice comes back.
 *
 * A host with no picker still gets a usable form. The trigger becomes a plain
 * text field with the same label, because a model id typed by hand is worse than
 * a picker and far better than a launch the reader cannot configure.
 *
 * ## The model list, and the fast toggle
 *
 * The compiled control did two more things through `ModelPicker`'s props, and
 * both are back here through the same one read:
 *
 * - it narrowed the picker to the models this surface can launch
 *   (`availableModelIds`, which it derived from `window.ade.ai.getStatus()`).
 *   The page asks the child for `chat.capabilities()` instead, because that is
 *   ADE's own answer to the same question and a guest cannot reach the app
 *   bridge. A host that answers nothing narrows nothing, and the reader gets
 *   the whole catalogue — the behaviour before this existed.
 * - it drew the fast-service-tier toggle (`fastModeActive` /
 *   `onFastModeToggle`). ADE's picker sets both in one gesture, so the answer
 *   still carries `fastMode`; what was missing was any way to turn it back OFF
 *   without re-opening the picker. The toggle is drawn HERE, and only over a
 *   model that actually has a fast tier — `PluginChatModelCapability.fastMode`,
 *   per model. A model without one refuses `fastMode: true` rather than
 *   ignoring it, so a toggle over it would be a switch that fails the launch.
 */

import React from "react";
import { CaretDown, Lightning } from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import { getChatModels } from "../host/actions";
import { hostPickers, pickModel, pickReasoningEffort, pickerRectFromClick } from "../host/ui";
import type { PageChatModel } from "../types";
import { REVIEW_INPUT, REVIEW_INPUT_FOCUS, REVIEW_TOGGLE_ACTIVE } from "./ReviewShell";

export type ReviewLaunchModelChoice = {
  provider?: string | null;
  fastMode?: boolean;
};

export type ReviewLaunchModelControlsProps = {
  modelId: string;
  reasoningEffort: string;
  /** The launch's current service tier. `startRun` takes it as `fastMode`. */
  fastMode: boolean;
  onModelChange: (modelId: string, extras?: ReviewLaunchModelChoice) => void;
  onReasoningEffortChange: (value: string) => void;
  onFastModeChange: (value: boolean) => void;
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
  onPress: (event: React.MouseEvent<HTMLButtonElement>) => void;
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
  reasoningEffort,
  fastMode,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  disabled = false,
  className,
}: ReviewLaunchModelControlsProps) {
  // Read once per mount, not per render: which pickers a host answers is a
  // property of the host, and it cannot change while the page is open.
  const pickers = React.useMemo(() => hostPickers(), []);

  /**
   * The catalogue, read once per mount for the same reason.
   *
   * The model registry cannot change while the page is open — a new model is a
   * new build — so this is a mount read and not a per-keystroke one. Empty
   * until it lands, and empty forever on a host that answers nothing, which is
   * why both consumers below treat empty as "narrow nothing, offer nothing"
   * rather than as "no models exist".
   */
  const [models, setModels] = React.useState<PageChatModel[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    // `getChatModels` degrades to `[]` rather than rejecting — see `actions.ts`.
    void getChatModels().then((next) => {
      if (!cancelled) setModels(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const availableModelIds = React.useMemo(() => models.map((model) => model.id), [models]);

  /**
   * Whether the CHOSEN model has a fast service tier.
   *
   * Three states, not two: `true` draws the toggle, `false` hides it, and
   * `null` — the model is not in a list we have — also hides it, because a
   * toggle drawn on a guess is the dead control this exists to avoid.
   */
  const chosenFastTier = React.useMemo<boolean | null>(() => {
    if (!modelId || models.length === 0) return null;
    const match = models.find((model) => model.id === modelId);
    return match ? match.fastMode : null;
  }, [modelId, models]);

  /**
   * A model with no fast tier cannot carry a fast launch.
   *
   * ADE's picker sets model and tier together, so a reader who turns fast on
   * for one model and then moves to a model without the tier would otherwise
   * launch with `fastMode: true` against a model that refuses it — and the
   * toggle that says so is no longer on screen to be turned off. Only fires on
   * a POSITIVE answer (`false`, not `null`), so an unknown model never has the
   * reader's choice taken from them.
   */
  React.useEffect(() => {
    if (chosenFastTier === false && fastMode) onFastModeChange(false);
  }, [chosenFastTier, fastMode, onFastModeChange]);

  const handlePickModel = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    const choice = await pickModel({
      ...(modelId ? { value: modelId } : {}),
      // Absent rather than empty on a host that answered no capabilities: ADE
      // reads an empty list as "narrow to nothing", and the reader would face a
      // picker with no rows in it.
      ...(availableModelIds.length ? { availableModelIds } : {}),
      rect: pickerRectFromClick(event),
    });
    // Null is both "dismissed" and "this host has no picker", and both mean
    // leave the field exactly as the reader left it.
    if (!choice?.modelId) return;
    onModelChange(choice.modelId, {
      provider: choice.provider ?? null,
      fastMode: choice.fastMode,
    });
  }, [availableModelIds, modelId, onModelChange]);

  const handlePickEffort = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!modelId) return;
    const choice = await pickReasoningEffort({
      model: modelId,
      value: reasoningEffort || null,
      rect: pickerRectFromClick(event),
    });
    // Null is a dismissal. `effort: null` is a real choice — "no reasoning" —
    // and must not be folded into "leave it".
    if (!choice) return;
    onReasoningEffortChange(choice.effort ?? "");
  }, [modelId, onReasoningEffortChange, reasoningEffort]);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {pickers.model ? (
        <PickerTrigger
          label="Model"
          value={modelId || "Choose a model"}
          onPress={(event) => void handlePickModel(event)}
          disabled={disabled}
          testId="model"
        />
      ) : (
        <label className="grid gap-1">
          <span className="sr-only">Model</span>
          <input
            aria-label="Model"
            value={modelId}
            onChange={(event) => onModelChange(event.target.value)}
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
          onPress={(event) => void handlePickEffort(event)}
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

      {/* Drawn only over a model that HAS the tier. See `chosenFastTier`. */}
      {chosenFastTier === true ? (
        <button
          type="button"
          onClick={() => onFastModeChange(!fastMode)}
          disabled={disabled}
          aria-label="Fast mode"
          aria-pressed={fastMode}
          title="Run this review on the model's fast service tier"
          data-review-toggle="fast-mode"
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            fastMode
              ? cn("border-transparent", REVIEW_TOGGLE_ACTIVE)
              : "border-white/[0.08] bg-[var(--color-muted)]/55 text-[#94A3B8] hover:text-[#F5FAFF]",
            REVIEW_INPUT_FOCUS,
          )}
        >
          <Lightning size={12} weight={fastMode ? "fill" : "bold"} className="shrink-0" />
          Fast
        </button>
      ) : null}
    </div>
  );
}
