// The one presentation table for permission modes: the tone, glyph and short
// trigger word every `PermissionModePicker` (the composer footer, the launch
// controls, the cross-machine handoff modal) and the model chip show for a
// provider's mode.
//
// Values, labels and details are owned by `shared/modelPermissions.ts`; this
// module only attaches the desktop presentation. Build picker rows with
// `modelPermissionPickerOptions` rather than writing a list by hand.

import {
  COPILOT_PERMISSION_MODES,
  cursorModeDetail,
  modelPermissionOptions,
  MUSE_PERMISSION_MODES,
  MUSE_PLAN_MODE,
} from "../../shared/modelPermissions";
import type { AgentChatMusePermissionMode } from "../../shared/types/chat";
import type {
  PermissionModeIconKind,
  PermissionModePickerOption,
  PermissionModeTone,
} from "../components/shared/PermissionModePicker";

export type ModelPermissionPresentation = {
  tone: PermissionModeTone;
  icon: PermissionModeIconKind;
  /**
   * The short word the collapsed pill shows when the full label will not fit.
   * The open menu still reads out the full one.
   */
  triggerLabel?: string;
};

export type ModelChipPermissionOption = {
  value: string;
  label: string;
  tone: PermissionModeTone;
  icon: PermissionModeIconKind;
};

const CLAUDE_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  default: { tone: "green", icon: "manual" },
  auto: { tone: "amber", icon: "auto" },
  acceptEdits: { tone: "amber", icon: "edit", triggerLabel: "Edits" },
  plan: { tone: "purple", icon: "plan", triggerLabel: "Plan" },
  bypassPermissions: { tone: "red", icon: "full" },
};

const CODEX_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  default: { tone: "green", icon: "manual", triggerLabel: "Default" },
  edit: { tone: "amber", icon: "edit", triggerLabel: "Edit" },
  plan: { tone: "purple", icon: "plan", triggerLabel: "Plan" },
  "full-auto": { tone: "red", icon: "full", triggerLabel: "Full" },
  "config-toml": { tone: "slate", icon: "config", triggerLabel: "Config" },
};

const OPENCODE_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  plan: { tone: "purple", icon: "plan" },
  edit: { tone: "amber", icon: "edit" },
  "full-auto": { tone: "red", icon: "full" },
  "config-toml": { tone: "slate", icon: "config" },
};

const CURSOR_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  plan: { tone: "purple", icon: "plan" },
  ask: { tone: "green", icon: "manual" },
  agent: { tone: "green", icon: "agent" },
  "full-auto": { tone: "red", icon: "full" },
};

/** Other names a connected Cursor CLI may report for the modes above. */
const CURSOR_MODE_ALIASES: Record<string, string> = { edit: "ask", force: "full-auto", yolo: "full-auto" };

/** A Cursor mode the CLI reported that ADE has no row for reads as an agent mode. */
const CURSOR_UNKNOWN_MODE_PRESENTATION: ModelPermissionPresentation = { tone: "green", icon: "agent" };

const DROID_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  "read-only": { tone: "green", icon: "manual" },
  "auto-low": { tone: "green", icon: "edit" },
  "auto-medium": { tone: "amber", icon: "auto" },
  "auto-high": { tone: "red", icon: "full" },
  agi: { tone: "purple", icon: "agi", triggerLabel: "AGI" },
};

const MUSE_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  denyUnmatched: { tone: "green", icon: "manual", triggerLabel: "Read-only" },
  promptUnmatched: { tone: "green", icon: "edit" },
  onRequest: { tone: "amber", icon: "auto" },
  allowAll: { tone: "red", icon: "full", triggerLabel: "Full" },
};

/**
 * Copilot's own modes. Kept out of `modelPermissionPresentation`, which the
 * model chip calls with `copilot` and expects OpenCode's table back (the chip
 * offers OpenCode's modes for Copilot today).
 */
const COPILOT_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  plan: { tone: "slate", icon: "plan" },
  ask: { tone: "slate", icon: "manual" },
  assisted: { tone: "purple", icon: "agent" },
  "auto-edit": { tone: "amber", icon: "edit" },
  "full-auto": { tone: "red", icon: "full" },
};

const FALLBACK: ModelPermissionPresentation = { tone: "green", icon: "manual" };

