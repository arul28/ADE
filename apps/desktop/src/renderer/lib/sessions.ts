/** Shared session/terminal utilities for the renderer. */

import type { AgentChatProvider, AgentChatSession, TerminalSessionSummary, TerminalToolType } from "../../shared/types";
import { isProviderSlashCommandInput } from "../../shared/chatSlashCommands";

/** Returns true if the tool type represents an AI chat session. */
export function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return (
    t === "codex-chat"
    || t === "claude-chat"
    || t === "opencode-chat"
    || t === "cursor"
    || t.endsWith("-chat")
  );
}

/**
 * Turns a runtime rejection into copy a person can act on.
 *
 * Every runtime call the Work rows make crosses `ipcRenderer.invoke`, which
 * wraps the real message in `Error invoking remote method '<channel>': Error:
 * …`. That prefix names an IPC channel the user has no relationship with, and
 * it is the first thing they read in a red banner. Strip it, then translate the
 * two failures a person can actually do something about — an ownership mismatch
 * and an offline machine — into what is blocked and what to do next.
 */
export function formatSessionActionError(error: unknown, action: string): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).trim();
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  if (!message) return `${action} failed. Try again.`;
  if (/(?:session|chat) '[^']*' was not found\.?$/i.test(message)) {
    // The session belongs to a different machine than the one the call reached,
    // or it is already gone. Both are fixed the same way, and neither is worth
    // showing the raw id for.
    return `${action} failed: that session is no longer on the machine this tab is connected to. Refresh the list, or switch to the machine that owns it and try again.`;
  }
  if (/is still owned by another ADE runtime/i.test(message)) {
    return `${action} failed: another ADE runtime still owns this session. Stop it from that machine first.`;
  }
  return `${action} failed: ${message}`;
}

export function canBulkStopSession(session: Pick<TerminalSessionSummary, "status" | "toolType">): boolean {
  return session.status === "running" && !isChatToolType(session.toolType);
}

export function canBulkDeleteSession(session: Pick<TerminalSessionSummary, "status" | "toolType">): boolean {
  return session.status !== "running" || isChatToolType(session.toolType);
}

export function chatToolTypeForProvider(provider: AgentChatProvider | string | null | undefined): TerminalToolType {
  switch (provider) {
    case "claude": return "claude-chat";
    case "codex": return "codex-chat";
    case "cursor": return "cursor";
    case "droid": return "droid-chat";
    case "pi": return "pi-chat";
    default: return "opencode-chat";
  }
}

export const STALE_RUNNING_CLI_SESSION_MS = 24 * 60 * 60 * 1_000;
const STALE_RUNNING_CLI_SESSION_HOURS = STALE_RUNNING_CLI_SESSION_MS / (60 * 60 * 1_000);

/**
 * Returns how many hours a running CLI/shell session has been *idle* (no output),
 * or null if it is not stale. Staleness keys off the last activity timestamp —
 * not when the session started — so an old session that is still actively
 * producing output is never flagged; only genuinely untouched ones are. Falls
 * back to startedAt when no activity timestamp has been recorded yet.
 */
export function getStaleRunningCliSessionAgeHours(
  session: Pick<TerminalSessionSummary, "status" | "startedAt" | "toolType" | "lastActivityAt">,
  nowMs: number = Date.now(),
): number | null {
  if (session.status !== "running") return null;
  if (isChatToolType(session.toolType)) return null;
  const lastActivityMs = session.lastActivityAt ? Date.parse(session.lastActivityAt) : Number.NaN;
  const startedMs = Date.parse(session.startedAt);
  const referenceMs = Number.isFinite(lastActivityMs) ? lastActivityMs : startedMs;
  if (!Number.isFinite(referenceMs)) return null;
  const idleMs = nowMs - referenceMs;
  if (idleMs < STALE_RUNNING_CLI_SESSION_MS) return null;
  return Math.max(STALE_RUNNING_CLI_SESSION_HOURS, Math.floor(idleMs / (60 * 60 * 1_000)));
}

