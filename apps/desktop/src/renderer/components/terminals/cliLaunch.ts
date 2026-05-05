import type {
  AgentChatPermissionMode,
  TerminalResumeMetadata,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import { ADE_CLI_AGENT_GUIDANCE, ADE_CLI_INLINE_GUIDANCE } from "../../../shared/adeCliGuidance";
import { commandArrayToLine, quoteShellArg } from "../../lib/shell";

export type CliProvider = "claude" | "codex" | "cursor" | "droid" | "opencode";
export type LaunchProfile = CliProvider | "shell";
export type TrackedCliLaunchCommand = {
  command?: string;
  args: string[];
  startupCommand: string;
  env?: Record<string, string>;
};

/** Maps a `launchPtySession` profile to the `TerminalToolType` recorded on the session. */
export const LAUNCH_PROFILE_TOOL_TYPE: Record<LaunchProfile, TerminalToolType> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-cli",
  droid: "droid",
  opencode: "opencode",
  shell: "shell",
};

/** Default human-readable tab title for a launch profile. */
export const LAUNCH_PROFILE_TITLE: Record<LaunchProfile, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent CLI",
  droid: "Factory Droid CLI",
  opencode: "OpenCode CLI",
  shell: "Shell",
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
  if (provider === "codex") return withCodexNoAltScreen("codex");
  if (provider === "cursor") return "cursor-agent";
  if (provider === "droid") return "droid";
  if (provider === "opencode") return "opencode";
  return "claude";
}

function workTabCliPreamblePrompt(): string {
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
    // Inject --session-id so we know the Claude session ID upfront for resume.
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

  if (args.provider === "codex") {
    const commandArgs: string[] = [
      "--no-alt-screen",
      ...permissionModeToCodexFlags(args.permissionMode),
      workTabCliPreamblePrompt(),
    ];
    return {
      command: "codex",
      args: commandArgs,
      startupCommand: commandArrayToLine(["codex", ...commandArgs]),
    };
  }

  if (args.provider === "cursor") {
    const prompt = workTabCliPreamblePrompt();
    const commandArgs = [...permissionModeToCursorFlags(args.permissionMode), prompt];
    const startupCommand = buildCursorPrecreatedChatCommand({
      permissionMode: args.permissionMode,
      prompt,
    });
    return {
      args: commandArgs,
      startupCommand,
    };
  }

  if (args.provider === "droid") {
    const prompt = workTabCliPreamblePrompt();
    return {
      args: [...permissionModeToDroidExecFlags(args.permissionMode), prompt],
      startupCommand: buildDroidCommandLine({ permissionMode: args.permissionMode, prompt }),
    };
  }

  const opencode = buildOpenCodeCommandParts({
    permissionMode: args.permissionMode,
    prompt: workTabCliPreamblePrompt(),
  });
  return {
    command: "opencode",
    args: opencode.args,
    startupCommand: opencode.startupCommand,
    ...(opencode.env ? { env: opencode.env } : {}),
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

function permissionModeToCursorFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--force"];
  if (permissionMode === "plan") return ["--mode", "plan"];
  if (permissionMode === "edit") return ["--mode", "ask"];
  return [];
}

function permissionModeToDroidExecFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--auto", "high"];
  if (permissionMode === "default") return ["--auto", "medium"];
  if (permissionMode === "edit") return ["--auto", "low"];
  return [];
}

function droidSettingsJson(permissionMode: AgentChatPermissionMode | null | undefined): string {
  const sessionDefaultSettings = (() => {
    if (permissionMode === "full-auto") return { interactionMode: "auto", autonomyLevel: "high" };
    if (permissionMode === "default") return { interactionMode: "auto", autonomyLevel: "medium" };
    if (permissionMode === "edit") return { interactionMode: "auto", autonomyLevel: "low" };
    return { interactionMode: "spec", autonomyLevel: "off" };
  })();
  return JSON.stringify({ sessionDefaultSettings });
}

function buildDroidCommandLine(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  prompt?: string;
  resumeTarget?: string | null;
}): string {
  const settingsJson = droidSettingsJson(args.permissionMode);
  const droidArgs = ["droid", "--settings", "$ADE_DROID_SETTINGS"];
  if (args.resumeTarget !== undefined) {
    droidArgs.push("--resume");
    if (args.resumeTarget) droidArgs.push(args.resumeTarget);
  }
  if (args.prompt) droidArgs.push(args.prompt);
  const droidCommand = commandArrayToLine(droidArgs)
    .replace(quoteShellArg("$ADE_DROID_SETTINGS"), "\"$ADE_DROID_SETTINGS\"");
  return [
    "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\"",
    `printf %s ${quoteShellArg(settingsJson)} > "$ADE_DROID_SETTINGS"`,
    `${droidCommand}; ADE_DROID_STATUS=$?; rm -f "$ADE_DROID_SETTINGS"; exit $ADE_DROID_STATUS`,
  ].join(" && ");
}

function buildCursorPrecreatedChatCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  prompt: string;
}): string {
  const commandArgs = [
    "cursor-agent",
    ...permissionModeToCursorFlags(args.permissionMode),
    "--resume",
    "$ADE_CURSOR_CHAT_ID",
    args.prompt,
  ];
  const command = commandArrayToLine(commandArgs)
    .replace(quoteShellArg("$ADE_CURSOR_CHAT_ID"), "\"$ADE_CURSOR_CHAT_ID\"");
  return [
    "ADE_CURSOR_CHAT_ID=\"$(cursor-agent create-chat)\"",
    "[ -n \"$ADE_CURSOR_CHAT_ID\" ] || { echo \"[ADE] cursor-agent create-chat returned no chat id\" >&2; exit 1; }",
    "printf %s\\\\n \"[ADE] Resume with cursor-agent --resume ${ADE_CURSOR_CHAT_ID}\"",
    command,
  ].join(" && ");
}

