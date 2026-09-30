// Presentation for the model chip's permission options: the tone and glyph the
// composer footer's `PermissionModePicker` already uses for each value.
//
// The values and labels are owned by `shared/modelPermissions.ts`; this module
// only attaches the desktop presentation. It deliberately mirrors the footer
// tables in `AgentChatComposer.tsx` (`CLAUDE_MODE_OPTIONS`,
// `OPENCODE_PERMISSION_OPTIONS`, `DROID_PERMISSION_OPTIONS`,
// `codexPermissionPickerOption`, `cursorPermissionPickerOption`) so the chip and
// the footer show the same icon and colour for the same mode. Keep them in sync.

import { modelPermissionOptions } from "../../shared/modelPermissions";
import type {
  PermissionModeIconKind,
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

const DROID_PRESENTATION: Record<string, ModelPermissionPresentation> = {
  "read-only": { tone: "green", icon: "manual" },
  "auto-low": { tone: "green", icon: "edit" },
  "auto-medium": { tone: "amber", icon: "auto" },
  "auto-high": { tone: "red", icon: "full" },
  agi: { tone: "purple", icon: "agi" },
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
          : OPENCODE_PRESENTATION;
  return table[value] ?? FALLBACK;
}

/** The chip's permission menu options: the provider's modes with their presentation. */
export function modelPermissionChipOptions(provider: string | null | undefined): ModelChipPermissionOption[] {
  return modelPermissionOptions(provider).map((option) => ({
    value: option.value,
    label: option.label,
    ...modelPermissionPresentation(provider, option.value),
  }));
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
