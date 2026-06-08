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
  claudeFastModeSettingsFlags,
  codexServiceTierFlags,
  codexReasoningEffortFlags,
  modelToCliFlag,
  normalizeCliFlagValue,
  resolveClaudeCliModelForLaunch,
  resolveCursorCliModelForLaunch,
  sanitizeTrackedCliResumeTargetId,
} from "../../shared/cliLaunch";
import { decodeOpenCodeRegistryId } from "../../shared/modelRegistry";
import { parseCommandLine } from "../../shared/shell";

const OSC_133_REGEX = /\u001b\]133;([ABCD])(?:;[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
const RESUME_BACKTICK_REGEX = /`([^`\r\n]*(?:claude|codex|cursor-agent|droid|opencode)\s+[^`\r\n]*(?:--resume|-r|resume|--continue|-c|--session|-s)[^`\r\n]*)`/gi;
const RESUME_HINT_PREFIX_REGEX = /\b(?:resume|continue)\s+with\s+(.+)$/i;
const RESUME_COMMAND_LINE_REGEX = /^(?:.*?(?:[%$#❯›]\s+))?((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*(?:claude|codex|cursor-agent|droid|opencode)\s+.+)$/i;

function shellQuote(value: string): string {
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_.:@%+=,/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandArrayToLine(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

export const sanitizeResumeTargetId = sanitizeTrackedCliResumeTargetId;

function normalizeDroidCliModel(model: string | null | undefined): string | null {
  const normalized = normalizeCliFlagValue(model);
  if (!normalized) return null;
  const slash = normalized.indexOf("/");
  if (slash > 0 && normalized.slice(0, slash).toLowerCase() === "droid") {
    return normalized.slice(slash + 1).trim() || null;
  }
  return normalized;
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

function permissionModeToClaudeFlag(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--dangerously-skip-permissions"];
  if (permissionMode === "edit") return ["--permission-mode", "acceptEdits"];
  if (permissionMode === "auto") return ["--permission-mode", "auto"];
  if (permissionMode === "default") return ["--permission-mode", "default"];
  return ["--permission-mode", "plan"];
}

function permissionModeToCodexFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (permissionMode === "default") return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
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

function droidSettingsJson(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
}): string {
  const sessionDefaultSettings = (() => {
    if (args.permissionMode === "full-auto") return { interactionMode: "auto", autonomyLevel: "high" };
    if (args.permissionMode === "default") return { interactionMode: "auto", autonomyLevel: "medium" };
    if (args.permissionMode === "edit") return { interactionMode: "auto", autonomyLevel: "low" };
    return { interactionMode: "spec", autonomyLevel: "off" };
  })();
  const model = normalizeDroidCliModel(args.model);
  const reasoningEffort = normalizeCliFlagValue(args.reasoningEffort);
  const settings: Record<string, unknown> = { sessionDefaultSettings };
  if (model) settings.model = model;
  if (reasoningEffort) settings.reasoningEffort = reasoningEffort;
  if (args.permissionMode === "plan") {
    const specDefaults = sessionDefaultSettings as Record<string, unknown>;
    if (model) specDefaults.specModeModel = model;
    if (reasoningEffort) specDefaults.specModeReasoningEffort = reasoningEffort;
  }
  return JSON.stringify(settings);
}

function buildDroidCommandLine(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt?: string | null;
  resumeTarget?: string | null;
}): string {
  const droidArgs = ["droid", "--settings", "$ADE_DROID_SETTINGS", "--resume"];
  if (args.resumeTarget) droidArgs.push(args.resumeTarget);
  if (args.prompt) droidArgs.push(args.prompt);
  const droidCommand = commandArrayToLine(droidArgs).replace(shellQuote("$ADE_DROID_SETTINGS"), "\"$ADE_DROID_SETTINGS\"");
  return [
    "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\"",
    `printf %s ${shellQuote(droidSettingsJson(args))} > "$ADE_DROID_SETTINGS"`,
    `${droidCommand}; ADE_DROID_STATUS=$?; rm -f "$ADE_DROID_SETTINGS"; exit $ADE_DROID_STATUS`,
  ].join(" && ");
}

const OPENCODE_INLINE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

function openCodePermissionValue(permissionMode: AgentChatPermissionMode | null | undefined): string | Record<string, string> | null {
  if (permissionMode === "config-toml") return null;
  if (permissionMode === "full-auto") return "allow";
  if (permissionMode === "edit") return { "*": "ask", edit: "allow", question: "allow" };
  if (permissionMode === "plan") return { "*": "ask", edit: "deny", bash: "deny", question: "allow" };
  return { "*": "ask", question: "allow" };
}

function openCodeConfigEnv(permissionMode: AgentChatPermissionMode | null | undefined): string | null {
  const permission = openCodePermissionValue(permissionMode);
  return permission ? JSON.stringify({ permission }) : null;
}

function normalizeOpenCodeCliModel(model: string | null | undefined): string | null {
  const normalized = normalizeCliFlagValue(model);
  if (!normalized) return null;
  const decoded = decodeOpenCodeRegistryId(normalized);
  if (!decoded) return normalized;
  return `${decoded.openCodeProviderId}/${decoded.openCodeModelId}`;
}

function permissionModeToOpenCodeArgs(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  return permissionMode === "plan" ? ["--agent", "plan"] : [];
}

function buildOpenCodeResumeCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  targetId: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  prompt?: string | null;
}): string {
  const variant = args.fastMode === true ? "fast" : normalizeCliFlagValue(args.reasoningEffort);
  const commandArgs = [
    "opencode",
    ...(variant ? ["run", "--interactive"] : []),
    ...permissionModeToOpenCodeArgs(args.permissionMode),
    ...modelToCliFlag(normalizeOpenCodeCliModel(args.model)),
  ];
  if (variant) commandArgs.push("--variant", variant);
  if (args.targetId) {
    commandArgs.push("--session", args.targetId);
  } else {
    commandArgs.push("--continue");
  }
  if (args.prompt) {
    if (variant) {
      commandArgs.push("--", args.prompt);
    } else {
      commandArgs.push("--prompt", args.prompt);
    }
  }
  const config = openCodeConfigEnv(args.permissionMode);
  const assignment = config ? `${OPENCODE_INLINE_CONFIG_ENV}=${shellQuote(config)} ` : "";
  return `${assignment}${commandArrayToLine(commandArgs)}`;
}

export const OPENCODE_RESUME_REPLAY_LIMIT = 40;

export function buildOpenCodeReplayResumeCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  targetId: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  prompt: string;
  replayLimit?: number | null;
}): string {
  const variant = args.fastMode === true ? "fast" : normalizeCliFlagValue(args.reasoningEffort);
  const commandArgs = [
    "opencode",
    "run",
    "--interactive",
    ...permissionModeToOpenCodeArgs(args.permissionMode),
    ...modelToCliFlag(normalizeOpenCodeCliModel(args.model)),
  ];
  if (variant) commandArgs.push("--variant", variant);
  if (args.targetId) {
    commandArgs.push("--session", args.targetId);
  } else {
    commandArgs.push("--continue");
  }
  const replayLimit = Number.isFinite(args.replayLimit)
    ? Math.max(1, Math.floor(Number(args.replayLimit)))
    : OPENCODE_RESUME_REPLAY_LIMIT;
  commandArgs.push("--replay", "--replay-limit", String(replayLimit), "--", args.prompt);
  const config = openCodeConfigEnv(args.permissionMode);
  const assignment = config ? `${OPENCODE_INLINE_CONFIG_ENV}=${shellQuote(config)} ` : "";
  return `${assignment}${commandArrayToLine(commandArgs)}`;
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

export function buildTrackedCliResumeCommand(
  metadata: TerminalResumeMetadata | null | undefined,
  overrides: {
    model?: string | null;
    reasoningEffort?: string | null;
    fastMode?: boolean | null;
    permissionMode?: AgentChatPermissionMode | null;
    prompt?: string | null;
  } = {},
): string | null {
  if (!metadata) return null;
  const provider = metadata.provider;
  const permissionMode = overrides.permissionMode ?? metadata.launch.permissionMode ?? null;
  const model = overrides.model !== undefined ? overrides.model : metadata.launch.model;
  const reasoningEffort = overrides.reasoningEffort !== undefined
    ? overrides.reasoningEffort
    : metadata.launch.reasoningEffort;
  const fastMode = overrides.fastMode !== undefined
    ? overrides.fastMode
    : metadata.launch.fastMode ?? metadata.launch.codexFastMode;
  const targetId = sanitizeResumeTargetId(metadata.targetId) ?? "";
  const prompt = normalizeCliFlagValue(overrides.prompt);

  if (provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(permissionMode)];
    const claudeModel = resolveClaudeCliModelForLaunch(model);
    if (claudeModel) parts.push("--model", claudeModel);
    const claudeReasoningEffort = normalizeCliFlagValue(reasoningEffort);
    if (claudeReasoningEffort) parts.push("--effort", claudeReasoningEffort);
    parts.push(...claudeFastModeSettingsFlags(fastMode));
    parts.push("--resume");
    if (targetId.length) parts.push(targetId);
    if (prompt) parts.push(prompt);
    return commandArrayToLine(parts);
  }

  if (provider === "codex") {
    const parts = [
      "codex",
      "--no-alt-screen",
      ...modelToCliFlag(model),
      ...codexReasoningEffortFlags(reasoningEffort),
      ...codexServiceTierFlags(fastMode),
      ...permissionModeToCodexFlags(permissionMode),
    ];
    parts.push("resume");
    if (targetId.length) parts.push(targetId);
    if (prompt) parts.push(prompt);
    return commandArrayToLine(parts);
  }

  if (provider === "cursor") {
    const cursorModel = overrides.model !== undefined
      ? resolveCursorCliModelForLaunch(overrides.model)
      : resolveCursorCliModelForLaunch(metadata.launch.model);
    const parts = ["cursor-agent", ...permissionModeToCursorFlags(permissionMode), ...modelToCliFlag(cursorModel)];
    if (targetId.length) {
      parts.push("--resume", targetId);
    } else {
      parts.push("--continue");
    }
    if (prompt) parts.push(prompt);
    return commandArrayToLine(parts);
  }

  if (provider === "droid") {
    return buildDroidCommandLine({ permissionMode, model, reasoningEffort, prompt, resumeTarget: targetId || null });
  }

  return buildOpenCodeResumeCommand({ permissionMode, targetId: targetId || null, model, reasoningEffort, fastMode, prompt });
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