const OPENCODE_INLINE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

function openCodePermissionValue(permissionMode: AgentChatPermissionMode | null | undefined): string | Record<string, string> | null {
  if (permissionMode === "config-toml") return null;
  if (permissionMode === "full-auto") return "allow";
  if (permissionMode === "edit") return { "*": "ask", edit: "allow" };
  if (permissionMode === "plan") return { "*": "ask", edit: "deny", bash: "deny" };
  return { "*": "ask" };
}

function openCodeConfigEnv(permissionMode: AgentChatPermissionMode | null | undefined): string | null {
  const permission = openCodePermissionValue(permissionMode);
  return permission ? JSON.stringify({ permission }) : null;
}

function openCodeEnvAssignment(permissionMode: AgentChatPermissionMode | null | undefined): string {
  const config = openCodeConfigEnv(permissionMode);
  return config ? `${OPENCODE_INLINE_CONFIG_ENV}=${quoteShellArg(config)} ` : "";
}

function permissionModeToOpenCodeArgs(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  return permissionMode === "plan" ? ["--agent", "plan"] : [];
}

function buildOpenCodeCommandParts(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  prompt?: string;
  resumeTarget?: string | null;
  continueLast?: boolean;
}): { args: string[]; startupCommand: string; env?: Record<string, string> } {
  const commandArgs = [...permissionModeToOpenCodeArgs(args.permissionMode)];
  if (args.resumeTarget) {
    commandArgs.push("--session", args.resumeTarget);
  } else if (args.continueLast) {
    commandArgs.push("--continue");
  }
  if (args.prompt) commandArgs.push("--prompt", args.prompt);
  const config = openCodeConfigEnv(args.permissionMode);
  return {
    args: commandArgs,
    startupCommand: `${openCodeEnvAssignment(args.permissionMode)}${commandArrayToLine(["opencode", ...commandArgs])}`,
    ...(config ? { env: { [OPENCODE_INLINE_CONFIG_ENV]: config } } : {}),
  };
}

export function buildTrackedCliResumeCommand(metadata: TerminalResumeMetadata): string {
  const targetId = metadata.targetId?.trim() ?? "";
  if (metadata.provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(metadata.launch.permissionMode)];
    parts.push("--resume");
    if (targetId) parts.push(targetId);
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "codex") {
    const parts = ["codex", "--no-alt-screen", ...permissionModeToCodexFlags(metadata.launch.permissionMode)];
    parts.push("resume");
    if (targetId) parts.push(targetId);
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "cursor") {
    const parts = ["cursor-agent", ...permissionModeToCursorFlags(metadata.launch.permissionMode)];
    if (targetId) {
      parts.push("--resume", targetId);
    } else {
      parts.push("--continue");
    }
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "droid") {
    return buildDroidCommandLine({
      permissionMode: metadata.launch.permissionMode,
      resumeTarget: targetId || null,
    });
  }

  const opencode = buildOpenCodeCommandParts({
    permissionMode: metadata.launch.permissionMode,
    resumeTarget: targetId || null,
    continueLast: !targetId,
  });
  return opencode.startupCommand;
}

export function resolveTrackedCliResumeCommand(session: Pick<TerminalSessionSummary, "resumeCommand" | "resumeMetadata">): string | null {
  if (session.resumeMetadata) {
    return buildTrackedCliResumeCommand(session.resumeMetadata);
  }
  const command = session.resumeCommand?.trim() ?? "";
  return command.length > 0 ? command : null;
}

/**
 * Resolve `pty.create` launch fields, treating caller-supplied overrides as
 * atomic so we never mix the caller's `startupCommand` with default
 * `command`/`args` (or vice versa). If the caller passed *any* override field,
 * we use exactly what they supplied — defaults are skipped entirely. Only
 * when the caller passed nothing do we fall back to the profile's default
 * launch command.
 */
export function resolveLaunchFields<P extends LaunchProfile>(args: {
  profile: P;
  permissionMode?: AgentChatPermissionMode;
  startupCommand?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}): { startupCommand?: string; command?: string; args?: string[]; env?: Record<string, string> } {
  const callerHasOverride =
    args.startupCommand !== undefined
    || args.command !== undefined
    || args.args !== undefined
    || args.env !== undefined;

  if (callerHasOverride) {
    return {
      ...(args.startupCommand !== undefined ? { startupCommand: args.startupCommand } : {}),
      ...(args.command !== undefined ? { command: args.command } : {}),
      ...(args.args !== undefined ? { args: args.args } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
    };
  }

  if (args.profile === "shell") return {};

  const defaultLaunch = buildTrackedCliLaunchCommand({
    provider: args.profile,
    permissionMode: args.permissionMode ?? "default",
  });
  return {
    startupCommand: defaultLaunch.startupCommand,
    ...(defaultLaunch.command !== undefined ? { command: defaultLaunch.command } : {}),
    args: defaultLaunch.args,
    ...(defaultLaunch.env ? { env: defaultLaunch.env } : {}),
  };
}
