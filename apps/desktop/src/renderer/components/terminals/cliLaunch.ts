import type {
  AgentChatPermissionMode,
  TerminalResumeMetadata,
  TerminalSessionSummary,
} from "../../../shared/types";

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
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
}): string {
  if (args.provider === "claude") {
    const parts = ["claude"];
    // Inject --session-id so we know the Claude session ID upfront for resume
    if (args.sessionId) {
      parts.push("--session-id", args.sessionId);
    }
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
    parts.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (args.permissionMode === "default") {
    parts.push("--full-auto");
  } else if (args.permissionMode !== "config-toml") {
    const approvalPolicy = args.permissionMode === "edit" ? "untrusted" : "on-request";
    const sandboxMode = args.permissionMode === "edit" ? "workspace-write" : "read-only";
    parts.push("--sandbox", sandboxMode, "--ask-for-approval", approvalPolicy);
  }
  return parts.join(" ");
}

function permissionModeToClaudeFlag(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--dangerously-skip-permissions"];
  if (permissionMode === "edit") return ["--permission-mode", "acceptEdits"];
  if (permissionMode === "default") return ["--permission-mode", "default"];
  return ["--permission-mode", "plan"];
}

function permissionModeToCodexFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (permissionMode === "default") return ["--full-auto"];
  if (permissionMode === "edit") return ["--sandbox", "workspace-write", "--ask-for-approval", "untrusted"];
  if (permissionMode === "plan") return ["--sandbox", "read-only", "--ask-for-approval", "on-request"];
  return [];
}

export function buildTrackedCliResumeCommand(metadata: TerminalResumeMetadata): string {
  const targetId = metadata.targetId?.trim() ?? "";
  if (metadata.provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(metadata.launch.permissionMode)];
    parts.push("--resume");
    if (targetId) parts.push(targetId);
    return parts.join(" ");
  }

  const parts = ["codex", "--no-alt-screen", ...permissionModeToCodexFlags(metadata.launch.permissionMode)];
  parts.push("resume");
  if (targetId) parts.push(targetId);
  return parts.join(" ");
}

export function resolveTrackedCliResumeCommand(session: Pick<TerminalSessionSummary, "resumeCommand" | "resumeMetadata">): string | null {
  if (session.resumeMetadata) {
    return buildTrackedCliResumeCommand(session.resumeMetadata);
  }
  const command = session.resumeCommand?.trim() ?? "";
  return command.length > 0 ? command : null;
}
