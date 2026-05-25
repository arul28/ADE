import type { AgentChatPermissionMode } from "../../../shared/types/chat";

/**
 * Map an AgentChatPermissionMode to the Claude CLI `--permission-mode` value
 * (or `--dangerously-skip-permissions`).
 */
export function mapPermissionToClaude(
  mode: AgentChatPermissionMode | undefined,
): "default" | "plan" | "acceptEdits" | "bypassPermissions" {
  if (mode === "full-auto") return "bypassPermissions";
  if (mode === "edit") return "acceptEdits";
  if (mode === "default") return "default";
  return "plan";
}

/**
 * Map an AgentChatPermissionMode to Codex CLI approval-policy + sandbox.
 * Returns null for "config-toml" so Codex reads its own config.
 */
export function mapPermissionToCodex(mode: AgentChatPermissionMode | undefined): {
  approvalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
} | null {
  if (mode === "full-auto") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  if (mode === "edit") {
    return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
  }
  if (mode === "config-toml") {
    return null;
  }
  if (mode === "default") {
    return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
  return { approvalPolicy: "on-request", sandbox: "read-only" };
}

/**
 * Map an AgentChatPermissionMode to the native in-process permission mode.
 */
export function mapPermissionToInProcess(
  mode: AgentChatPermissionMode | undefined,
): "read-only" | "edit" | "full-auto" {
  if (mode === "full-auto") return "full-auto";
  if (mode === "edit") return "edit";
  return "read-only";
}
