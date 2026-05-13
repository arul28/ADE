import type {
  AgentChatClaudePermissionMode,
  AgentChatPermissionMode,
  TerminalResumeLaunchConfig,
  TerminalResumeMetadata,
  TerminalResumeProvider,
  TerminalRuntimeState,
  TerminalToolType,
} from "../../shared/types";

const OSC_133_REGEX = /\u001b\]133;([ABCD])(?:;[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
const RESUME_BACKTICK_REGEX = /`([^`\r\n]*(?:claude|codex|cursor-agent|droid|opencode)\s+[^`\r\n]*(?:--resume|-r|resume|--continue|-c|--session|-s)[^`\r\n]*)`/gi;
const RESUME_COMMAND_REGEX = /\b((?:claude|codex|cursor-agent|droid|opencode)\s+[^\r\n`]*?(?:--resume(?:=|\s+)?[^\s`\r\n]*|-r\s+[^\s`\r\n]+|resume(?:\s+[^\s`\r\n]+)?|--continue|-c(?:\s|$)|--session(?:=|\s+)[^\s`\r\n]+|-s\s+[^\s`\r\n]+)[^\r\n`]*?)(?=\s+(?:claude|codex|cursor-agent|droid|opencode)\s|$)/gi;

function shellQuote(value: string): string {
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_.:@%+=,/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandArrayToLine(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

export function sanitizeResumeTargetId(value: string | null | undefined): string | null {
  const target = String(value ?? "").trim();
  if (!target) return null;
  if (/[\x00-\x1F\x7F]/.test(target)) return null;
  if (target.startsWith("-")) return null;
  return target;
}

function normalizeCommand(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[)\].,;:!?]+$/g, "")
    .trim();
}

function stripLeadingEnvAssignments(command: string): string {
  let next = command.trim();
  for (;;) {
    const before = next;
    next = next.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/, "").trim();
    if (next === before) return next;
  }
}

function toolFromCommand(raw: string): TerminalToolType | null {
  const normalized = stripLeadingEnvAssignments(raw).trim().toLowerCase();
  if (normalized.startsWith("claude ")) return "claude";
  if (normalized.startsWith("codex ")) return "codex";
  if (normalized.startsWith("cursor-agent ")) return "cursor-cli";
  if (normalized.startsWith("droid ")) return "droid";
  if (normalized.startsWith("opencode ")) return "opencode";
  return null;
}

export function providerFromTool(toolType: TerminalToolType | null | undefined): TerminalResumeProvider | null {
  if (toolType === "claude" || toolType === "claude-orchestrated" || toolType === "claude-chat") return "claude";
  if (toolType === "codex" || toolType === "codex-orchestrated" || toolType === "codex-chat") return "codex";
  if (toolType === "cursor-cli") return "cursor";
  if (toolType === "droid") return "droid";
  if (toolType === "opencode") return "opencode";
  return null;
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

function droidSettingsJson(permissionMode: AgentChatPermissionMode | null | undefined): string {
  if (permissionMode === "full-auto") {
    return JSON.stringify({ sessionDefaultSettings: { interactionMode: "auto", autonomyLevel: "high" } });
  }
  if (permissionMode === "default") {
    return JSON.stringify({ sessionDefaultSettings: { interactionMode: "auto", autonomyLevel: "medium" } });
  }
  if (permissionMode === "edit") {
    return JSON.stringify({ sessionDefaultSettings: { interactionMode: "auto", autonomyLevel: "low" } });
  }
  return JSON.stringify({ sessionDefaultSettings: { interactionMode: "spec", autonomyLevel: "off" } });
}

function buildDroidCommandLine(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  resumeTarget?: string | null;
}): string {
  const droidArgs = ["droid", "--settings", "$ADE_DROID_SETTINGS", "--resume"];
  if (args.resumeTarget) droidArgs.push(args.resumeTarget);
  const droidCommand = commandArrayToLine(droidArgs).replace(shellQuote("$ADE_DROID_SETTINGS"), "\"$ADE_DROID_SETTINGS\"");
  return [
    "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\"",
    `printf %s ${shellQuote(droidSettingsJson(args.permissionMode))} > "$ADE_DROID_SETTINGS"`,
    `${droidCommand}; ADE_DROID_STATUS=$?; rm -f "$ADE_DROID_SETTINGS"; exit $ADE_DROID_STATUS`,
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

function permissionModeToOpenCodeArgs(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  return permissionMode === "plan" ? ["--agent", "plan"] : [];
}

function buildOpenCodeResumeCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  targetId: string | null;
}): string {
  const commandArgs = ["opencode", ...permissionModeToOpenCodeArgs(args.permissionMode)];
  if (args.targetId) {
    commandArgs.push("--session", args.targetId);
  } else {
    commandArgs.push("--continue");
  }
  const config = openCodeConfigEnv(args.permissionMode);
  const assignment = config ? `${OPENCODE_INLINE_CONFIG_ENV}=${shellQuote(config)} ` : "";
  return `${assignment}${commandArrayToLine(commandArgs)}`;
}

