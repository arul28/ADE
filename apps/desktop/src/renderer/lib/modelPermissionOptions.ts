// The one presentation table for permission modes: the tone and glyph every
// `PermissionModePicker` (the composer footer, the launch controls, the PR
// resolver, the automation forms, the handoff tab) and the model chip show for
// a provider's mode.
//
// Values, labels and details are owned by `shared/modelPermissions.ts`; this
// module only attaches the desktop presentation. Build picker rows with
// `modelPermissionPickerOptions` rather than writing a list by hand.
//
// A provider shows one name for a mode on every surface that reads its native
// vocabulary. The PR resolver and the automation forms store ADE's generic word
// instead, so they read the generic ladder; Copilot's models reach them through
// `familyToPermissionKey`'s `acp` key, so those two surfaces still say
// "Accept edits" / "Full access" where the composer says "Auto-edit" /
// "Full-auto". Unifying that needs a mapping for the modes Copilot has and the
// generic ladder does not (`assisted`, and an `auto` with no Copilot twin).

import {
  COPILOT_PERMISSION_MODES,
  cursorModeDetail,
  hasNativePermissionVocabulary,
  legacyPermissionToNative,
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

export type ModelPermissionPresentation = { tone: PermissionModeTone; icon: PermissionModeIconKind };

export type ModelChipPermissionOption = {
  value: string;
  label: string;
  tone: PermissionModeTone;
  icon: PermissionModeIconKind;
};

const CLAUDE_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  default: { tone: "green", icon: "manual" },
  auto: { tone: "amber", icon: "auto" },
  acceptEdits: { tone: "amber", icon: "edit" },
  plan: { tone: "purple", icon: "plan" },
  bypassPermissions: { tone: "red", icon: "full" },
};

const CODEX_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  default: { tone: "green", icon: "manual" },
  edit: { tone: "amber", icon: "edit" },
  plan: { tone: "purple", icon: "plan" },
  "full-auto": { tone: "red", icon: "full" },
  "config-toml": { tone: "slate", icon: "config" },
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
  agi: { tone: "purple", icon: "agi" },
};

const MUSE_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  denyUnmatched: { tone: "green", icon: "manual" },
  promptUnmatched: { tone: "green", icon: "edit" },
  onRequest: { tone: "amber", icon: "auto" },
  allowAll: { tone: "red", icon: "full" },
};

const COPILOT_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  plan: { tone: "slate", icon: "plan" },
  ask: { tone: "slate", icon: "manual" },
  assisted: { tone: "purple", icon: "agent" },
  "auto-edit": { tone: "amber", icon: "edit" },
  "full-auto": { tone: "red", icon: "full" },
};

const FALLBACK: ModelPermissionPresentation = { tone: "green", icon: "manual" };

/** Each provider's table. `factory` is Droid's other name. */
const TABLE_BY_PROVIDER: Record<string, Record<string, ModelPermissionPresentation>> = {
  claude: CLAUDE_PRESENTATION,
  codex: CODEX_PRESENTATION,
  cursor: CURSOR_PRESENTATION,
  droid: DROID_PRESENTATION,
  factory: DROID_PRESENTATION,
  muse: MUSE_PRESENTATION,
  copilot: COPILOT_PRESENTATION,
  opencode: OPENCODE_PRESENTATION,
};

/** The tone and glyph the footer shows for a provider's native permission mode. */
export function modelPermissionPresentation(
  provider: string | null | undefined,
  value: string,
): ModelPermissionPresentation {
  const p = String(provider ?? "").trim().toLowerCase();
  const table = Object.hasOwn(TABLE_BY_PROVIDER, p) ? TABLE_BY_PROVIDER[p]! : OPENCODE_PRESENTATION;
  return Object.hasOwn(table, value) ? table[value]! : FALLBACK;
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
    detail: option.detail,
    tone: presentation.tone,
    icon: presentation.icon,
  };
}

/**
 * The permission menu's rows for a provider: a value/label/detail list from
 * `shared/modelPermissions.ts`, wearing this table's tone and glyph.
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

/** Copilot's rows for the composer footer and the launch controls. */
export const COPILOT_PERMISSION_PICKER_OPTIONS = modelPermissionPickerOptions("copilot", COPILOT_PERMISSION_MODES);

/**
 * The row that names a Codex approval/sandbox combination ADE has no preset
 * for. It only ever describes the current state — picking it does nothing —
 * so the three surfaces that show it share this one sentence.
 */
export const CODEX_CUSTOM_PICKER_OPTION: PermissionModePickerOption<"custom"> = {
  value: "custom",
  label: "Custom",
  detail: "A Codex approval and sandbox combination ADE has no preset for. Picking a mode replaces it.",
  tone: "slate",
  icon: "config",
};

/**
 * ADE's generic words (`AgentChatPermissionMode`) by meaning, for providers
 * that have no native vocabulary of their own (the ACP agents, Antigravity).
 */
const GENERIC_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  plan: { tone: "purple", icon: "plan" },
  default: { tone: "green", icon: "manual" },
  edit: { tone: "amber", icon: "edit" },
  auto: { tone: "amber", icon: "auto" },
  "full-auto": { tone: "red", icon: "full" },
  "config-toml": { tone: "slate", icon: "config" },
};

/** The tone and glyph for one of ADE's generic words, by what it means. */
function genericPresentation(value: string): ModelPermissionPresentation {
  return Object.hasOwn(GENERIC_PRESENTATION, value) ? GENERIC_PRESENTATION[value]! : FALLBACK;
}

/**
 * Rows for surfaces that store ADE's generic word rather than the provider's
 * own (the PR resolver, the automation forms). Each row wears the tone and
 * glyph of the native mode its word launches, so Plan reads purple and Bypass
 * red here exactly as in the composer. `provider` is a provider group or an
 * automation permission key (`acp` has no native vocabulary).
 *
 * Two generic words can land on one native mode — OpenCode's `default` and
 * `edit` both mean its `edit`, Cursor's `default` and `edit` both mean its
 * `agent` — so those two rows share a glyph and colour. Their labels still
 * differ, and the tone they share is the right one for both, which is why they
 * are left alone: demoting either to its by-meaning tone would read as a
 * stronger claim than the row makes. Cursor's `edit` is labelled "Ask" and is a
 * read-only mode, so an amber edit glyph on it would say the opposite. Fixing
 * this properly means resolving the Cursor ladder's own generic-to-native
 * mapping, which changes what an automation launches.
 */
export function genericPermissionPickerOptions<Value extends string>(
  provider: string | null | undefined,
  options: ReadonlyArray<{ value: Value; label: string; shortDesc: string }>,
): Array<PermissionModePickerOption<Value>> {
  const p = String(provider ?? "").trim().toLowerCase();
  return options.map((option) => {
    const mode = hasNativePermissionVocabulary(p) ? legacyPermissionToNative(p, option.value) : null;
    const presentation = mode ? modelPermissionPresentation(p, mode) : genericPresentation(option.value);
    return pickerOption({ value: option.value, label: option.label, detail: option.shortDesc }, presentation);
  });
}

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
