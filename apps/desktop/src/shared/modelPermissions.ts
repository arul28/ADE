// Canonical per-provider permission vocabulary for the composer's model chip and
// the `@` model rows.
//
// A model chip carries a thinking level and a permission value. The permission
// value is the PROVIDER'S OWN word for the mode — Claude's `bypassPermissions`,
// Codex's `full-auto` preset, Droid's `auto-high` — not ADE's generic
// `AgentChatPermissionMode`. That is what lets the chip show "Bypass" for Claude
// and "Full auto" for OpenCode, matching the composer footer exactly.
//
// Pure: values + labels only, no rendering. The desktop footer, the chip, the
// TUI, and iOS all read one list, so a provider that adds a mode cannot drift.
//
// The send-time token may carry either a native value or one of the legacy
// generic values (`@model:…?perm=full-auto`) written before this module existed;
// `resolveModelPermissionValue` maps both onto the provider's native vocabulary,
// and `nativePermissionToCliMode` maps a native value back to the generic word
// the `ade chat create` / `ade chat handoff` flags accept.

import { CURSOR_AVAILABLE_MODE_IDS, formatCursorModeLabel } from "./cursorModes";
import {
  AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS,
  droidPermissionModeFromLegacyPermissionMode,
  legacyPermissionModeFromDroidPermissionMode,
  type AgentChatDroidPermissionMode,
} from "./types/chat";

export type ModelPermissionOption = { value: string; label: string };

const CLAUDE_OPTIONS: ModelPermissionOption[] = [
  { value: "default", label: "Manual" },
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass" },
];

const CODEX_OPTIONS: ModelPermissionOption[] = [
  { value: "default", label: "Default" },
  { value: "edit", label: "Edit" },
  { value: "plan", label: "Plan" },
  { value: "full-auto", label: "Full auto" },
  { value: "config-toml", label: "Config" },
];

const OPENCODE_OPTIONS: ModelPermissionOption[] = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Edit" },
  { value: "full-auto", label: "Full auto" },
  { value: "config-toml", label: "Config" },
];

const CURSOR_OPTIONS: ModelPermissionOption[] = CURSOR_AVAILABLE_MODE_IDS.map((id) => ({
  value: id,
  label: formatCursorModeLabel(id),
}));

const DROID_OPTIONS: ModelPermissionOption[] = AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label,
}));

function isDroidProvider(provider: string): boolean {
  return provider === "droid" || provider === "factory";
}

/** The native option list for a chat provider. Unknown providers speak OpenCode. */
export function modelPermissionOptions(provider: string | null | undefined): ModelPermissionOption[] {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "claude") return CLAUDE_OPTIONS;
  if (p === "codex") return CODEX_OPTIONS;
  if (p === "cursor") return CURSOR_OPTIONS;
  if (isDroidProvider(p)) return DROID_OPTIONS;
  return OPENCODE_OPTIONS;
}

/** The mode a fresh chip starts on, matching the footer's default for the provider. */
export function defaultModelPermission(provider: string | null | undefined): string {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "claude") return "default";
  if (p === "codex") return "default";
  if (p === "cursor") return "agent";
  if (isDroidProvider(p)) return "auto-low";
  return "edit";
}

/** True when `value` is one of the provider's own modes. */
export function isModelPermissionValue(provider: string | null | undefined, value: string | null | undefined): boolean {
  if (!value) return false;
  return modelPermissionOptions(provider).some((option) => option.value === value);
}

function labelFor(provider: string | null | undefined, value: string): string {
  return modelPermissionOptions(provider).find((option) => option.value === value)?.label ?? value;
}

/**
 * Map a legacy generic `AgentChatPermissionMode` onto a provider's native mode.
 * Mirrors `applyUnifiedPermissionToNativeControls` so an old chip lands on the
 * same option the footer would show for that mode.
 */
export function legacyPermissionToNative(provider: string | null | undefined, legacy: string): string | null {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "claude") {
    switch (legacy) {
      case "default": return "default";
      case "auto": return "auto";
      case "plan": return "plan";
      case "edit": return "acceptEdits";
      case "full-auto": return "bypassPermissions";
      default: return null;
    }
  }
  if (p === "codex") {
    return isModelPermissionValue("codex", legacy) ? legacy : legacy === "auto" ? "default" : null;
  }
  if (p === "cursor") {
    switch (legacy) {
      case "plan": return "plan";
      case "full-auto": return "full-auto";
      case "default":
      case "auto":
      case "edit":
      case "config-toml":
        return "agent";
      default: return null;
    }
  }
  if (isDroidProvider(p)) {
    const native: AgentChatDroidPermissionMode | undefined =
      droidPermissionModeFromLegacyPermissionMode(legacy as Parameters<typeof droidPermissionModeFromLegacyPermissionMode>[0]);
    return native ?? null;
  }
  // OpenCode / Pi / ACP tail: `default` and `auto` both mean the cautious
  // editing tier; `edit` is that tier's native name.
  switch (legacy) {
    case "plan": return "plan";
    case "edit": return "edit";
    case "full-auto": return "full-auto";
    case "config-toml": return "config-toml";
    case "default":
    case "auto":
      return "edit";
    default:
      return null;
  }
}

/**
 * The provider's native mode a stored chip value should render as, accepting a
 * native value or a legacy generic one. Null when the value means nothing for
 * this provider (a native value copied from a different provider's chip).
 */
export function resolveModelPermissionValue(
  provider: string | null | undefined,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (isModelPermissionValue(provider, value)) return value;
  return legacyPermissionToNative(provider, value);
}

/** The label the chip/menu shows for a stored value, once resolved. */
export function modelPermissionLabel(provider: string | null | undefined, value: string | null | undefined): string {
  const native = resolveModelPermissionValue(provider, value) ?? value ?? defaultModelPermission(provider);
  return labelFor(provider, native);
}

/**
 * The generic word `--permissions` / `--permission-mode` accepts for a native
 * mode. The inverse of `legacyPermissionToNative`, and the only place a native
 * value crosses back into the CLI vocabulary.
 */
export function nativePermissionToCliMode(provider: string | null | undefined, native: string | null | undefined): string | null {
  if (!native) return null;
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "claude") {
    switch (native) {
      case "default": return "default";
      case "auto": return "auto";
      case "plan": return "plan";
      case "acceptEdits": return "edit";
      case "bypassPermissions": return "full-auto";
      default: return null;
    }
  }
  if (p === "codex") {
    return isModelPermissionValue("codex", native) ? native : null;
  }
  if (p === "cursor") {
    switch (native) {
      case "plan": return "plan";
      case "full-auto": return "full-auto";
      case "agent":
      case "ask":
      case "debug":
      default:
        return isModelPermissionValue("cursor", native) ? "default" : null;
    }
  }
  if (isDroidProvider(p)) {
    if (native === "agi") return "full-auto";
    return legacyPermissionModeFromDroidPermissionMode(native as AgentChatDroidPermissionMode) ?? null;
  }
  return isModelPermissionValue(p, native) ? native : null;
}
