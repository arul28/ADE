import type {
  AgentChatClaudePermissionMode,
  AgentChatPermissionMode,
  AgentChatDroidPermissionMode,
  AgentChatMusePermissionMode,
  AgentChatOpenCodePermissionMode,
} from "../../../shared/types";
import {
  DROID_PERMISSION_OPTIONS as BASE_DROID_PERMISSION_OPTIONS,
  MUSE_PERMISSION_OPTIONS as BASE_MUSE_PERMISSION_OPTIONS,
} from "../../lib/nativeLaunchControls";
import type { PermissionOption, SafetyLevel } from "./permissionOptions";
import { modelPermissionOptions } from "../../../shared/modelPermissions";
import type {
  PermissionModeIconKind,
  PermissionModePickerOption,
  PermissionModeTone,
} from "./PermissionModePicker";

/**
 * The options every `PermissionModePicker` shows, per provider: labels, the
 * one-line detail, and the tone and glyph of each mode.
 *
 * The chat composer, the launch dialogs (Linear and GitHub issue launch,
 * project move, agent setup) and the composer's model chip all read these, so a
 * mode looks and reads the same wherever a chat's permissions are picked or
 * shown. The launch dialogs and the chip used to carry their own copies.
 */

export const CLAUDE_MODE_OPTIONS: Array<PermissionModePickerOption<AgentChatClaudePermissionMode>> = [
  { value: "default", label: "Manual", detail: "Asks before edits, Bash and risky tools.", tone: "green", icon: "manual" },
  { value: "auto", label: "Auto", detail: "A safety model approves each tool call.", tone: "amber", icon: "auto" },
  { value: "acceptEdits", label: "Accept edits", triggerLabel: "Edits", detail: "Edits auto-approved; risky actions still ask.", tone: "amber", icon: "edit" },
  { value: "plan", label: "Plan mode", triggerLabel: "Plan", detail: "Read-only: analyze and plan.", tone: "purple", icon: "plan" },
  { value: "bypassPermissions", label: "Bypass", detail: "Never asks for permission in this chat.", tone: "red", icon: "full" },
];

export type CodexPermissionPreset = "default" | "edit" | "plan" | "full-auto" | "config-toml" | "custom";

const CODEX_PRESET_PRESENTATION: Record<
  Exclude<CodexPermissionPreset, "custom">,
  Pick<PermissionModePickerOption, "triggerLabel" | "tone" | "icon">
> = {
  default: { triggerLabel: "Default", tone: "green", icon: "manual" },
  edit: { triggerLabel: "Edit", tone: "amber", icon: "edit" },
  plan: { triggerLabel: "Plan", tone: "purple", icon: "plan" },
  "full-auto": { triggerLabel: "Full", tone: "red", icon: "full" },
  "config-toml": { triggerLabel: "Config", tone: "slate", icon: "config" },
};

function isCodexPreset(value: string): value is Exclude<CodexPermissionPreset, "custom"> {
  return Object.prototype.hasOwnProperty.call(CODEX_PRESET_PRESENTATION, value);
}

export function codexPermissionPickerOption(option: PermissionOption): PermissionModePickerOption<Exclude<CodexPermissionPreset, "custom">> {
  const value = isCodexPreset(option.value) ? option.value : "default";
  return { value, label: option.label, detail: option.detail, ...CODEX_PRESET_PRESENTATION[value] };
}

export function cursorPermissionPickerOption(value: string, label: string): PermissionModePickerOption<string> {
  const normalized = value.trim().toLowerCase();
  if (normalized === "plan") {
    return { value, label, triggerLabel: label, detail: "Read-only planning mode.", tone: "purple", icon: "plan" };
  }
  if (normalized === "ask" || normalized === "edit") {
    return { value, label, triggerLabel: label, detail: "Read-only Q&A mode.", tone: "green", icon: "manual" };
  }
  if (normalized === "full-auto" || normalized === "force" || normalized === "yolo") {
    return { value, label, triggerLabel: label, detail: "Highest access mode for Cursor Agent.", tone: "red", icon: "full" };
  }
  return { value, label, triggerLabel: label, detail: "Cursor Agent's normal approval flow.", tone: "green", icon: "agent" };
}

export const OPENCODE_PERMISSION_OPTIONS: Array<PermissionModePickerOption<AgentChatOpenCodePermissionMode>> = [
  { value: "plan", label: "Plan", detail: "Read-only plan agent.", tone: "purple", icon: "plan" },
  { value: "edit", label: "Edit", detail: "Allow edits; ask for the rest.", tone: "amber", icon: "edit" },
  { value: "full-auto", label: "Full auto", detail: "Allow configured OpenCode tools.", tone: "red", icon: "full" },
  { value: "config-toml", label: "Config", detail: "Use OpenCode config files.", tone: "slate", icon: "config" },
];

const DROID_PERMISSION_OPTION_PRESENTATION: Record<AgentChatDroidPermissionMode, Pick<PermissionModePickerOption<AgentChatDroidPermissionMode>, "triggerLabel" | "tone" | "icon">> = {
  "read-only": { tone: "green", icon: "manual" },
  "auto-low": { tone: "green", icon: "edit" },
  "auto-medium": { tone: "amber", icon: "auto" },
  "auto-high": { tone: "red", icon: "full" },
  agi: { triggerLabel: "AGI", tone: "purple", icon: "agi" },
};
export const DROID_PERMISSION_OPTIONS: Array<PermissionModePickerOption<AgentChatDroidPermissionMode>> =
  BASE_DROID_PERMISSION_OPTIONS.map((option) => ({ ...option, ...DROID_PERMISSION_OPTION_PRESENTATION[option.value] }));

