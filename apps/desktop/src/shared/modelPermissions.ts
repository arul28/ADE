// Canonical per-provider permission vocabulary for the composer's model chip and
// the `@` model rows.
//
// A model chip carries a thinking level and a permission value. The permission
// value is the PROVIDER'S OWN word for the mode — Claude's `bypassPermissions`,
// Codex's `full-auto` preset, Droid's `auto-high` — not ADE's generic
// `AgentChatPermissionMode`. That is what lets the chip show "Bypass" for Claude
// and "Full auto" for OpenCode, matching the composer footer exactly.
//
// Pure: values, labels and details only, no rendering. This is the one owner of
// a provider's native permission modes: the composer footer, the launch
// controls, the chip and the TUI all read these lists, so a provider that adds a
// mode cannot drift. Tone and glyph live in `renderer/lib/modelPermissionOptions.ts`.
//
// The send-time token may carry either a native value or one of the legacy
// generic values (`@model:…?perm=full-auto`) written before this module existed;
// `resolveModelPermissionValue` maps both onto the provider's native vocabulary,
// and `nativePermissionToCliMode` maps a native value back to the generic word
// the `ade chat create` / `ade chat handoff` flags accept.

import { CURSOR_AVAILABLE_MODE_IDS, formatCursorModeLabel } from "./cursorModes";
import {
  AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS,
  AGENT_CHAT_MUSE_PERMISSION_MODE_DETAILS,
  AGENT_CHAT_MUSE_PERMISSION_MODE_VALUES,
  DEFAULT_MUSE_PERMISSION_MODE,
  droidPermissionModeFromLegacyPermissionMode,
  legacyPermissionModeFromDroidPermissionMode,
  type AgentChatClaudePermissionMode,
  type AgentChatCopilotPermissionMode,
  type AgentChatDroidPermissionMode,
  type AgentChatMusePermissionMode,
  type AgentChatOpenCodePermissionMode,
  type AgentChatPermissionMode,
} from "./types/chat";

/**
 * One permission mode: the provider's own value, the name ADE shows for it, and
 * the sentence that explains it. Presentation (tone, glyph, the short word the
 * collapsed pill shows) lives in `renderer/lib/modelPermissionOptions.ts`.
 */
export type ModelPermissionOption<Value extends string = string> = { value: Value; label: string; detail: string };

export const CLAUDE_PERMISSION_MODES: ReadonlyArray<ModelPermissionOption<AgentChatClaudePermissionMode>> = [
  { value: "default", label: "Manual", detail: "Claude asks before edits, Bash, and other sensitive tools." },
  { value: "auto", label: "Auto", detail: "Claude judges each tool call. Uses a model classifier instead of asking you." },
  { value: "acceptEdits", label: "Accept edits", detail: "File edits are auto-approved; higher-risk actions still prompt." },
  { value: "plan", label: "Plan mode", detail: "Read-only Claude turns for analysis and implementation planning." },
  { value: "bypassPermissions", label: "Bypass", detail: "Skip every Claude permission prompt for this chat." },
];

/**
 * Codex's presets, each a fixed (approval policy, sandbox) pair. These names
 * are the ones every surface shows, the composer's pill included; ADE's generic
 * Codex options (`getPermissionOptions`) borrow them too. The detail line says
 * what each pair is.
 */
export const CODEX_PERMISSION_MODES: ReadonlyArray<ModelPermissionOption<CodexPermissionPreset>> = [
  { value: "default", label: "Default", detail: "Ask on request with workspace write sandbox." },
  { value: "edit", label: "Edit", detail: "Untrusted approval with workspace write sandbox." },
  { value: "plan", label: "Plan", detail: "Read-only sandbox for planning." },
  { value: "full-auto", label: "Full auto", detail: "No approval prompts with full sandbox access." },
  { value: "config-toml", label: "Config", detail: "No approval or sandbox flags are passed; Codex reads ~/.codex/config.toml." },
];

export type CodexPermissionPreset = "default" | "edit" | "plan" | "full-auto" | "config-toml";

export const OPENCODE_PERMISSION_MODES: ReadonlyArray<ModelPermissionOption<AgentChatOpenCodePermissionMode>> = [
  { value: "plan", label: "Plan", detail: "Read-only plan agent." },
  { value: "edit", label: "Edit", detail: "Allow edits; ask for the rest." },
  { value: "full-auto", label: "Full auto", detail: "Allow configured OpenCode tools." },
  { value: "config-toml", label: "Config", detail: "Use OpenCode config files." },
];

/**
 * What a Cursor mode does. Cursor's modes are ids the CLI reports once it
 * connects, so this reads the id rather than looking it up in a fixed list.
 */
export function cursorModeDetail(modeId: string): string {
  const normalized = modeId.trim().toLowerCase();
  if (normalized === "plan") return "Read-only planning mode.";
  if (normalized === "ask" || normalized === "edit") return "Read-only Q&A mode.";
  if (normalized === "full-auto" || normalized === "force" || normalized === "yolo") return "Highest access mode for Cursor Agent.";
  return "Cursor Agent's normal approval flow.";
}

