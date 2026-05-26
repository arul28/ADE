import type { AgentChatPermissionMode } from "../../../shared/types/chat";

export function mapPermissionToClaude(mode: AgentChatPermissionMode | undefined): "default" | "plan" | "acceptEdits" | "bypassPermissions" {
  if (mode === "full-auto") return "bypassPermissions";
  if (mode === "edit") return "acceptEdits";
  if (mode === "default") return "default";
  return "plan";
}

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