/** Muse's approval modes plus ADE's plan mode, which runs on `denyUnmatched`. */
export type MusePermissionPickerValue = AgentChatMusePermissionMode | "plan";
const MUSE_PERMISSION_OPTION_PRESENTATION: Record<AgentChatMusePermissionMode, Pick<PermissionModePickerOption<MusePermissionPickerValue>, "triggerLabel" | "tone" | "icon">> = {
  denyUnmatched: { triggerLabel: "Read-only", tone: "green", icon: "manual" },
  promptUnmatched: { tone: "green", icon: "edit" },
  onRequest: { tone: "amber", icon: "auto" },
  allowAll: { triggerLabel: "Full", tone: "red", icon: "full" },
};
export const MUSE_PERMISSION_OPTIONS: Array<PermissionModePickerOption<MusePermissionPickerValue>> = [
  { value: "plan", label: "Plan", detail: "Read-only planning with ADE's guidance.", tone: "purple", icon: "plan" },
  ...BASE_MUSE_PERMISSION_OPTIONS.map((option) => ({ ...option, ...MUSE_PERMISSION_OPTION_PRESENTATION[option.value] })),
];

// ── Presentation by value ───────────────────────────────────────────────────
// For surfaces that show a mode without opening the picker (the composer's model
// chip, its hover card): the same tone and glyph, read from the tables above.

export type PermissionModePresentation = { tone: PermissionModeTone; icon: PermissionModeIconKind };

export type ModelChipPermissionOption = {
  value: string;
  label: string;
  tone: PermissionModeTone;
  icon: PermissionModeIconKind;
};

const FALLBACK_PRESENTATION: PermissionModePresentation = { tone: "green", icon: "manual" };

function presentationIn(options: Array<PermissionModePickerOption>, value: string): PermissionModePresentation | null {
  const match = options.find((option) => option.value === value);
  return match ? { tone: match.tone, icon: match.icon } : null;
}

/** The tone and glyph the picker shows for a provider's native permission mode. */
export function permissionModePresentation(
  provider: string | null | undefined,
  value: string,
): PermissionModePresentation {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "claude") return presentationIn(CLAUDE_MODE_OPTIONS, value) ?? FALLBACK_PRESENTATION;
  if (p === "codex") {
    if (!isCodexPreset(value)) return FALLBACK_PRESENTATION;
    const { tone, icon } = CODEX_PRESET_PRESENTATION[value];
    return { tone, icon };
  }
  if (p === "cursor") {
    const { tone, icon } = cursorPermissionPickerOption(value, value);
    return { tone, icon };
  }
  if (p === "droid" || p === "factory") return presentationIn(DROID_PERMISSION_OPTIONS, value) ?? FALLBACK_PRESENTATION;
  if (p === "muse") return presentationIn(MUSE_PERMISSION_OPTIONS, value) ?? FALLBACK_PRESENTATION;
  return presentationIn(OPENCODE_PERMISSION_OPTIONS, value) ?? FALLBACK_PRESENTATION;
}

/** The model chip's permission menu: the provider's modes with their presentation. */
export function modelPermissionChipOptions(provider: string | null | undefined): ModelChipPermissionOption[] {
  return modelPermissionOptions(provider).map((option) => ({
    value: option.value,
    label: option.label,
    ...permissionModePresentation(provider, option.value),
  }));
}

/** Text colour for a permission tone, matching the picker's glyph colouring. */
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

// ── ADE's unified permission modes ──────────────────────────────────────────
// Surfaces that store the provider-neutral mode (`permissionOptions.ts`) rather
// than a provider's native one: automations, the Linear agent, PR resolvers and
// the cross-machine handoff.

/**
 * `permissionOptions.ts` describes an option by safety level, while the picker
 * pill styles by tone. Both maps are keyed on the real unions rather than
 * `Record<string, …>`: the first draft invented its own key names, every lookup
 * silently fell through to the default tone, and the whole row rendered grey
 * while the composer's rendered green/amber/red. An exhaustive Record makes the
 * compiler name any key a union gains.
 */
export const PERMISSION_SAFETY_TONES: Record<SafetyLevel, PermissionModeTone> = {
  safe: "green",
  "semi-auto": "amber",
  "full-auto": "red",
  danger: "red",
  custom: "slate",
};

export const PERMISSION_MODE_ICONS: Record<AgentChatPermissionMode, PermissionModeIconKind> = {
  default: "manual",
  auto: "auto",
  plan: "plan",
  edit: "edit",
  "full-auto": "full",
  "config-toml": "config",
};

/** Maps a shared PermissionOption onto the picker's display shape. */
export function toPermissionPickerOption(option: PermissionOption): PermissionModePickerOption<AgentChatPermissionMode> {
  return {
    value: option.value,
    label: option.label,
    detail: option.shortDesc,
    tone: PERMISSION_SAFETY_TONES[option.safety],
    icon: PERMISSION_MODE_ICONS[option.value],
  };
}
