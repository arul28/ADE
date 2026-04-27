import type {
  AgentChatPermissionMode,
  TerminalResumeMetadata,
  TerminalSessionSummary,
} from "../../../shared/types";
import { ADE_CLI_AGENT_GUIDANCE, ADE_CLI_INLINE_GUIDANCE } from "../../../shared/adeCliGuidance";
import { commandArrayToLine } from "../../lib/shell";

export type CliProvider = "claude" | "codex";
export type TrackedCliLaunchCommand = {
  command: CliProvider;
  args: string[];
  startupCommand: string;
};

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

function workTabCodexPreamblePrompt(): string {
  return [
    "ADE session guidance. Treat this as operating guidance for the CLI session, keep it in mind for future user messages, and wait for the user's next instruction before taking action.",
    "",
    ADE_CLI_INLINE_GUIDANCE,
  ].join("\n");
}

export function buildTrackedCliStartupCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
}): string {
  return buildTrackedCliLaunchCommand(args).startupCommand;
}

export function buildTrackedCliLaunchCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
}): TrackedCliLaunchCommand {
  if (args.provider === "claude") {
    const commandArgs: string[] = [];
    // Inject --session-id so we know the Claude session ID upfront for resume
    if (args.sessionId) {
      commandArgs.push("--session-id", args.sessionId);
    }
    commandArgs.push("--append-system-prompt", ADE_CLI_AGENT_GUIDANCE);
    commandArgs.push(...permissionModeToClaudeFlag(args.permissionMode));
    return {
      command: "claude",
      args: commandArgs,
      startupCommand: commandArrayToLine(["claude", ...commandArgs]),
    };
  }

  const commandArgs: string[] = [
    "--no-alt-screen",
    ...permissionModeToCodexFlags(args.permissionMode),
    workTabCodexPreamblePrompt(),
  ];
  return {
    command: "codex",
    args: commandArgs,
    startupCommand: commandArrayToLine(["codex", ...commandArgs]),
  };
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
