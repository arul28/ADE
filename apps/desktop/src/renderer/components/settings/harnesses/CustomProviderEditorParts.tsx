import React from "react";
import { Check } from "@phosphor-icons/react";
import {
  presetSourceLogo,
  presetSourceSummary,
  type HarnessPresetBody,
  type HarnessPresetDraft,
} from "../../../../shared/harnessPresets";
import { getModelById } from "../../../../shared/modelRegistry";
import { modelMentionEffortLabel } from "../../../../shared/modelMentions";
import { ProviderLogo } from "../../shared/ProviderLogos";
import type { RecipeModel, RecipeSource } from "./CustomProviderHero";
import { harnessShortLabel, sourceSummary, type HarnessChipOption, type ReachableGroup, type ReachableModel } from "./harnessReach";
import { bodyLogoFamily } from "./presetFacts";

/**
 * The Custom provider editor's smaller parts: the step heads, the harness
 * tiles, the effort control, the colour swatches and what the preview says.
 */

/** A short palette, so picking a colour is one click; the last swatch opens any colour. */
export const ACCENT_SWATCHES: readonly string[] = [
  "#8b5cf6",
  "#6366f1",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#ec4899",
];

/** A step's number, title and one-line hint. */
export function StepHead({ n, done, title, hint }: { n: number; done: boolean; title: string; hint: string }) {
  return (
    <div className="ade-cp-step-head">
      <span className="ade-cp-step-num" data-done={done ? "true" : undefined} aria-hidden>
        {done ? <Check size={11} weight="bold" /> : n}
      </span>
      <span className="ade-cp-step-title">{title}</span>
      <span className="ade-cp-step-hint">{hint}</span>
    </div>
  );
}

/** Every harness as a tile; one that cannot be chosen stays visible and says why on hover. */
export function HarnessTiles({
  options,
  selected,
  onSelect,
}: {
  options: readonly HarnessChipOption[];
  selected: HarnessPresetBody;
  onSelect: (harness: HarnessPresetBody) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Harness" data-harness-chip-row="" className="ade-cp-harness-grid">
      {options.map(({ harness, disabledReason }) => {
        const active = harness === selected;
        const disabled = disabledReason != null && !active;
        return (
          <button
            key={harness}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={disabled || undefined}
            data-harness-chip={harness}
            title={disabledReason ?? harnessShortLabel(harness)}
            className="ade-cp-harness"
            onClick={() => {
              if (!disabled) onSelect(harness);
            }}
          >
            <span className="ade-cp-harness-logo"><ProviderLogo family={bodyLogoFamily(harness)} size={14} /></span>
            <span>{harnessShortLabel(harness)}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The model's own thinking tiers as one segmented row. A handful of tiers
 * reads faster as buttons than behind a dropdown, and "Default" stays one
 * click away.
 */
export function EffortPills({
  tiers,
  value,
  onChange,
}: {
  tiers: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const options = ["", ...tiers];
  return (
    <div role="radiogroup" aria-label="Effort" className="kit-seg" data-case="sentence">
      {options.map((option) => (
        <button
          key={option || "default"}
          type="button"
          role="radio"
          aria-checked={option === value}
          onClick={() => onChange(option)}
        >
          {modelMentionEffortLabel(option || null)}
        </button>
      ))}
    </div>
  );
}

/**
 * What the editor's preview says: the model, whose plan pays, and a line on how
 * it connects. From the list when the pick is there, and from the draft when it
 * is not (an import, a key removed since).
 */
export function recipeFor(
  draft: Pick<HarnessPresetDraft, "model" | "source">,
  selected: { group: ReachableGroup; model: ReachableModel } | null,
  modelLabel: string,
): { model: RecipeModel | null; source: RecipeSource | null; note: string | null } {
  if (selected) {
    const { group, model } = selected;
    const lent = model.route.kind === "proxy" && (group.source.kind === "account" || group.source.kind === "subscription");
    return {
      model: { label: model.label, id: model.id, family: model.family ?? null },
      source: { ...sourceSummary(group), logoProvider: group.logoProvider },
      note: lent ? "Runs on the sign-in you already have. No extra login." : group.source.kind === "key" ? "Billed to this API key." : null,
    };
  }
  if (!draft.model) return { model: null, source: null, note: null };
  return {
    model: { label: modelLabel, id: draft.model, family: getModelById(draft.model)?.family ?? null },
    source: { ...presetSourceSummary(draft.source), logoProvider: presetSourceLogo(draft.source) },
    note: null,
  };
}