/** The tone and glyph the footer shows for a provider's native permission mode. */
export function modelPermissionPresentation(
  provider: string | null | undefined,
  value: string,
): ModelPermissionPresentation {
  const p = String(provider ?? "").trim().toLowerCase();
  const table = p === "claude"
    ? CLAUDE_PRESENTATION
    : p === "codex"
      ? CODEX_PRESENTATION
      : p === "cursor"
        ? CURSOR_PRESENTATION
        : p === "droid" || p === "factory"
          ? DROID_PRESENTATION
          : p === "muse"
            ? MUSE_PRESENTATION
            : OPENCODE_PRESENTATION;
  return table[value] ?? FALLBACK;
}

/** The chip's permission menu options: the provider's modes with their presentation. */
export function modelPermissionChipOptions(provider: string | null | undefined): ModelChipPermissionOption[] {
  return modelPermissionOptions(provider).map((option) => {
    const { tone, icon } = modelPermissionPresentation(provider, option.value);
    return { value: option.value, label: option.label, tone, icon };
  });
}

function pickerOption<Value extends string>(
  option: { value: Value; label: string; detail: string },
  presentation: ModelPermissionPresentation,
): PermissionModePickerOption<Value> {
  return {
    value: option.value,
    label: option.label,
    ...(presentation.triggerLabel ? { triggerLabel: presentation.triggerLabel } : {}),
    detail: option.detail,
    tone: presentation.tone,
    icon: presentation.icon,
  };
}

/**
 * The permission menu's rows for a provider: a value/label/detail list (from
 * `shared/modelPermissions.ts`, or ADE's generic vocabulary for Codex's footer)
 * wearing this table's tone, glyph and short trigger word.
 *
 * Every surface that shows the permission menu builds its rows here and renders
 * them through `PermissionModePicker`. A launch toolbar that draws its own list
 * instead gets a lookalike that a dialog's scroll container can clip.
 */
export function modelPermissionPickerOptions<Value extends string>(
  provider: string | null | undefined,
  options: ReadonlyArray<{ value: Value; label: string; detail: string }>,
): Array<PermissionModePickerOption<Value>> {
  return options.map((option) => pickerOption(option, modelPermissionPresentation(provider, option.value)));
}

/**
 * Rows for the modes a connected Cursor CLI reports. Unlike the chip's fixed
 * list these ids are open-ended, so a mode ADE has never seen still gets a
 * description and reads as an agent mode.
 */
export function cursorModePickerOptions(
  modes: ReadonlyArray<{ value: string; label: string }>,
): Array<PermissionModePickerOption<string>> {
  return modes.map((mode) => {
    const normalized = mode.value.trim().toLowerCase();
    const key = Object.hasOwn(CURSOR_MODE_ALIASES, normalized) ? CURSOR_MODE_ALIASES[normalized]! : normalized;
    return pickerOption(
      { value: mode.value, label: mode.label, detail: cursorModeDetail(mode.value) },
      Object.hasOwn(CURSOR_PRESENTATION, key) ? CURSOR_PRESENTATION[key]! : CURSOR_UNKNOWN_MODE_PRESENTATION,
    );
  });
}

/**
 * Muse's rows for the composer footer: ADE's plan mode first, then Muse's own
 * approval modes. Plan is not a Muse value, so it stays out of `MUSE_PRESENTATION`
 * (the chip reads that table for whatever value a token carries).
 */
export const MUSE_PERMISSION_PICKER_OPTIONS: Array<PermissionModePickerOption<AgentChatMusePermissionMode | "plan">> = [
  pickerOption(MUSE_PLAN_MODE, { tone: "purple", icon: "plan" }),
  ...modelPermissionPickerOptions("muse", MUSE_PERMISSION_MODES),
];

/** Copilot's rows for the composer footer. */
export const COPILOT_PERMISSION_PICKER_OPTIONS = COPILOT_PERMISSION_MODES.map((mode) =>
  pickerOption(mode, COPILOT_PRESENTATION[mode.value] ?? FALLBACK));

/** Text colour for a permission tone, matching the footer's glyph colouring. */
export function permissionToneTextClass(tone: PermissionModeTone): string {
  switch (tone) {
    case "green": return "text-emerald-300/90";
    case "amber": return "text-amber-300/90";
    case "blue": return "text-sky-300/90";
    case "purple": return "text-violet-300/90";
    case "red": return "text-red-300/95";
    case "slate":
    default:
      return "text-fg/70";
  }
}
