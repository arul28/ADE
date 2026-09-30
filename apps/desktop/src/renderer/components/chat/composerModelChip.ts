// The composer's model chip: one pill with three parts.
//
//   [ ✦ DeepSeek V4.1 Flash · OpenCode Go │ High │ Full access ]
//
// The name part is fixed. The thinking part and the permission part are
// "segments" the user edits in place: Tab walks name → thinking → permission →
// out of the chip, and each segment opens a small list of its values. The
// chip's `data-composer-chip-text` is always the canonical `@model:` token, so
// serialization, copy, and send need nothing special.

import {
  MODEL_MENTION_DEFAULT_PERMISSION,
  MODEL_MENTION_PERMISSION_MODES,
  formatModelMentionToken,
  modelMentionEffortLabel,
  modelMentionPermissionLabel,
  modelMentionHarnessLabel,
  modelMentionSubtitle,
  type ComposerModelSuggestion,
  type ModelMention,
} from "../../../shared/modelMentions";
import {
  resolveProviderGroupForModel,
  selectSupportedReasoningEffort,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { subProviderLabel } from "../shared/ModelPicker/modelFacts";

export type { ComposerModelSuggestion };

export type ModelChipSegment = "effort" | "perm";

export type ModelChipOption = { value: string; label: string };

/** What the chip needs to know about its model. Null when the catalog lacks it. */
export type ComposerModelInfo = {
  title: string;
  subtitle: string;
  reasoningTiers: string[];
};

export const COMPOSER_MODEL_CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[24rem] translate-y-px items-center overflow-hidden rounded border border-amber-300/25 bg-amber-500/10 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-4 text-amber-50/90 align-baseline";
const NAME_CLASS = "flex min-w-0 items-center gap-1 px-1 py-px";
const SEGMENT_CLASS = "shrink-0 cursor-pointer border-l border-amber-300/20 px-1 py-px text-amber-100/70 hover:bg-amber-400/15";
const SEGMENT_ACTIVE_CLASS = "shrink-0 cursor-pointer border-l border-amber-300/20 px-1 py-px bg-amber-400/30 text-amber-50";

export function modelChipOptions(segment: ModelChipSegment, info: ComposerModelInfo | null): ModelChipOption[] {
  if (segment === "perm") {
    return MODEL_MENTION_PERMISSION_MODES.map((value) => ({ value, label: modelMentionPermissionLabel(value) }));
  }
  return (info?.reasoningTiers ?? []).map((value) => ({ value, label: modelMentionEffortLabel(value) }));
}

/** Segments this chip can edit, in Tab order. A model without levels skips thinking. */
export function modelChipSegments(info: ComposerModelInfo | null): ModelChipSegment[] {
  return info && info.reasoningTiers.length > 0 ? ["effort", "perm"] : ["perm"];
}

/** The token a fresh chip starts with: the model's default level and the default mode. */
export function initialModelMention(suggestion: ComposerModelSuggestion): ModelMention {
  return {
    modelId: suggestion.modelId,
    effort: suggestion.defaultEffort,
    permission: MODEL_MENTION_DEFAULT_PERMISSION,
  };
}

/** Build a model chip node. `info` null draws a plain "unavailable" chip. */
export function createModelChipNode(mention: ModelMention, info: ComposerModelInfo | null): HTMLElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.composerChip = "model";
  chip.className = COMPOSER_MODEL_CHIP_CLASS;
  renderModelChip(chip, mention, info, null);
  return chip;
}

/**
 * Redraw a chip for a new mention and active segment. The chip node stays the
 * same, so the caret and the editor selection around it are not disturbed.
 */
export function renderModelChip(
  chip: HTMLElement,
  mention: ModelMention,
  info: ComposerModelInfo | null,
  activeSegment: ModelChipSegment | null,
): void {
  const token = formatModelMentionToken(mention);
  chip.dataset.composerChipText = token;
  chip.dataset.modelId = mention.modelId;
  const title = info?.title ?? mention.modelId;
  chip.title = `${title}${info?.subtitle ? ` · ${info.subtitle}` : ""} — ${token}`;
  chip.replaceChildren();

  const name = document.createElement("span");
  name.className = NAME_CLASS;
  const glyph = document.createElement("span");
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "✦";
  glyph.className = "text-amber-200/80";
  const label = document.createElement("span");
  label.dataset.composerChipLabel = "true";
  label.className = "truncate";
  label.textContent = info ? title : `${title} (unavailable)`;
  name.append(glyph, label);
  chip.appendChild(name);

  for (const segment of modelChipSegments(info)) {
    const part = document.createElement("span");
    part.dataset.modelSegment = segment;
    part.className = segment === activeSegment ? SEGMENT_ACTIVE_CLASS : SEGMENT_CLASS;
    part.textContent = segment === "effort"
      ? modelMentionEffortLabel(mention.effort)
      : modelMentionPermissionLabel(mention.permission);
    chip.appendChild(part);
  }
}

/** "Harness · route" for a model, e.g. "OpenCode · OpenCode Go". */
export function composerModelSubtitle(descriptor: ModelDescriptor): string {
  const harness = modelMentionHarnessLabel(resolveProviderGroupForModel(descriptor));
  return modelMentionSubtitle(harness, subProviderLabel(descriptor));
}

export function composerModelInfo(descriptor: ModelDescriptor | null | undefined): ComposerModelInfo | null {
  if (!descriptor) return null;
  return {
    title: descriptor.displayName,
    subtitle: composerModelSubtitle(descriptor),
    reasoningTiers: descriptor.reasoningTiers ?? [],
  };
}

export function composerModelSuggestion(descriptor: ModelDescriptor): ComposerModelSuggestion {
  const tiers = descriptor.reasoningTiers ?? [];
  return {
    modelId: descriptor.id,
    title: descriptor.displayName,
    subtitle: composerModelSubtitle(descriptor),
    reasoningTiers: tiers,
    defaultEffort: selectSupportedReasoningEffort({ tiers, advertisedDefault: descriptor.defaultReasoningEffort ?? null }),
  };
}