export function defaultSessionLabel(toolType: string | null | undefined): string {
  if (toolType === "shell" || toolType == null) return "Workspace";
  if (toolType === "claude-orchestrated") return "Claude worker";
  if (toolType === "codex-orchestrated") return "Codex worker";
  if (toolType === "opencode-orchestrated") return "OpenCode worker";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "opencode-chat") return "OpenCode chat";
  if (toolType === "pi-chat") return "Pi chat";
  if (toolType === "cursor") return "Cursor chat";
  if (toolType === "cursor-cli") return "Cursor CLI session";
  if (toolType === "droid") return "Droid CLI session";
  if (toolType === "opencode") return "OpenCode CLI session";
  if (toolType === "droid-chat") return "Droid chat";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
  return "Session";
}

export function buildOptimisticChatSessionSummary(args: {
  session: Pick<
    AgentChatSession,
    | "id"
    | "laneId"
    | "provider"
    | "status"
    | "currentTurnStartedAt"
    | "createdAt"
    | "lastActivityAt"
    | "idleSinceAt"
    | "orchestrationRunId"
    | "orchestrationRole"
    | "orchestrationTag"
  >;
  laneName?: string | null;
}): TerminalSessionSummary {
  const toolType = chatToolTypeForProvider(args.session.provider);
  const isEnded = args.session.status === "ended";

  return {
    id: args.session.id,
    laneId: args.session.laneId,
    laneName: args.laneName?.trim() || args.session.laneId,
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType,
    title: defaultSessionLabel(toolType),
    status: isEnded ? "completed" : "running",
    startedAt: args.session.createdAt,
    endedAt: isEnded ? args.session.lastActivityAt : null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: args.session.lastActivityAt ?? null,
    currentTurnStartedAt: args.session.currentTurnStartedAt ?? null,
    summary: null,
    runtimeState: isEnded ? "exited" : args.session.status === "active" ? "running" : "idle",
    resumeCommand: null,
    chatIdleSinceAt: args.session.status === "idle" ? args.session.idleSinceAt ?? null : null,
    ...(args.session.orchestrationRunId
      ? {
          orchestrationRunId: args.session.orchestrationRunId,
          orchestrationRole: args.session.orchestrationRole,
          orchestrationTag: args.session.orchestrationTag,
        }
      : {}),
  };
}

/** Exact tool-type -> short label map for compact card display. */
const SHORT_TOOL_TYPE_LABELS: Record<string, string> = {
  shell: "Shell",
  cursor: "Cursor",
  "cursor-cli": "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  aider: "Aider",
  continue: "Continue",
};

/** Prefix -> short label entries, checked in order for tool types like "claude-chat". */
const SHORT_TOOL_TYPE_PREFIXES: readonly [string, string][] = [
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
];

/** Resolve a short label via exact match, prefix match, or hyphen-to-space fallback. */
function getShortToolTypeLabel(toolType: string): string {
  const exact = SHORT_TOOL_TYPE_LABELS[toolType];
  if (exact) return exact;
  for (const [prefix, label] of SHORT_TOOL_TYPE_PREFIXES) {
    if (toolType.startsWith(prefix)) return label;
  }
  return toolType.replace(/-/g, " ");
}

/** Short tool type label for compact card display (e.g. "Claude", "Shell", "Codex"). */
export function shortToolTypeLabel(toolType: string | null | undefined): string {
  if (!toolType) return "Shell";
  return getShortToolTypeLabel(toolType);
}

export function formatToolTypeLabel(toolType: string | null | undefined): string {
  if (toolType === "claude-orchestrated") return "Claude worker runtime";
  if (toolType === "codex-orchestrated") return "Codex worker runtime";
  if (toolType === "opencode-orchestrated") return "OpenCode worker runtime";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "opencode-chat") return "OpenCode chat";
  if (toolType === "cursor") return "Cursor chat";
  if (toolType === "cursor-cli") return "Cursor CLI session";
  if (toolType === "droid") return "Droid CLI session";
  if (toolType === "opencode") return "OpenCode CLI session";
  if (toolType === "droid-chat") return "Droid chat";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
  if (toolType === "shell") return "Terminal session";
  return toolType ? toolType.replace(/-/g, " ") : "Unknown";
}

/* ── Session label helpers ──
 * Shared logic for deriving human-readable labels from session metadata.
 * Used by SessionCard and WorkViewArea.
 */

const LABEL_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const LABEL_CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LABEL_CHARSET_REGEX = /\u001b[\(\)][0-9A-Za-z]/g;
const LABEL_TWO_CHAR_ESC_REGEX = /\u001b(?:[@-Z\\-_]|[0-9=>])/g;