function extractTrackedCliPermissionMode(command: string, provider: TerminalResumeProvider): AgentChatPermissionMode | undefined {
  const normalized = command.trim().toLowerCase();
  if (provider === "claude") {
    if (normalized.includes("--dangerously-skip-permissions")) return "full-auto";
    if (normalized.includes("--permission-mode acceptedits")) return "edit";
    if (normalized.includes("--permission-mode default")) return "default";
    if (normalized.includes("--permission-mode plan")) return "plan";
    return undefined;
  }

  if (provider === "codex") {
    if (normalized.includes("--dangerously-bypass-approvals-and-sandbox") || normalized.includes("--yolo")) return "full-auto";
    if (normalized.includes("--full-auto")) return "default";
    if (
      (normalized.includes("--ask-for-approval untrusted") || normalized.includes("-a untrusted") || normalized.includes("approval_policy=untrusted"))
      && (normalized.includes("--sandbox workspace-write") || normalized.includes("-s workspace-write") || normalized.includes("sandbox_mode=workspace-write"))
    ) return "edit";
    if (
      (normalized.includes("--ask-for-approval on-request") || normalized.includes("-a on-request") || normalized.includes("approval_policy=on-request"))
      && (normalized.includes("--sandbox read-only") || normalized.includes("-s read-only") || normalized.includes("sandbox_mode=read-only"))
    ) return "plan";
    if (
      (normalized.includes("--ask-for-approval on-request") || normalized.includes("-a on-request") || normalized.includes("approval_policy=on-request"))
      && (normalized.includes("--sandbox workspace-write") || normalized.includes("-s workspace-write") || normalized.includes("sandbox_mode=workspace-write"))
    ) return "default";
    if (normalized.includes("approval_policy=on-failure") || normalized.includes("sandbox_mode=workspace-write")) return "edit";
    if (normalized.includes("approval_policy=untrusted") || normalized.includes("sandbox_mode=read-only")) return "plan";
    if (normalized.includes("approval_policy=") || normalized.includes("sandbox_mode=") || normalized.includes("--ask-for-approval") || normalized.includes("--sandbox")) return "plan";
    return "config-toml";
  }

  if (provider === "cursor") {
    if (normalized.includes("--force") || normalized.includes("--yolo")) return "full-auto";
    if (normalized.includes("--mode plan") || normalized.includes("--plan")) return "plan";
    if (normalized.includes("--mode ask")) return "edit";
    return "default";
  }

  if (provider === "droid") {
    if (normalized.includes("autonomylevel\":\"high") || normalized.includes("--auto high")) return "full-auto";
    if (normalized.includes("autonomylevel\":\"medium") || normalized.includes("--auto medium")) return "default";
    if (normalized.includes("autonomylevel\":\"low") || normalized.includes("--auto low")) return "edit";
    if (normalized.includes("--skip-permissions-unsafe")) return "full-auto";
    return "plan";
  }

  if (provider === "opencode") {
    if (
      normalized.includes("opencode_config_content=")
      && (
        normalized.includes("\"permission\":\"allow\"")
        || normalized.includes("\\\"permission\\\":\\\"allow\\\"")
      )
    ) return "full-auto";
    if (normalized.includes("opencode_permission='\"allow\"'") || normalized.includes("opencode_permission=\"\\\"allow\\\"\"")) return "full-auto";
    if (normalized.includes("--agent plan")) return "plan";
    if (normalized.includes("\"edit\":\"allow\"") || normalized.includes("\\\"edit\\\":\\\"allow\\\"")) return "edit";
    if (normalized.includes("opencode_config_content=") || normalized.includes("opencode_permission=")) return "default";
    return "config-toml";
  }

  return undefined;
}

