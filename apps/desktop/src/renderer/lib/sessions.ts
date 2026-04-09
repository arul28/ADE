/** Shared session/terminal utilities for the renderer. */

import type { AgentChatProvider, AgentChatSession, TerminalSessionSummary, TerminalToolType } from "../../shared/types";

/** Returns true if the tool type represents an AI chat session. */
export function isChatToolType(toolType: string | null | undefined): boolean {
  return (
    toolType === "codex-chat"
    || toolType === "claude-chat"
    || toolType === "opencode-chat"
    || toolType === "cursor"
  );
}

export function chatToolTypeForProvider(provider: AgentChatProvider | string | null | undefined): TerminalToolType {
  switch (provider) {
    case "claude": return "claude-chat";
    case "codex": return "codex-chat";
    case "cursor": return "cursor";
    default: return "opencode-chat";
  }
}

export function isRunOwnedToolType(toolType: string | null | undefined): boolean {
  return toolType === "run-shell";
}

export function isRunOwnedSession(session: Pick<TerminalSessionSummary, "toolType">): boolean {
  return isRunOwnedToolType(session.toolType);
}

export function defaultSessionLabel(toolType: string | null | undefined): string {
  if (toolType === "shell" || toolType == null) return "Workspace";
  if (toolType === "run-shell") return "Run inspector";
  if (toolType === "claude-orchestrated") return "Claude worker";
  if (toolType === "codex-orchestrated") return "Codex worker";
  if (toolType === "opencode-orchestrated") return "OpenCode worker";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "opencode-chat") return "OpenCode chat";
  if (toolType === "cursor") return "Cursor chat";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
  return "Session";
}

export function buildOptimisticChatSessionSummary(args: {
  session: Pick<AgentChatSession, "id" | "laneId" | "provider" | "status" | "createdAt" | "lastActivityAt" | "idleSinceAt">;
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
    summary: null,
    runtimeState: isEnded ? "exited" : args.session.status === "active" ? "running" : "idle",
    resumeCommand: null,
    chatIdleSinceAt: args.session.status === "idle" ? args.session.idleSinceAt ?? null : null,
  };
}

export function formatToolTypeLabel(toolType: string | null | undefined): string {
  if (toolType === "claude-orchestrated") return "Claude worker runtime";
  if (toolType === "codex-orchestrated") return "Codex worker runtime";
  if (toolType === "opencode-orchestrated") return "OpenCode worker runtime";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "opencode-chat") return "OpenCode chat";
  if (toolType === "cursor") return "Cursor chat";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
  if (toolType === "run-shell") return "Run inspector";
  if (toolType === "shell") return "Terminal session";
  return toolType ? toolType.replace(/-/g, " ") : "Unknown";
}

/* ── Session label helpers ──
 * Shared logic for deriving human-readable labels from session metadata.
 * Used by SessionCard, WorkViewArea, and LaneTerminalsPanel.
 */

export function normalizeSessionLabel(raw: string | null | undefined): string | null {
  const normalized = String(raw ?? "").replace(/\s+/g, " ").trim();
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
  if (session.toolType === "run-shell" && (normalized === "run inspector" || normalized === "inspector")) {
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