export function stripTerminalLabelControls(raw: string): string {
  return raw
    .replace(LABEL_OSC_REGEX, "")
    .replace(LABEL_CSI_REGEX, "")
    .replace(LABEL_CHARSET_REGEX, "")
    .replace(LABEL_TWO_CHAR_ESC_REGEX, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function stripTerminalChromeFromLabel(raw: string): string {
  return raw
    .replace(/\(FAIL,\s*exit code (130|143)(?:,[^)]*)?\)/giu, "(STOPPED, exit code $1)")
    .replace(/\((FAIL,\s*exit code \d+),\s*(?:[╭╮╯╰─│┌┐└┘├┤┬┴┼▌▐▛▜▘▝▄▀█▒░].*|Claude Code.*|\? for shortcuts.*)\)/giu, "($1)")
    .replace(/\s*(?:[╭╮╯╰─│┌┐└┘├┤┬┴┼▌▐▛▜▘▝▄▀█▒░].*|Claude Codev?\d.*|\? for shortcuts.*)$/giu, "");
}

export function normalizeSessionLabel(raw: string | null | undefined): string | null {
  const normalized = stripTerminalChromeFromLabel(stripTerminalLabelControls(String(raw ?? ""))).replace(/\s+/g, " ").trim();
  return normalized.length ? normalized : null;
}

function stripOutcomePrefix(raw: string): string {
  const stripped = raw.replace(/^(completed?|done|finished|resolved|success|interrupted|failed|error)\b[\s:.-]*/iu, "").trim();
  return stripped.length ? stripped : raw;
}

export function isLowSignalSessionLabel(raw: string | null | undefined): boolean {
  const normalized = normalizeSessionLabel(raw);
  if (!normalized) return false;

  const collapsed = normalized
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();

  if (!collapsed.length) return true;
  if (isProviderSlashCommandInput(normalized)) return true;
  if (/\b(error|exception|apicall|traceback|stack\s*trace)\b/i.test(collapsed)) return true;
  if (/^(session closed|chat completed)\b/u.test(collapsed)) return true;

  if (/^(completed?|done|finished|resolved|success)\b/u.test(collapsed)) {
    const remainder = collapsed.replace(/^(completed?|done|finished|resolved|success)\b/u, "").trim();
    const remainderTokens = remainder.length ? remainder.split(/\s+/).filter(Boolean) : [];
    const genericRemainder = remainderTokens.every((token) =>
      /^(ok|okay|ready|hello|hi|test|yes|no|true|false|response|reply|result|output|pass|passed)$/u.test(token)
    );
    return !remainderTokens.length || remainderTokens.length <= 2 || genericRemainder;
  }

  return false;
}

export function preferredSessionLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeSessionLabel(raw);
  if (!normalized || isLowSignalSessionLabel(normalized)) return null;
  return stripOutcomePrefix(normalized);
}

export function isGenericSessionTitle(session: TerminalSessionSummary, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return true;
  if (
    normalized === "opencode chat" ||
    normalized === "claude chat" ||
    normalized === "codex chat" ||
    normalized === "cursor chat" ||
    normalized === "claude code" ||
    normalized === "claude cli" ||
    normalized === "claude session" ||
    normalized === "codex" ||
    normalized === "codex cli" ||
    normalized === "codex session" ||
    normalized === "opencode worker" ||
    normalized === "claude worker" ||
    normalized === "codex worker"
  ) {
    return true;
  }
  if (
    (session.toolType === "shell" || session.toolType == null)
    && (normalized === "shell" || normalized === "terminal")
  ) {
    return true;
  }
  return false;
}

export function primarySessionLabel(session: TerminalSessionSummary): string {
  const title = preferredSessionLabel(session.title);
  if (title && !isGenericSessionTitle(session, title)) return title;

  const goal = preferredSessionLabel(session.goal);
  if (goal) return goal;

  const summary = preferredSessionLabel(session.summary);
  if (summary) return summary;

  return defaultSessionLabel(session.toolType);
}

export function secondarySessionLabel(session: TerminalSessionSummary): string {
  const primary = primarySessionLabel(session);
  const summary = preferredSessionLabel(session.summary);
  if (summary && summary !== primary) return summary;

  const goal = preferredSessionLabel(session.goal);
  if (goal && goal !== primary) return goal;

  return "";
}

export function truncateSessionLabel(text: string, max = 24): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}
