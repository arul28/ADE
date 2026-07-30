import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatPermissionMode,
  TerminalResumeLaunchConfig,
  TerminalResumeMetadata,
  TerminalResumeProvider,
  TerminalRuntimeState,
  TerminalToolType,
} from "../../shared/types";
import {
  buildOpenCodeReplayResumeCommand as buildCanonicalOpenCodeReplayResumeCommand,
  buildTrackedCliResumeCommand as buildCanonicalTrackedCliResumeCommand,
  normalizeCliFlagValue,
  OPENCODE_RESUME_REPLAY_LIMIT as CANONICAL_OPENCODE_RESUME_REPLAY_LIMIT,
  sanitizeTrackedCliResumeTargetId,
} from "../../shared/cliLaunch";
import { parseCommandLine } from "../../shared/shell";

const OSC_133_REGEX = /\u001b\]133;([ABCD])(?:;[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
const RESUME_BACKTICK_REGEX = /`([^`\r\n]*(?:claude|codex|cursor-agent|droid|opencode)\s+[^`\r\n]*(?:--resume|-r|resume|--continue|-c|--session|-s)[^`\r\n]*)`/gi;
const RESUME_HINT_PREFIX_REGEX = /\b(?:resume|continue)\s+with\s+(.+)$/i;
const RESUME_COMMAND_LINE_REGEX = /^(?:.*?(?:[%$#❯›]\s+))?((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*(?:claude|codex|cursor-agent|droid|opencode)\s+.+)$/i;

export const sanitizeResumeTargetId = sanitizeTrackedCliResumeTargetId;

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

function extractCliFlagValue(command: string, flag: string): string | null {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(String.raw`(?:^|\s)${escapedFlag}(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+))|\s+(?:"([^"]*)"|'([^']*)'|([^\s]+)))`, "i"));
  const value = match ? (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "") : "";
  return normalizeCliFlagValue(value);
}

