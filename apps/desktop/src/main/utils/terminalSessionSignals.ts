import type {
  AgentChatPermissionMode,
  TerminalResumeLaunchConfig,
  TerminalResumeMetadata,
  TerminalResumeProvider,
  TerminalRuntimeState,
  TerminalToolType,
} from "../../shared/types";

const OSC_133_REGEX = /\u001b\]133;([ABCD])(?:;[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
const RESUME_BACKTICK_REGEX = /`((?:claude|codex)\s+(?:(?:--resume|-r|resume)\b)[^`\r\n]*)`/gi;
const RESUME_PLAIN_REGEX = /\b((?:claude|codex)\s+(?:(?:--resume|-r|resume)\b)[^\r\n]*?(?=\s+(?:claude|codex)\s|$))/gi;

function normalizeCommand(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[)\].,;:!?]+$/g, "")
    .trim();
}

function toolFromCommand(raw: string): TerminalToolType | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.startsWith("claude ")) return "claude";
  if (normalized.startsWith("codex ")) return "codex";
  return null;
}

function providerFromTool(toolType: TerminalToolType | null | undefined): TerminalResumeProvider | null {
  if (toolType === "claude" || toolType === "claude-orchestrated" || toolType === "claude-chat") return "claude";
  if (toolType === "codex" || toolType === "codex-orchestrated" || toolType === "codex-chat") return "codex";
  return null;
}

function permissionModeToClaudeFlag(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--dangerously-skip-permissions"];
  if (permissionMode === "edit") return ["--permission-mode", "acceptEdits"];
  if (permissionMode === "default") return ["--permission-mode", "default"];
  return ["--permission-mode", "plan"];
}

function permissionModeToCodexFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--full-auto"];
  if (permissionMode === "edit") return ["-c", "approval_policy=on-failure", "-c", "sandbox_mode=workspace-write"];
  if (permissionMode === "default" || permissionMode === "plan") {
    return ["-c", "approval_policy=untrusted", "-c", "sandbox_mode=read-only"];
  }
  return [];
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

  if (normalized.includes("--full-auto")) return "full-auto";
  if (normalized.includes("approval_policy=on-failure") || normalized.includes("sandbox_mode=workspace-write")) return "edit";
  if (normalized.includes("approval_policy=untrusted") || normalized.includes("sandbox_mode=read-only")) return "default";
  if (normalized.includes("approval_policy=") || normalized.includes("sandbox_mode=")) return "plan";
  return "config-toml";
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
    return {
      permissionMode: effectivePermissionMode,
      claudePermissionMode: effectivePermissionMode === "full-auto"
        ? "bypassPermissions"
        : effectivePermissionMode === "edit"
          ? "acceptEdits"
          : "default",
    };
  }

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
      codexApprovalPolicy: "on-failure",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    };
  }

  if (permissionMode === "default" || permissionMode === "plan") {
    return {
      permissionMode,
      codexApprovalPolicy: "untrusted",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    };
  }

  return {
    permissionMode: "config-toml",
    codexConfigSource: "config-toml",
  };
}

export function parseTrackedCliResumeCommand(
  raw: string | null | undefined,
  preferredTool?: TerminalToolType | null,
): { provider: TerminalResumeProvider; targetId: string | null } | null {
  const normalized = normalizeCommand(raw ?? "");
  if (!normalized) return null;

  const cmdTool = toolFromCommand(normalized);
  const provider = cmdTool === "claude" || cmdTool === "codex"
    ? cmdTool
    : providerFromTool(preferredTool);
  if (!provider) return null;

  if (provider === "claude") {
    const match = normalized.match(/^claude(?:(?:\s+--[^\s]+)(?:\s+[^\s]+)?)*\s+(?:--resume|-r|resume)\s+([^\s]+)(?:\s|$)/i);
    if (!match) return { provider, targetId: null };
    return { provider, targetId: match[1] ?? null };
  }

  const match = normalized.match(/^codex(?:\s+--no-alt-screen)?(?:\s+-c\s+[^\s]+)*(?:\s+resume)\s+([^\s]+)(?:\s|$)/i);
  if (!match) return { provider, targetId: null };
  return { provider, targetId: match[1] ?? null };
}

export function buildTrackedCliResumeCommand(metadata: TerminalResumeMetadata | null | undefined): string | null {
  if (!metadata) return null;
  const provider = metadata.provider;
  const permissionMode = metadata.launch.permissionMode ?? null;
  const targetId = typeof metadata.targetId === "string" ? metadata.targetId.trim() : "";

  if (provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(permissionMode)];
    if (targetId.length) parts.push("--resume", targetId);
    return parts.join(" ");
  }

  const parts = ["codex", "--no-alt-screen", ...permissionModeToCodexFlags(permissionMode)];
  if (targetId.length) parts.push("resume", targetId);
  return parts.join(" ");
}

function canonicalizePreferredTool(preferredTool: TerminalToolType | null | undefined): TerminalToolType | null | undefined {
  if (preferredTool === "claude-orchestrated") return "claude";
  if (preferredTool === "codex-orchestrated") return "codex";
  return preferredTool;
}

function prefersTool(raw: string, preferredTool: TerminalToolType | null | undefined): boolean {
  const canonicalPreferredTool = canonicalizePreferredTool(preferredTool);
  if (!canonicalPreferredTool || (canonicalPreferredTool !== "claude" && canonicalPreferredTool !== "codex")) return true;
  const cmdTool = toolFromCommand(raw);
  return cmdTool === canonicalPreferredTool;
}

export function normalizeResumeCommand(
  raw: string | null | undefined,
  preferredTool?: TerminalToolType | null,
): string | null {
  const normalized = normalizeCommand(raw ?? "");
  if (!normalized) return null;
  if (!prefersTool(normalized, preferredTool)) return null;

  if (/^claude\s+/i.test(normalized)) {
    return normalized
      .replace(/^claude\s+resume\b/i, "claude --resume")
      .replace(/^claude\s+-r\b/i, "claude --resume");
  }

  return normalized;
}

export function defaultResumeCommandForTool(toolType: TerminalToolType | null | undefined): string | null {
  if (toolType === "claude" || toolType === "claude-orchestrated") return "claude --resume";
  if (toolType === "codex" || toolType === "codex-orchestrated") return "codex resume";
  return null;
}

export function extractResumeCommandFromOutput(
  text: string,
  preferredTool?: TerminalToolType | null
): string | null {
  if (!text.trim()) return null;

  const fromBackticks = Array.from(text.matchAll(RESUME_BACKTICK_REGEX))
    .map((m) => normalizeResumeCommand(m[1] ?? "", preferredTool))
    .filter(Boolean);
  for (const candidate of fromBackticks) {
    return candidate;
  }

  const fromPlain = Array.from(text.matchAll(RESUME_PLAIN_REGEX))
    .map((m) => normalizeResumeCommand(m[1] ?? "", preferredTool))
    .filter(Boolean);
  for (const candidate of fromPlain) {
    return candidate;
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
