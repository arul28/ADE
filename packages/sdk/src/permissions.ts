import type {
  AdeProvider,
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
} from "./types.js";

/**
 * Create-args this module may emit, typed against the wire unions rather than
 * `Record<string, unknown>`. That is the whole point: a typo like
 * "bypassPermission" or a provider renaming a mode becomes a compile error here
 * instead of a permission silently not applying at runtime — and it keeps the
 * six unions load-bearing rather than decorative.
 */
export type PermissionArgs = {
  permissionMode: AgentChatPermissionMode;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
};

export type PermissionPreset = "always-allow" | "default";

/**
 * Provider-specific create-args for a permission preset.
 *
 * "always-allow" is a single knob at the SDK boundary, but ADE has no single
 * always-allow switch: each adapter names its own full-auto state, and setting
 * only the generic `permissionMode` leaves Claude prompting and Codex sandboxed.
 * The mapping is spelled out per provider rather than inferred, so a new
 * provider is a compile error here instead of a silent half-permissive session.
 *
 * Source of truth for the unions: `apps/desktop/src/shared/types/chat.ts`.
 */
export function permissionArgs(
  provider: AdeProvider,
  preset: PermissionPreset,
): PermissionArgs {
  if (preset === "default") return { permissionMode: "default" };

  switch (provider) {
    case "claude":
      return {
        permissionMode: "full-auto",
        claudePermissionMode: "bypassPermissions",
      };
    case "codex":
      return {
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
      };
    case "opencode":
      return {
        permissionMode: "full-auto",
        opencodePermissionMode: "full-auto",
      };
    case "droid":
      return {
        permissionMode: "full-auto",
        droidPermissionMode: "auto-high",
      };
    case "cursor":
      // Cursor's approval behavior is carried by its mode snapshot, not by a
      // dedicated permission union; the generic full-auto mode is the whole
      // contract the chat service reads for it.
      return { permissionMode: "full-auto" };
    case "pi":
      return { permissionMode: "full-auto" };
  }
}

export const SUPPORTED_PROVIDERS: readonly AdeProvider[] = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "pi",
];

export function isSupportedProvider(value: string): value is AdeProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}