export function parseTrackedCliLaunchConfig(
  startupCommand: string,
  toolType: TerminalToolType | null | undefined,
): TerminalResumeLaunchConfig | null {
  const provider = providerFromTool(toolType);
  if (!provider) return null;
  const normalized = startupCommand.trim();
  if (!normalized.length) return null;

  const permissionMode = extractTrackedCliPermissionMode(normalized, provider);

  if (provider === "claude") {
    const effectivePermissionMode = permissionMode ?? "default";
    let claudePermissionMode: AgentChatClaudePermissionMode;
    if (effectivePermissionMode === "full-auto") {
      claudePermissionMode = "bypassPermissions";
    } else if (effectivePermissionMode === "edit") {
      claudePermissionMode = "acceptEdits";
    } else {
      claudePermissionMode = "default";
    }
    return {
      permissionMode: effectivePermissionMode,
      claudePermissionMode,
    };
  }

  if (provider === "codex") {
    if (permissionMode === "full-auto") {
      return {
        permissionMode,
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      };
    }

    if (permissionMode === "edit") {
      return {
        permissionMode,
        codexApprovalPolicy: "untrusted",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      };
    }

    if (permissionMode === "default") {
      return {
        permissionMode,
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      };
    }

    if (permissionMode === "plan") {
      return {
        permissionMode,
        codexApprovalPolicy: "on-request",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      };
    }

    return {
      permissionMode: "config-toml",
      codexConfigSource: "config-toml",
    };
  }

  return {
    ...(permissionMode ? { permissionMode } : {}),
  };
}

function extractWrappedProviderCommand(command: string, binary: string): string {
  const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(String.raw`(?:^|&&\s+|;\s+)(${escaped}\b[^;&|]*)`, "i"));
  return match?.[1] ?? command;
}

function parseProviderResumeTarget(provider: TerminalResumeProvider, command: string): string | null | undefined {
  if (provider === "claude") {
    const match = command.match(/^claude(?:(?:\s+--[^\s]+)(?:\s+[^\s]+)?)*\s+(?:--resume|-r|resume)(?:\s+([^\s]+))?(?:\s|$)/i);
    if (!match) return undefined;
    if (match[1] == null) return null;
    return sanitizeResumeTargetId(match[1]) ?? undefined;
  }

  if (provider === "codex") {
    const match = command.match(/^codex(?:(?:\s+--no-alt-screen)|(?:\s+--full-auto)|(?:\s+--dangerously-bypass-approvals-and-sandbox)|(?:\s+--yolo)|(?:\s+--sandbox\s+[^\s]+)|(?:\s+-s\s+[^\s]+)|(?:\s+--ask-for-approval\s+[^\s]+)|(?:\s+-a\s+[^\s]+)|(?:\s+-c\s+[^\s]+))*\s+resume(?:\s+([^\s]+))?(?:\s|$)/i);
    if (!match) return undefined;
    if (match[1] == null) return null;
    return sanitizeResumeTargetId(match[1]) ?? undefined;
  }

  if (provider === "cursor") {
    const match = command.match(/^cursor-agent\b.*?(?:--resume(?:=|\s+)([^\s]+)|--continue\b|\bresume\b)(?:\s|$)/i);
    if (!match) return undefined;
    if (match[1] == null) return null;
    return sanitizeResumeTargetId(match[1]) ?? undefined;
  }

  if (provider === "droid") {
    const droidCommand = extractWrappedProviderCommand(command, "droid");
    const match = droidCommand.match(
      /^droid\b.*?(?:--resume(?:=|\s+)?([^;\s]+)?|-r\s+([^;\s]+)|\bexec\b.*?(?:--session-id|-s)\s+([^;\s]+))(?=\s*(?:[;&]|$))/i,
    );
    if (!match) return undefined;
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw == null) return null;
    return sanitizeResumeTargetId(raw) ?? undefined;
  }

  const match = command.match(/^opencode\b.*?(?:--session(?:=|\s+)([^\s]+)|-s\s+([^\s]+)|--continue\b|-c\b)(?:\s|$)/i);
  if (!match) return undefined;
  const raw = match[1] ?? match[2];
  if (raw == null) return null;
  return sanitizeResumeTargetId(raw) ?? undefined;
}

export function parseTrackedCliResumeCommand(
  raw: string | null | undefined,
  preferredTool?: TerminalToolType | null,
): { provider: TerminalResumeProvider; targetId: string | null } | null {
  const normalized = normalizeCommand(raw ?? "");
  if (!normalized) return null;

  const command = stripLeadingEnvAssignments(normalized);
  const cmdTool = toolFromCommand(command);
  const provider = cmdTool ? providerFromTool(cmdTool) : providerFromTool(preferredTool);
  if (!provider) return null;

  const target = parseProviderResumeTarget(provider, command);
  if (target === undefined) return null;
  return { provider, targetId: target };
}