/** Cursor's modes before the CLI connects and reports its own. */
export const CURSOR_PERMISSION_MODES: ReadonlyArray<ModelPermissionOption> = CURSOR_AVAILABLE_MODE_IDS.map((id) => ({
  value: id,
  label: formatCursorModeLabel(id),
  detail: cursorModeDetail(id),
}));

export const DROID_PERMISSION_MODES: ReadonlyArray<ModelPermissionOption<AgentChatDroidPermissionMode>> =
  AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS;

export const MUSE_PERMISSION_MODES: ReadonlyArray<ModelPermissionOption<AgentChatMusePermissionMode>> =
  AGENT_CHAT_MUSE_PERMISSION_MODE_VALUES.map((value) => ({ value, ...AGENT_CHAT_MUSE_PERMISSION_MODE_DETAILS[value] }));

/**
 * ADE's plan mode on Muse. Not a Muse approval mode: it runs on `denyUnmatched`
 * plus ADE's plan guidance, so only the chat composer offers it.
 */
export const MUSE_PLAN_MODE: ModelPermissionOption<"plan"> = {
  value: "plan",
  label: "Plan",
  detail: "Read-only Muse turns for planning, with ADE's plan guidance.",
};

/** GitHub Copilot's own modes, the values `--copilot-permission-mode` accepts. */
export const COPILOT_PERMISSION_MODES: ReadonlyArray<ModelPermissionOption<AgentChatCopilotPermissionMode>> = [
  { value: "plan", label: "Plan", detail: "Read-only planning mode." },
  { value: "ask", label: "Ask", detail: "Ask before each action." },
  { value: "assisted", label: "Assisted", detail: "Copilot reviews each tool call with a safety model and approves the safe ones; asks you for the rest." },
  { value: "auto-edit", label: "Auto-edit", detail: "Automatically approve file changes in the workspace." },
  { value: "full-auto", label: "Full-auto", detail: "Allow all actions for this session." },
];

/**
 * ADE's generic launch word as a Muse approval mode. Same convention as Droid:
 * `default` is the provider's own default (`onRequest`), `edit` the cautious
 * editing tier. `config-toml` has no Muse meaning.
 */
export function musePermissionModeFromLegacyPermissionMode(
  mode: AgentChatPermissionMode | string | null | undefined,
): AgentChatMusePermissionMode | undefined {
  switch (mode) {
    case "plan": return "denyUnmatched";
    case "edit": return "promptUnmatched";
    case "default":
    case "auto":
      return "onRequest";
    case "full-auto": return "allowAll";
    default: return undefined;
  }
}

/** A Muse approval mode as ADE's generic word, for the `--permissions` flags. */
export function legacyPermissionModeFromMusePermissionMode(
  mode: AgentChatMusePermissionMode | string | null | undefined,
): AgentChatPermissionMode | undefined {
  switch (mode) {
    case "denyUnmatched": return "plan";
    case "promptUnmatched": return "edit";
    case "onRequest": return "default";
    case "allowAll": return "full-auto";
    default: return undefined;
  }
}

function isDroidProvider(provider: string): boolean {
  return provider === "droid" || provider === "factory";
}

/** The native option list for a chat provider. Unknown providers speak OpenCode. */
export function modelPermissionOptions(provider: string | null | undefined): ReadonlyArray<ModelPermissionOption> {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "claude") return CLAUDE_PERMISSION_MODES;
  if (p === "codex") return CODEX_PERMISSION_MODES;
  if (p === "cursor") return CURSOR_PERMISSION_MODES;
  if (isDroidProvider(p)) return DROID_PERMISSION_MODES;
  if (p === "muse") return MUSE_PERMISSION_MODES;
  if (p === "copilot") return COPILOT_PERMISSION_MODES;
  return OPENCODE_PERMISSION_MODES;
}

/** The mode a fresh chip starts on, matching the footer's default for the provider. */
export function defaultModelPermission(provider: string | null | undefined): string {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "claude") return "default";
  if (p === "codex") return "default";
  if (p === "cursor") return "agent";
  if (isDroidProvider(p)) return "auto-low";
  if (p === "muse") return DEFAULT_MUSE_PERMISSION_MODE;
  if (p === "copilot") return "ask";
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
  if (p === "muse") return musePermissionModeFromLegacyPermissionMode(legacy) ?? null;
  if (p === "copilot") {
    // The launch path's own mapping (`agentChatService`): anything that is not
    // plan, edit or full-auto starts in Ask.
    switch (legacy) {
      case "plan": return "plan";
      case "edit": return "auto-edit";
      case "full-auto": return "full-auto";
      case "default":
      case "auto":
      case "config-toml":
        return "ask";
      default: return null;
    }
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
  if (p === "muse") return legacyPermissionModeFromMusePermissionMode(native) ?? null;
  if (p === "copilot") {
    // Lossy for Assisted, which has no generic word: it reads back as `edit`,
    // which launches Auto-edit. `ade chat create` takes the exact mode through
    // `--copilot-permission-mode`; see `modelMentions.ts`.
    switch (native) {
      case "plan": return "plan";
      case "ask": return "default";
      case "assisted":
      case "auto-edit":
        return "edit";
      case "full-auto": return "full-auto";
      default: return null;
    }
  }
  return isModelPermissionValue(p, native) ? native : null;
}
