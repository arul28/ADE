// The composer's model chip: one pill with three parts.
//
//   [ <maker logo> DeepSeek V4.1 Flash │ High │ <permission icon> ] <harness><route>
//
// The name part is fixed and carries the maker's logo. The thinking part and
// the permission part are "segments" the user edits in place: Tab walks name →
// thinking → permission → out of the chip, and each segment opens a small list
// of its values. The chip's `data-composer-chip-text` is always the canonical
// `@model:` token, so serialization, copy, and send need nothing special.
//
// The permission segment shows only the footer `PermissionModePicker`'s icon for
// the mode (a red shield for Claude "Bypass"); its word lives in the opened list
// and the hover title. Thinking stays text, coloured with the footer reasoning
// control's colour for that model's tiers.

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatModelMentionToken,
  modelMentionHarnessLabel,
  modelMentionSubtitle,
  type ComposerModelSuggestion,
  type ModelMention,
} from "../../../shared/modelMentions";
import { modelPermissionLabel, defaultModelPermission, resolveModelPermissionValue } from "../../../shared/modelPermissions";
import {
  resolveProviderGroupForModel,
  selectSupportedReasoningEffort,
  usesCodexNamedEffortLabels,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { subProviderKey, subProviderLabel } from "../shared/ModelPicker/modelFacts";
import {
  reasoningEffortTierLabel,
  reasoningEffortToneColor,
} from "../shared/ModelPicker/ReasoningEffortPicker";
import { ModelRowLogo, ProviderLogo } from "../shared/ProviderLogos";
import { PermissionModeGlyph } from "../shared/PermissionModePicker";
import { modelPermissionChipOptions, permissionToneTextClass } from "../../lib/modelPermissionOptions";
import { cn } from "../ui/cn";

export type { ComposerModelSuggestion };

export type ModelChipSegment = "effort" | "perm";

export type ModelChipOption = {
  value: string;
  label: string;
  /** Footer tone/glyph for a permission option. Absent for thinking options. */
  tone?: import("../shared/PermissionModePicker").PermissionModeTone;
  icon?: import("../shared/PermissionModePicker").PermissionModeIconKind;
};

/** What the chip needs to know about its model. Null when the catalog lacks it. */
export type ComposerModelInfo = {
  title: string;
  /** "Harness · route", e.g. "OpenCode · OpenCode Go". */
  subtitle: string;
  /** Chat runtime provider: claude, codex, opencode, cursor, … */
  provider: string;
  /** The harness's display label (Claude Code, OpenCode, …) for the hover title. */
  harness: string;
  /** A distinct sub-provider route, or null when the route repeats the harness. */
  routeKey: string | null;
  routeLabel: string | null;
  reasoningTiers: string[];
  // Descriptor fields the maker logo needs to pick its mark.
  modelFamily: string;
  cliCommand?: string;
  providerModelId?: string;
  openCodeProviderId?: string;
};

export const COMPOSER_MODEL_CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[24rem] translate-y-px items-center overflow-hidden rounded border border-amber-300/25 bg-amber-500/10 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-4 text-amber-50/90 align-baseline";
const NAME_CLASS = "flex min-w-0 items-center gap-1 px-1 py-px";
const SEGMENT_CLASS = "shrink-0 cursor-pointer border-l border-amber-300/20 px-1 py-px text-amber-100/70 hover:bg-amber-400/15";
const SEGMENT_ACTIVE_CLASS = "shrink-0 cursor-pointer border-l border-amber-300/20 px-1 py-px bg-amber-400/30 text-amber-50";
const LOGO_CLASSES = "ade-model-chip-logo inline-flex shrink-0 items-center gap-0.5 [&_img]:block [&_svg]:block";

/** Render a React mark to static markup so it can live inside the chip's DOM node. */
function markHtml(node: ReactElement): string {
  try {
    return renderToStaticMarkup(node);
  } catch {
    return "";
  }
}

function logoGroup(innerHtml: string): HTMLSpanElement {
  const group = document.createElement("span");
  group.className = LOGO_CLASSES;
  group.setAttribute("aria-hidden", "true");
  group.innerHTML = innerHtml;
  return group;
}

/** The maker / harness / route marks for a chip, in display order. */
export function modelChipLogos(info: ComposerModelInfo | null): { maker: string; right: string } {
  if (!info) return { maker: "", right: "" };
  const maker = markHtml(createElement(ModelRowLogo, {
    modelFamily: info.modelFamily,
    cliCommand: info.cliCommand,
    modelId: undefined,
    providerModelId: info.providerModelId,
    openCodeProviderId: info.openCodeProviderId,
    size: 12,
  }));
  const harness = markHtml(createElement(ProviderLogo, { family: info.provider, size: 11 }));
  const route = info.routeKey
    ? markHtml(createElement(ProviderLogo, { family: info.routeKey, size: 11 }))
    : "";
  return { maker, right: `${harness}${route}` };
}

export function modelChipOptions(segment: ModelChipSegment, info: ComposerModelInfo | null): ModelChipOption[] {
  if (segment === "perm") {
    return info ? modelPermissionChipOptions(info.provider) : [];
  }
  const tiers = info?.reasoningTiers ?? [];
  const codexLabels = usesCodexNamedEffortLabels(info?.providerModelId);
  return tiers.map((value) => ({ value, label: reasoningEffortTierLabel(value, codexLabels) }));
}

/** Segments this chip can edit, in Tab order. A model without levels skips thinking. */
export function modelChipSegments(info: ComposerModelInfo | null): ModelChipSegment[] {
  return info && info.reasoningTiers.length > 0 ? ["effort", "perm"] : ["perm"];
}

/** The token a fresh chip starts with: the model's default level and mode. */
export function initialModelMention(suggestion: ComposerModelSuggestion): ModelMention {
  return {
    modelId: suggestion.modelId,
    effort: suggestion.defaultEffort,
    permission: suggestion.defaultPermission ?? defaultModelPermission(suggestion.provider),
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
  chip.title = modelChipHoverTitle(mention, info);
  chip.replaceChildren();

  const logos = modelChipLogos(info);
  const name = document.createElement("span");
  name.className = NAME_CLASS;
  if (logos.maker) {
    name.appendChild(logoGroup(logos.maker));
  }
  const label = document.createElement("span");
  label.dataset.composerChipLabel = "true";
  label.className = "truncate";
  label.textContent = info ? title : `${title} (unavailable)`;
  name.append(label);
  chip.appendChild(name);

  const segments = modelChipSegments(info);
  for (const segment of segments) {
    const part = document.createElement("span");
    part.dataset.modelSegment = segment;
    part.className = segment === activeSegment ? SEGMENT_ACTIVE_CLASS : SEGMENT_CLASS;
    if (segment === "effort") {
      part.textContent = mention.effort
        ? reasoningEffortTierLabel(mention.effort, usesCodexNamedEffortLabels(info?.providerModelId))
        : "Default";
      if (info) part.style.color = reasoningEffortToneColor(mention.effort, info.reasoningTiers);
    } else {
      const options = modelChipOptions("perm", info);
      const resolvedPermission = resolveModelPermissionValue(info?.provider, mention.permission);
      const selected = options.find((option) => option.value === resolvedPermission) ?? options[0];
      part.title = `Permissions: ${modelPermissionLabel(info?.provider, mention.permission)}`;
      if (selected?.icon) {
        part.appendChild(logoGroup(markHtml(createElement(PermissionModeGlyph, {
          icon: selected.icon,
          size: 11,
          className: cn(permissionToneTextClass(selected.tone ?? "green")),
        }))));
      } else {
        part.textContent = modelPermissionLabel(info?.provider, mention.permission);
      }
    }
    chip.appendChild(part);
  }

  // Harness + route marks sit after the editable parts, outside the pill chrome.
  if (logos.right) chip.appendChild(logoGroup(logos.right));
}

/** `DeepSeek V4.1 Flash · OpenCode · OpenCode Go · High · Bypass`. */
export function modelChipHoverTitle(mention: ModelMention, info: ComposerModelInfo | null): string {
  if (!info) return `${mention.modelId} (unavailable)`;
  const parts: string[] = [info.title, info.harness];
  if (info.routeLabel) parts.push(info.routeLabel);
  if (mention.effort) parts.push(reasoningEffortTierLabel(mention.effort, usesCodexNamedEffortLabels(info.providerModelId)));
  parts.push(modelPermissionLabel(info.provider, mention.permission));
  return parts.filter(Boolean).join(" · ");
}

/** "Harness · route" for a model, e.g. "OpenCode · OpenCode Go". */
export function composerModelSubtitle(descriptor: ModelDescriptor): string {
  const harness = modelMentionHarnessLabel(resolveProviderGroupForModel(descriptor));
  return modelMentionSubtitle(harness, subProviderLabel(descriptor));
}

/** A distinct route key for the right-hand marks, or null when it repeats the harness. */
function composerModelRoute(descriptor: ModelDescriptor): { routeKey: string | null; routeLabel: string | null } {
  const harness = resolveProviderGroupForModel(descriptor);
  const label = subProviderLabel(descriptor);
  if (!label) return { routeKey: null, routeLabel: null };
  const key = subProviderKey(descriptor);
  const trimmedKey = key && key !== "__default__" ? key : null;
  if (!trimmedKey) return { routeKey: null, routeLabel: null };
  return { routeKey: trimmedKey, routeLabel: label };
}

export function composerModelInfo(descriptor: ModelDescriptor | null | undefined): ComposerModelInfo | null {
  if (!descriptor) return null;
  const harness = resolveProviderGroupForModel(descriptor);
  const { routeKey, routeLabel } = composerModelRoute(descriptor);
  return {
    title: descriptor.displayName,
    subtitle: composerModelSubtitle(descriptor),
    provider: harness,
    harness: modelMentionHarnessLabel(harness),
    routeKey,
    routeLabel,
    reasoningTiers: descriptor.reasoningTiers ?? [],
    modelFamily: descriptor.family,
    cliCommand: descriptor.cliCommand,
    providerModelId: descriptor.providerModelId,
    openCodeProviderId: descriptor.openCodeProviderId,
  };
}

export function composerModelSuggestion(descriptor: ModelDescriptor): ComposerModelSuggestion {
  const tiers = descriptor.reasoningTiers ?? [];
  const harness = resolveProviderGroupForModel(descriptor);
  const { routeKey, routeLabel } = composerModelRoute(descriptor);
  return {
    modelId: descriptor.id,
    title: descriptor.displayName,
    subtitle: modelMentionSubtitle(modelMentionHarnessLabel(harness), subProviderLabel(descriptor)),
    provider: harness,
    reasoningTiers: tiers,
    defaultEffort: selectSupportedReasoningEffort({ tiers, advertisedDefault: descriptor.defaultReasoningEffort ?? null }),
    defaultPermission: defaultModelPermission(harness),
    modelFamily: descriptor.family,
    cliCommand: descriptor.cliCommand,
    providerModelId: descriptor.providerModelId,
    openCodeProviderId: descriptor.openCodeProviderId,
    routeKey,
    routeLabel,
  };
}