function extractCodexReasoningEffort(command: string): string | null {
  const match = command.match(/model_reasoning_effort=(?:\\?["']?)([A-Za-z0-9_-]+)/i);
  return normalizeCliFlagValue(match?.[1] ?? "");
}

function extractFastMode(command: string): boolean | undefined {
  const serviceTier = command.match(/service_tier=(?:\\?["']?)([A-Za-z0-9_-]+)/i)?.[1]?.toLowerCase();
  if (serviceTier === "fast") return true;
  if (serviceTier === "default" || serviceTier === "standard") return false;
  const featureFastMode = command.match(/features\.fast_mode=(true|false)/i)?.[1]?.toLowerCase();
  if (featureFastMode === "true") return true;
  if (featureFastMode === "false") return false;
  return undefined;
}

function extractClaudeFastMode(command: string): boolean | undefined {
  let parts: string[];
  try {
    parts = parseCommandLine(stripLeadingEnvAssignments(command));
  } catch {
    return undefined;
  }
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const inlinePrefix = "--settings=";
    const settings = part === "--settings"
      ? parts[i + 1]
      : part.startsWith(inlinePrefix)
        ? part.slice(inlinePrefix.length)
        : null;
    if (!settings) continue;
    try {
      const parsed = JSON.parse(settings);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>).fastMode;
        if (value === true) return true;
        if (value === false) return false;
      }
    } catch {
      // Non-JSON --settings values are paths; they do not carry an ADE fast override.
    }
  }
  return undefined;
}

function extractOpenCodeVariant(command: string): string | null {
  return extractCliFlagValue(command, "--variant");
}

function extractDroidSettings(command: string): Record<string, unknown> | null {
  const match = command.match(/\bprintf\s+%s\s+(.+?)\s+>\s+(?:"\$ADE_DROID_SETTINGS"|'?\$ADE_DROID_SETTINGS'?)/i);
  const encoded = match?.[1]?.trim();
  if (!encoded) return null;
  try {
    const [json] = parseCommandLine(encoded);
    if (!json) return null;
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function droidPermissionModeFromSettings(settings: Record<string, unknown> | null): AgentChatPermissionMode | null {
  const defaults = settings?.sessionDefaultSettings;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return null;
  const defaultRecord = defaults as Record<string, unknown>;
  const interactionMode = String(defaultRecord.interactionMode ?? "").toLowerCase();
  const autonomyLevel = String(defaultRecord.autonomyLevel ?? "").toLowerCase();
  if (interactionMode === "spec" || autonomyLevel === "off") return "plan";
  if (autonomyLevel === "high") return "full-auto";
  if (autonomyLevel === "medium") return "default";
  if (autonomyLevel === "low") return "edit";
  return null;
}

function droidStringSetting(settings: Record<string, unknown> | null, key: string): string | null {
  const value = settings?.[key];
  return typeof value === "string" ? normalizeCliFlagValue(value) : null;
}

function droidSpecStringSetting(settings: Record<string, unknown> | null, key: string): string | null {
  const defaults = settings?.sessionDefaultSettings;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return null;
  const value = (defaults as Record<string, unknown>)[key];
  return typeof value === "string" ? normalizeCliFlagValue(value) : null;
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
  if (toolType === "opencode" || toolType === "opencode-orchestrated" || toolType === "opencode-chat") return "opencode";
  return null;
}

export const OPENCODE_RESUME_REPLAY_LIMIT = CANONICAL_OPENCODE_RESUME_REPLAY_LIMIT;

export function buildOpenCodeReplayResumeCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  targetId: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  prompt: string;
  replayLimit?: number | null;
}): string {
  return buildCanonicalOpenCodeReplayResumeCommand({
    permissionMode: args.permissionMode,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    fastMode: args.fastMode,
    prompt: args.prompt,
    resumeTarget: args.targetId,
    continueLast: !args.targetId,
    replayLimit: args.replayLimit,
  });
}

function extractTrackedCliPermissionMode(command: string, provider: TerminalResumeProvider): AgentChatPermissionMode | undefined {
  const normalized = command.trim().toLowerCase();
  if (provider === "claude") {
    if (normalized.includes("--dangerously-skip-permissions")) return "full-auto";
    if (normalized.includes("--permission-mode acceptedits")) return "edit";
    if (normalized.includes("--permission-mode auto")) return "auto";
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
    if (normalized.includes("--mode ask")) return "plan";
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

  const droidSettings = provider === "droid" ? extractDroidSettings(normalized) : null;
  const permissionMode = droidPermissionModeFromSettings(droidSettings)
    ?? extractTrackedCliPermissionMode(normalized, provider);
  const model = droidStringSetting(droidSettings, "model")
    ?? droidSpecStringSetting(droidSettings, "specModeModel")
    ?? extractCliFlagValue(normalized, "--model");
  const reasoningEffort = droidStringSetting(droidSettings, "reasoningEffort")
    ?? droidSpecStringSetting(droidSettings, "specModeReasoningEffort")
    ?? (provider === "codex"
    ? extractCodexReasoningEffort(normalized)
    : provider === "opencode"
      ? (() => {
          const variant = extractOpenCodeVariant(normalized);
          return variant?.toLowerCase() === "fast" ? null : variant;
        })()
      : (extractCliFlagValue(normalized, "--effort") ?? extractCliFlagValue(normalized, "--reasoning-effort")));
  const fastMode = provider === "codex"
    ? extractFastMode(normalized)
    : provider === "claude"
      ? extractClaudeFastMode(normalized)
      : extractOpenCodeVariant(normalized)?.toLowerCase() === "fast"
        ? true
        : undefined;

  if (provider === "claude") {
    const effectivePermissionMode = permissionMode ?? "default";
    let claudePermissionMode: AgentChatClaudePermissionMode;
    if (effectivePermissionMode === "full-auto") {
      claudePermissionMode = "bypassPermissions";
    } else if (effectivePermissionMode === "edit") {
      claudePermissionMode = "acceptEdits";
    } else if (effectivePermissionMode === "auto" || effectivePermissionMode === "plan") {
      claudePermissionMode = effectivePermissionMode;
    } else {
      claudePermissionMode = "default";
    }
    return {
      permissionMode: effectivePermissionMode,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      claudePermissionMode,
    };
  }

  if (provider === "codex") {
    const base = {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    };
    const codexPolicies: Record<string, { codexApprovalPolicy: AgentChatCodexApprovalPolicy; codexSandbox: AgentChatCodexSandbox }> = {
      "full-auto": { codexApprovalPolicy: "never", codexSandbox: "danger-full-access" },
      edit: { codexApprovalPolicy: "untrusted", codexSandbox: "workspace-write" },
      default: { codexApprovalPolicy: "on-request", codexSandbox: "workspace-write" },
      plan: { codexApprovalPolicy: "on-request", codexSandbox: "read-only" },
    };
    const policy = permissionMode ? codexPolicies[permissionMode] : undefined;
    if (policy) {
      return { permissionMode, ...base, ...policy, codexConfigSource: "flags" };
    }
    return { permissionMode: "config-toml", ...base, codexConfigSource: "config-toml" };
  }

  return {
    ...(permissionMode ? { permissionMode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
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
    let parts: string[];
    try {
      parts = parseCommandLine(command);
    } catch {
      return undefined;
    }
    if (parts[0]?.toLowerCase() !== "codex") return undefined;
    const resumeIndex = parts.findIndex((part, index) => index > 0 && part.toLowerCase() === "resume");
    if (resumeIndex < 0) return undefined;
    const raw = parts[resumeIndex + 1];
    if (raw == null) return null;
    return sanitizeResumeTargetId(raw) ?? undefined;
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

export function buildTrackedCliResumeCommand(
  metadata: TerminalResumeMetadata | null | undefined,
  overrides: {
    model?: string | null;
    reasoningEffort?: string | null;
    fastMode?: boolean | null;
    permissionMode?: AgentChatPermissionMode | null;
    prompt?: string | null;
    codexComputerUse?: { command: string; args?: readonly string[] } | null;
  } = {},
): string | null {
  if (!metadata) return null;
  return buildCanonicalTrackedCliResumeCommand(metadata, overrides);
}

function canonicalizePreferredTool(preferredTool: TerminalToolType | null | undefined): TerminalToolType | null | undefined {
  if (preferredTool === "claude-orchestrated") return "claude";
  if (preferredTool === "codex-orchestrated") return "codex";
  if (preferredTool === "opencode-orchestrated") return "opencode";
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
  if (toolType === "cursor-cli") return "cursor-agent --model auto --continue";
  if (toolType === "droid") return "droid --resume";
  if (toolType === "opencode" || toolType === "opencode-orchestrated") return "opencode --continue";
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
    ...cleaned
      .split(/\r?\n/)
      .flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed) return [];
        const hinted = trimmed.match(RESUME_HINT_PREFIX_REGEX)?.[1]?.trim();
        if (hinted && toolFromCommand(hinted)) return [hinted];
        const command = trimmed.match(RESUME_COMMAND_LINE_REGEX)?.[1]?.trim();
        return command ? [command] : [];
      }),
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
    if (marker === "B" || marker === "C") {
      next = "running";
    }
  }
  return next;
}
