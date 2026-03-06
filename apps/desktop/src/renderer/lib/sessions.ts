/** Shared session/terminal utilities for the renderer. */

import type { TerminalSessionSummary } from "../../shared/types";

/** Returns true if the tool type represents an AI chat session. */
export function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

export function defaultSessionLabel(toolType: string | null | undefined): string {
  if (toolType === "shell" || toolType == null) return "Workspace";
  if (toolType === "claude-orchestrated") return "Claude worker";
  if (toolType === "codex-orchestrated") return "Codex worker";
  if (toolType === "ai-orchestrated") return "AI worker";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "ai-chat") return "AI chat";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
  return "Session";
}

export function formatToolTypeLabel(toolType: string | null | undefined): string {
  if (toolType === "claude-orchestrated") return "Claude worker runtime";
  if (toolType === "codex-orchestrated") return "Codex worker runtime";
  if (toolType === "ai-orchestrated") return "AI worker runtime";
  if (toolType === "claude-chat") return "Claude chat";
  if (toolType === "codex-chat") return "Codex chat";
  if (toolType === "ai-chat") return "AI chat";
  if (toolType === "claude") return "Claude session";
  if (toolType === "codex") return "Codex session";
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

export function isLowSignalSessionLabel(raw: string | null | undefined): boolean {
  const normalized = normalizeSessionLabel(raw);
  if (!normalized) return false;

  const collapsed = normalized
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();

  if (!collapsed.length) return true;
  if (collapsed.includes("ai apicallerror")) return true;
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
  return normalized;
}

export function isGenericSessionTitle(session: TerminalSessionSummary, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return true;
  if (
    normalized === "ai chat" ||
    normalized === "claude chat" ||
    normalized === "codex chat" ||
    normalized === "ai worker" ||
    normalized === "claude worker" ||
    normalized === "codex worker"
  ) {
    return true;
  }
  if ((session.toolType === "shell" || session.toolType == null) && (normalized === "shell" || normalized === "terminal")) {
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
