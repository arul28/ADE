/**
 * The machine row's Advanced, as a page.
 *
 * `CursorCloudAdvancedMenu` + `CursorCloudSecretsPicker` + the fields
 * `useCursorCloudDraftState` fed the composer, drawn as one compact form sized
 * to its content. The compiled version was a popover that hung off a chip and
 * held only the two controls that would not fit on the composer's own row; a
 * `composer-picker` placement is that popover, so the form can hold the whole
 * launch and the composer keeps its row.
 *
 * Four things are carried across exactly, and each has a reason.
 *
 * 1. **`unavailable` is the first branch.** The compiled hook composed one
 *    sentence per real reason — "Checking Cursor Cloud…", "This repo is not
 *    connected to Cursor. Connect it in Cursor, then try again.", the lane's
 *    own git-remote failure — and never blamed a missing remote for a pending
 *    probe. That sentence arrives already written and is drawn verbatim, with
 *    a "Check again" beside it because the compiled hook's `refetch` only ever
 *    retried the failed read.
 * 2. **The repo is read-only.** Cursor clones from ITS OWN GitHub connection,
 *    not from the lane's working copy, so there is nothing here for a reader to
 *    choose: the child already matched the lane's remote against the connected
 *    list and `repoCaption` says which repo won.
 * 3. **`prUrl` and `autoCreatePR` are create-time only.** A branch with a PR
 *    gets the non-interactive attach notice instead of the checkbox, because
 *    asking Cursor to open a second PR on a branch that has one is not a choice
 *    worth offering.
 * 4. **Secrets are names.** See `SecretsList`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CircleNotch, Info, Lightning } from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type { CloudExistingPr, CloudLaunchContext, CloudModelOption } from "../types";
import { getLaunchContext, launchAgent } from "../host/actions";
import { closeSurface } from "../host/ui";
import { useHostRefresh } from "../host/refresh";
import {
  hasPicker,
  pickLane,
  pickModel,
  pickReasoningEffort,
  type PickOutcome,
} from "../host/pickers";
import { SecretsList } from "./SecretsList";

/** `Attach to PR #12`, or the same notice for a PR whose number Cursor did not give. */
function existingPrLabel(pr: CloudExistingPr): string {
  if (pr.prNumber != null) return `Attach to PR #${pr.prNumber}`;
  return "Attach to existing PR";
}

const FIELD_LABEL = "font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/55";

const CONTROL =
  "h-7 w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 font-sans text-[11px] text-fg/80 outline-none transition-colors hover:border-white/[0.16] disabled:opacity-40";

/**
 * One choice, drawn either way.
 *
 * `available` decides the SHAPE, not just the behaviour: a host with the picker
 * verb gets a chip that opens ADE's own list, and a host without it gets a real
 * `<select>` built from `CloudLaunchContext`. `forcedInline` is the third case —
 * the host claimed the verb and then could not open it, which flips this
 * control to the select for the rest of the form's life rather than leaving the
 * reader pressing a chip that does nothing.
 */
function ChoiceField({
  label,
  value,
  valueLabel,
  placeholder,
  options,
  available,
  disabled,
  onPick,
  onSelect,
}: {
  label: string;
  value: string | null;
  valueLabel: string | null;
  placeholder: string;
  options: { value: string; label: string }[];
  available: boolean;
  disabled?: boolean;
  onPick: () => Promise<PickOutcome>;
  onSelect: (value: string) => void;
}): React.ReactElement {
  const [forcedInline, setForcedInline] = useState(false);
  const useChip = available && !forcedInline;

  if (!useChip) {
    return (
      <label className="block space-y-1">
        <span className={FIELD_LABEL}>{label}</span>
        <select
          value={value ?? ""}
          aria-label={label}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value)}
          className={CONTROL}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="space-y-1">
      <span className={cn(FIELD_LABEL, "block")}>{label}</span>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={() => void onPick().then((outcome) => {
          if (outcome.kind === "inline") setForcedInline(true);
        })}
        className={cn(CONTROL, "inline-flex items-center gap-1 text-left")}
      >
        <span className={cn("min-w-0 flex-1 truncate", valueLabel ? undefined : "text-muted-fg/60")}>
          {valueLabel ?? placeholder}
        </span>
        <CaretDown size={9} weight="bold" className="shrink-0 opacity-60" />
      </button>
    </div>
  );
}