export function buildTrackedCliResumeCommand(metadata: TerminalResumeMetadata | null | undefined): string | null {
  if (!metadata) return null;
  const provider = metadata.provider;
  const permissionMode = metadata.launch.permissionMode ?? null;
  const targetId = sanitizeResumeTargetId(metadata.targetId) ?? "";

  if (provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(permissionMode)];
    parts.push("--resume");
    if (targetId.length) parts.push(targetId);
    return commandArrayToLine(parts);
  }

  if (provider === "codex") {
    const parts = ["codex", "--no-alt-screen", ...permissionModeToCodexFlags(permissionMode)];
    parts.push("resume");
    if (targetId.length) parts.push(targetId);
    return commandArrayToLine(parts);
  }

  if (provider === "cursor") {
    const parts = ["cursor-agent", ...permissionModeToCursorFlags(permissionMode)];
    if (targetId.length) {
      parts.push("--resume", targetId);
    } else {
      parts.push("--continue");
    }
    return commandArrayToLine(parts);
  }

  if (provider === "droid") {
    return buildDroidCommandLine({ permissionMode, resumeTarget: targetId || null });
  }

  return buildOpenCodeResumeCommand({ permissionMode, targetId: targetId || null });
}

function canonicalizePreferredTool(preferredTool: TerminalToolType | null | undefined): TerminalToolType | null | undefined {
  if (preferredTool === "claude-orchestrated") return "claude";
  if (preferredTool === "codex-orchestrated") return "codex";
  return preferredTool;
}

function prefersTool(raw: string, preferredTool: TerminalToolType | null | undefined): boolean {
  const canonicalPreferredTool = canonicalizePreferredTool(preferredTool);
  if (!canonicalPreferredTool) return true;
  const cmdTool = toolFromCommand(raw);
  if (!cmdTool) return true;
  return cmdTool === canonicalPreferredTool;
}

export function normalizeResumeCommand(
  raw: string | null | undefined,
  preferredTool?: TerminalToolType | null,
): string | null {
  const normalized = normalizeCommand(raw ?? "");
  if (!normalized) return null;
  if (!prefersTool(normalized, preferredTool)) return null;

  const command = stripLeadingEnvAssignments(normalized);
  if (/^claude\s+/i.test(command)) {
    return command
      .replace(/^claude\s+resume\b/i, "claude --resume")
      .replace(/^claude\s+-r\b/i, "claude --resume");
  }
  return normalized;
}

export function defaultResumeCommandForTool(toolType: TerminalToolType | null | undefined): string | null {
  if (toolType === "claude" || toolType === "claude-orchestrated") return "claude --resume";
  if (toolType === "codex" || toolType === "codex-orchestrated") return "codex resume";
  if (toolType === "cursor-cli") return "cursor-agent --continue";
  if (toolType === "droid") return "droid --resume";
  if (toolType === "opencode") return "opencode --continue";
  return null;
}

/** Strip ANSI escape codes so resume-command regexes can match TUI output. */
function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;?=><]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g, "");
}

export function extractResumeCommandFromOutput(
  text: string,
  preferredTool?: TerminalToolType | null
): string | null {
  if (!text.trim()) return null;

  const cleaned = stripAnsiCodes(text);
  const candidates = [
    ...Array.from(cleaned.matchAll(RESUME_BACKTICK_REGEX)).map((m) => m[1] ?? ""),
    ...Array.from(cleaned.matchAll(RESUME_COMMAND_REGEX)).map((m) => m[1] ?? ""),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeResumeCommand(candidate, preferredTool);
    if (normalized && parseTrackedCliResumeCommand(normalized, preferredTool)) {
      return normalized;
    }
  }

  return null;
}

export function runtimeStateFromOsc133Chunk(
  chunk: string,
  previous: TerminalRuntimeState
): TerminalRuntimeState {
  let next = previous;
  if (!chunk) return next;
  for (const match of chunk.matchAll(OSC_133_REGEX)) {
    const marker = (match[1] ?? "").toUpperCase();
    if (marker === "A" || marker === "D") {
      next = "waiting-input";
      continue;
    }
    if (marker === "B" || marker === "C") {
      next = "running";
    }
  }
  return next;
}
