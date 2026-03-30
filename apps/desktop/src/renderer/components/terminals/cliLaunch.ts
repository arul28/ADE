import type { AgentChatPermissionMode } from "../../../shared/types";

export type CliProvider = "claude" | "codex";

export function withCodexNoAltScreen(command: string): string {
  const trimmed = command.trim();
  if (!/^codex(?:\s|$)/.test(trimmed)) return trimmed;
  if (/(?:^|\s)--no-alt-screen(?:\s|$)/.test(trimmed)) return trimmed;
  return trimmed === "codex"
    ? "codex --no-alt-screen"
    : trimmed.replace(/^codex\b/, "codex --no-alt-screen");
}

export function defaultTrackedCliStartupCommand(provider: CliProvider): string {
  return provider === "codex" ? withCodexNoAltScreen("codex") : "claude";
}

export function buildTrackedCliStartupCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
}): string {
  if (args.provider === "claude") {
    const parts = ["claude"];
    if (args.permissionMode === "full-auto") {
      parts.push("--dangerously-skip-permissions");
    } else if (args.permissionMode === "edit") {
      parts.push("--permission-mode", "acceptEdits");
    } else if (args.permissionMode === "default") {
      parts.push("--permission-mode", "default");
    } else {
      parts.push("--permission-mode", "plan");
    }
    return parts.join(" ");
  }

  const parts = [withCodexNoAltScreen("codex")];
  if (args.permissionMode === "full-auto") {
    parts.push("--full-auto");
  } else if (args.permissionMode !== "config-toml") {
    const approvalPolicy = args.permissionMode === "edit" ? "on-failure" : "untrusted";
    const sandboxMode = args.permissionMode === "edit" ? "workspace-write" : "read-only";
    parts.push("-c", `approval_policy=${approvalPolicy}`, "-c", `sandbox_mode=${sandboxMode}`);
  }
  return parts.join(" ");
}