export function LaunchForm({
  initialLaneId,
  initialDraft,
}: {
  initialLaneId: string | null;
  initialDraft: string;
}): React.ReactElement {
  const [context, setContext] = useState<CloudLaunchContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [prompt, setPrompt] = useState(initialDraft);
  const [laneId, setLaneId] = useState<string | null>(initialLaneId);
  const [laneLabel, setLaneLabel] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [reasoningLabel, setReasoningLabel] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState(false);
  const [openPr, setOpenPr] = useState(false);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [rememberSecretNames, setRememberSecretNames] = useState(false);

  const requestRef = useRef(0);
  /**
   * Which lane the lane-derived defaults were taken from.
   *
   * The remembered secrets, the branch's open PR and the matched repo are all
   * per-lane, so switching lanes has to re-read them — that is what
   * `useCursorCloudDraftState` did with three lane-keyed effects. The prompt,
   * the model and the reasoning rung are NOT per-lane and must survive that
   * re-read, or a reader who picked a model and then a lane would silently lose
   * the model.
   */
  const hydratedLaneRef = useRef<string | null | undefined>(undefined);

  const load = useCallback((forLaneId: string | null) => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    setLoading(true);
    setLoadError(null);
    void getLaunchContext({ laneId: forLaneId, draft: initialDraft })
      .then((next) => {
        if (requestRef.current !== generation) return;
        setContext(next);
        const laneChanged = hydratedLaneRef.current !== next.laneId;
        hydratedLaneRef.current = next.laneId;
        setLaneId(next.laneId);
        if (laneChanged) {
          // Lane-derived, so re-taken on every lane switch.
          setSecretNames(next.selectedSecrets);
          setRememberSecretNames(next.rememberSecretNames);
          setOpenPr(next.autoOpenPr);
        }
        // Draft-derived, and only while the reader has typed nothing: the
        // composer's own text seeds the box once and never overwrites a reader.
        setPrompt((current) => (current.length > 0 ? current : next.draft));
        setModelId((current) => current ?? next.models[0]?.id ?? null);
        setModelLabel((current) => current ?? next.models[0]?.label ?? null);
      })
      .catch((err: unknown) => {
        if (requestRef.current !== generation) return;
        setLoadError(err instanceof Error ? err.message : "Could not reach Cursor Cloud.");
      })
      .finally(() => {
        if (requestRef.current === generation) setLoading(false);
      });
  }, [initialDraft]);

  useEffect(() => {
    load(initialLaneId);
  }, [initialLaneId, load]);

  useHostRefresh(() => load(laneId));

  const models = context?.models ?? [];
  const selectedModel: CloudModelOption | null = useMemo(
    () => models.find((model) => model.id === modelId) ?? null,
    [modelId, models],
  );

  /**
   * The reasoning rungs, model-first.
   *
   * A model that names its own tiers is authoritative; `reasoningOptions` on
   * the context is the catalog-wide fallback for a model that names none. An
   * empty list draws no control at all, which is the compiled composer's rule:
   * a picker with nothing in it is a control that can only disappoint.
   */
  const reasoningOptions = selectedModel?.reasoningEfforts?.length
    ? selectedModel.reasoningEfforts
    : context?.reasoningOptions ?? [];

  const showSpeed = context?.showSpeed === true && selectedModel?.speed === true;
  const attachPr = context?.existingPr ?? null;
  const busy = submitting || loading;

  const submit = useCallback(() => {
    const text = prompt.trim();
    if (!text) return;
    setSubmitting(true);
    setMessage(null);
    void launchAgent({
      prompt: text,
      laneId,
      model: modelId,
      reasoningEffort,
      fastMode,
      // A branch that already has a PR attaches to it; asking for a second one
      // is refused by the child anyway, and sending `true` here would make the
      // request say something the form never showed.
      openPr: attachPr ? false : openPr,
      secretNames,
      rememberSecretNames,
    })
      .then((result) => {
        if (result.ok) {
          void closeSurface();
          return;
        }
        setMessage(result.message || "Cursor Cloud refused that launch.");
      })
      .catch((err: unknown) => {
        // Never a throw at the reader: a bridge failure gets the same inline
        // line a Cursor refusal gets.
        setMessage(err instanceof Error ? err.message : "Could not reach Cursor Cloud.");
      })
      .finally(() => setSubmitting(false));
  }, [attachPr, fastMode, laneId, modelId, openPr, prompt, reasoningEffort, rememberSecretNames, secretNames]);

  if (loading && !context) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-6 text-fg/45">
        <CircleNotch size={16} weight="bold" className="animate-spin" />
        <span className="text-[12px]">Loading cloud agents…</span>
      </div>
    );
  }

  const unavailable = loadError ?? context?.unavailable ?? null;
  if (unavailable) {
    // ONLY the sentence and the retry. It is the compiled composer's own
    // reason, and rewording it — or drawing a dead form beneath it — would tell
    // the reader something the app does not believe.
    return (
      <div className="space-y-2 px-4 py-4">
        <p className="text-[11.5px] leading-relaxed text-fg/70">{unavailable}</p>
        <button
          type="button"
          onClick={() => load(laneId)}
          disabled={loading}
          className="rounded-md border border-white/[0.10] px-3 py-1.5 text-[11.5px] font-medium text-fg/75 transition-colors hover:border-white/[0.2] disabled:opacity-40"
        >
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <label className="block space-y-1">
        <span className={FIELD_LABEL}>Prompt</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          rows={3}
          aria-label="Prompt"
          placeholder="What should the cloud agent do?"
          disabled={busy}
          className="w-full resize-y rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 font-sans text-[11.5px] leading-relaxed text-fg/85 outline-none transition-colors placeholder:text-fg/30 hover:border-white/[0.16] focus:border-violet-300/35 disabled:opacity-40"
        />
      </label>

      {/* The repo, stated rather than chosen. */}
      <div className="space-y-1">
        <span className={cn(FIELD_LABEL, "block")}>Repository</span>
        <div className="rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-1.5">
          <div className="truncate font-mono text-[11px] text-fg/70">
            {context?.repoLabel ?? "—"}
          </div>
          {context?.repoCaption ? (
            <div className="mt-0.5 font-sans text-[10.5px] leading-snug text-muted-fg/70">
              {context.repoCaption}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2 min-[420px]:grid-cols-2">
        <ChoiceField
          label="Lane"
          value={laneId}
          valueLabel={laneLabel ?? context?.lanes.find((lane) => lane.id === laneId)?.name ?? null}
          placeholder="No lane"
          options={(context?.lanes ?? []).map((lane) => ({ value: lane.id, label: lane.name }))}
          available={hasPicker("pickLane")}
          disabled={busy}
          onPick={async () => {
            const outcome = await pickLane((context?.lanes ?? []).map((lane) => lane.id));
            if (outcome.kind === "picked") {
              setLaneLabel(outcome.label);
              // A lane switch re-reads the lane-derived fields, exactly as the
              // compiled hook's three lane-keyed effects did.
              load(outcome.id);
            }
            return outcome;
          }}
          onSelect={(next) => {
            setLaneLabel(null);
            load(next || null);
          }}
        />

        <ChoiceField
          label="Model"
          value={modelId}
          valueLabel={modelLabel ?? selectedModel?.label ?? null}
          placeholder="Cursor's default"
          options={models.map((model) => ({ value: model.id, label: model.label }))}
          available={hasPicker("pickModel")}
          disabled={busy}
          onPick={async () => {
            const outcome = await pickModel(models.map((model) => model.id));
            if (outcome.kind === "picked") {
              setModelId(outcome.id);
              setModelLabel(outcome.label ?? models.find((m) => m.id === outcome.id)?.label ?? null);
              // The rungs belong to the model, so a model change drops a rung
              // the new model may not have.
              setReasoningEffort(null);
              setReasoningLabel(null);
            }
            return outcome;
          }}
          onSelect={(next) => {
            setModelId(next || null);
            setModelLabel(models.find((model) => model.id === next)?.label ?? null);
            setReasoningEffort(null);
            setReasoningLabel(null);
          }}
        />

        {reasoningOptions.length > 0 ? (
          <ChoiceField
            label="Reasoning effort"
            value={reasoningEffort}
            valueLabel={
              reasoningLabel
              ?? reasoningOptions.find((option) => option.value === reasoningEffort)?.label
              ?? null
            }
            placeholder="Default"
            options={reasoningOptions.map((option) => ({ value: option.value, label: option.label }))}
            available={hasPicker("pickReasoningEffort")}
            disabled={busy}
            onPick={async () => {
              const outcome = await pickReasoningEffort(modelId);
              if (outcome.kind === "picked") {
                setReasoningEffort(outcome.id);
                setReasoningLabel(outcome.label);
              }
              return outcome;
            }}
            onSelect={(next) => {
              setReasoningEffort(next || null);
              setReasoningLabel(reasoningOptions.find((option) => option.value === next)?.label ?? null);
            }}
          />
        ) : null}

        {showSpeed ? (
          <div className="space-y-1">
            <span className={cn(FIELD_LABEL, "block")}>Speed</span>
            <button
              type="button"
              role="switch"
              aria-checked={fastMode}
              disabled={busy}
              title="Run this launch on the provider's fast service tier"
              onClick={() => setFastMode((current) => !current)}
              className={cn(
                CONTROL,
                "inline-flex items-center gap-1",
                fastMode && "border-violet-400/30 bg-violet-500/[0.08] text-fg",
              )}
            >
              <Lightning size={10} weight={fastMode ? "fill" : "regular"} />
              Fast
            </button>
          </div>
        ) : null}
      </div>

      {/* The PR block, from `CursorCloudAdvancedMenu`. */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] p-1.5">
        {attachPr ? (
          <div aria-disabled="true" className="rounded-lg px-2 py-1.5">
            <p className="font-sans text-[11px] font-medium text-violet-100/90">
              {existingPrLabel(attachPr)}
            </p>
            <p className="mt-0.5 font-sans text-[10.5px] leading-snug text-muted-fg/70">
              This branch already has a PR. Cursor will work on it instead of opening another.
            </p>
          </div>
        ) : (
          <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 font-sans text-[11px] text-fg/90 hover:bg-white/[0.06]">
            <input
              type="checkbox"
              aria-checked={openPr}
              aria-label="Open a PR"
              checked={openPr}
              disabled={busy}
              onChange={(event) => setOpenPr(event.target.checked)}
              className="h-3 w-3 accent-violet-400"
            />
            <span className="min-w-0 flex-1">Open a PR</span>
            {/*
             * The compiled control put this sentence in a `SmartTooltip`. The
             * kit has no tooltip and a page must not grow one for a single
             * hint, so it is the element's own `title` — same words, same
             * hover, and a screen reader gets it from `aria-label` instead.
             */}
            <span
              role="img"
              aria-label="About Open a PR"
              title="When the cloud run finishes, Cursor opens a pull request from this lane's branch. Creation-time only — it cannot be added later. If this branch already has a PR, ADE attaches to that one instead."
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-fg/55 hover:text-fg/80"
              onClick={(event) => event.preventDefault()}
            >
              <Info size={11} weight="bold" aria-hidden />
            </span>
          </label>
        )}
        <div className="my-1.5 border-t border-white/[0.06]" />
        <SecretsList
          availableNames={context?.secretNames ?? []}
          selectedNames={secretNames}
          remember={rememberSecretNames}
          disabled={busy}
          onSelectedNamesChange={setSecretNames}
          onRememberChange={setRememberSecretNames}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        {/* The refusal, inline BESIDE the form rather than over it: the reader
            has to be able to read the sentence and fix the field it names. */}
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-red-200/85" role="status">
          {message}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={busy || prompt.trim().length === 0}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-violet-300/25 bg-violet-500/[0.10] px-3 font-sans text-[11.5px] font-semibold text-violet-100/90 transition-colors hover:border-violet-300/40 hover:bg-violet-500/[0.18] disabled:opacity-40"
        >
          {submitting ? <CircleNotch size={11} weight="bold" className="animate-spin" /> : null}
          Launch
        </button>
      </div>
    </div>
  );
}
