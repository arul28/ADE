import type { TerminalRuntimeState, TerminalSessionStatus, TerminalSessionSummary, TerminalToolType } from "../../shared/types";
import { canonicalSessionState, type SessionBadge } from "../../shared/sessionCanonicalState";
import { isChatToolType } from "./sessions";

export type TerminalRunIndicatorState = "none" | "running-active" | "running-needs-attention";
export type SessionStatusFilter = "all" | "running" | "awaiting-input" | "ended";
export type SessionUiState = "running-active" | "running-needs-attention" | "ended";
export type SessionStatusBucket = Exclude<SessionStatusFilter, "all">;

export type LaneTerminalAttentionSummary = {
  runningCount: number;
  activeCount: number;
  needsAttentionCount: number;
  indicator: TerminalRunIndicatorState;
};

export type TerminalAttentionSummary = {
  runningCount: number;
  activeCount: number;
  needsAttentionCount: number;
  indicator: TerminalRunIndicatorState;
  byLaneId: Record<string, LaneTerminalAttentionSummary>;
};

const OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const APC_REGEX = /\u001b_[\s\S]*?(?:\u0007|\u001b\\)/g;
const DCS_REGEX = /\u001bP[\s\S]*?(?:\u0007|\u001b\\)/g;
const PM_REGEX = /\u001b\^[\s\S]*?(?:\u0007|\u001b\\)/g;
const CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CHARSET_REGEX = /\u001b[\(\)][0-9A-Za-z]/g;
const TWO_CHAR_ESC_REGEX = /\u001b(?:[@-Z\\-_]|[0-9=>])/g;

const NEEDS_INPUT_PATTERNS: RegExp[] = [
  /\b(?:waiting|awaiting)\b.{0,28}\b(?:input|confirmation|response|prompt)\b/i,
  /\b(?:press|hit)\b.{0,14}\b(?:enter|return|any key)\b/i,
  /\b(?:select|choose|pick)\b.{0,28}\b(?:option|number|profile|item)\b/i,
  /\b(?:confirm|continue|proceed|retry)\b.{0,24}\?/i,
  /\((?:y\/n|yes\/no)\)/i,
  /\[(?:y\/n|yes\/no)\]/i,
  /\b(?:enter|type)\b.{0,24}:\s*$/i,
  // Claude Code tool-approval / plan-mode prompts: "(Y)es / (N)o", "(Y)es, (N)o, (A)lways"
  /\([Yy]\)\w*\s*.{0,12}\([Nn]\)\w*/,
  /\ballow\b.{0,40}\?\s/i,
];

const IDLE_ATTENTION_TOOL_TYPES = new Set<TerminalToolType>([
  "claude",
  "codex",
  "cursor-cli",
  "droid",
  "opencode",
  "claude-orchestrated",
  "codex-orchestrated",
  "opencode-orchestrated",
  "aider",
  "continue",
]);

function idleRuntimeNeedsAttention(toolType?: TerminalToolType | null): boolean {
  if (isChatToolType(toolType)) return true;
  return Boolean(toolType && IDLE_ATTENTION_TOOL_TYPES.has(toolType));
}

function normalizeInlineWhitespace(raw: string): string {
  if (!raw) return "";
  return raw.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeTerminalInlineText(raw: string | null | undefined, maxChars = 220): string {
  if (!raw) return "";
  const stripped = raw
    .replace(OSC_REGEX, "")
    .replace(APC_REGEX, "")
    .replace(DCS_REGEX, "")
    .replace(PM_REGEX, "")
    .replace(CSI_REGEX, "")
    .replace(CHARSET_REGEX, "")
    .replace(TWO_CHAR_ESC_REGEX, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const normalized = normalizeInlineWhitespace(stripped);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function runningSessionNeedsAttention(preview: string | null | undefined): boolean {
  const text = sanitizeTerminalInlineText(preview, 280);
  if (!text) return false;
  return NEEDS_INPUT_PATTERNS.some((pattern) => pattern.test(text));
}

function indicatorFromCounts(runningCount: number, needsAttentionCount: number): TerminalRunIndicatorState {
  if (runningCount <= 0) return "none";
  if (needsAttentionCount > 0) return "running-needs-attention";
  return "running-active";
}

export function sessionIndicatorState(args: {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
}): SessionUiState {
  if (args.status === "detached") return "ended";
  if (args.status === "running") {
    // Deterministic signals first (pendingInputItemId now counts — it used to
    // be invisible here); the preview-text heuristic is consulted LAST and can
    // only upgrade a plain running session, never outvote runtime state.
    if (args.pendingInputItemId || args.runtimeState === "waiting-input") return "running-needs-attention";
    if (args.runtimeState === "idle") {
      return idleRuntimeNeedsAttention(args.toolType) ? "running-needs-attention" : "running-active";
    }
    return runningSessionNeedsAttention(args.lastOutputPreview) ? "running-needs-attention" : "running-active";
  }
  // Agent chats do not "end" like PTY sessions — they idle until deleted.
  if (isChatToolType(args.toolType)) return "running-needs-attention";
  return "ended";
}

/**
 * The one-word attention capsule for a session row (desktop SessionCard; iOS
 * mirrors the vocabulary). Null for every calm state — rows must not shift
 * layout when no capsule renders. Backed by the shared canonical state module
 * so the capsule, the Live Activity phase, and notifications always agree.
 */
export function sessionCapsuleBadge(session: {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
  lastActivityAt?: string | null;
  exitCode?: number | null;
  nowMs?: number;
}): SessionBadge | null {
  return canonicalSessionState({
    status: session.status,
    runtimeState: session.runtimeState ?? null,
    toolType: session.toolType ?? null,
    pendingInputItemId: session.pendingInputItemId ?? null,
    lastOutputPreview: session.lastOutputPreview,
    lastActivityAt: session.lastActivityAt ?? null,
    exitCode: session.exitCode ?? null,
    nowMs: session.nowMs,
    previewSuggestsNeedsInput: runningSessionNeedsAttention,
    isChatTool: isChatToolType,
  }).badge;
}

export function sessionNeedsUserInput(args: {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
}): boolean {
  if (args.runtimeState === "waiting-input") return true;
  if (args.pendingInputItemId) return true;
  if (isChatToolType(args.toolType)) return false;
  if (args.status !== "running") return false;
  return runningSessionNeedsAttention(args.lastOutputPreview);
}

/** Yellow Work tab border — agent chats blocked on approval/question only. */
export function sessionNeedsChatTabHighlight(args: {
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
}): boolean {
  if (!isChatToolType(args.toolType)) return false;
  if (args.runtimeState === "waiting-input") return true;
  if (args.pendingInputItemId) return true;
  return false;
}

export function sessionStatusBucket(args: {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
}): SessionStatusBucket {
  const state = sessionIndicatorState(args);
  if (state === "running-active") return "running";
  if (state === "running-needs-attention") return "awaiting-input";
  return "ended";
}

export function sessionMatchesStatusFilter(
  args: {
    status: TerminalSessionStatus;
    lastOutputPreview: string | null;
    runtimeState?: TerminalRuntimeState;
    toolType?: TerminalToolType | null;
    pendingInputItemId?: string | null;
  },
  filter: SessionStatusFilter,
): boolean {
  if (filter === "all") return true;
  return sessionStatusBucket(args) === filter;
}

export type SessionStatusDot = {
  cls: string;
  spinning: boolean;
  label: string;
};

/** Map a session's indicator state to CSS classes for rendering a status dot. */
export function sessionStatusDot(session: {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
}): SessionStatusDot {
  const indicator = sessionIndicatorState(session);
  if (indicator === "running-active") {
    return { cls: "rounded-full bg-emerald-400", spinning: false, label: "Running" };
  }
  if (indicator === "running-needs-attention") {
    let label: string;
    if (session.runtimeState === "waiting-input") {
      label = "Awaiting input";
    } else if (isChatToolType(session.toolType)) {
      label = "Ready";
    } else if (session.runtimeState === "idle") {
      label = "Idle";
    } else {
      label = "Awaiting input";
    }
    return { cls: "rounded-full bg-amber-300", spinning: false, label };
  }
  return { cls: "rounded-full bg-red-400", spinning: false, label: "Ended" };
}

export function summarizeTerminalAttention(sessions: TerminalSessionSummary[]): TerminalAttentionSummary {
  let runningCount = 0;
  let activeCount = 0;
  let needsAttentionCount = 0;
  const byLane: Record<string, { runningCount: number; activeCount: number; needsAttentionCount: number }> = {};

  for (const session of sessions) {
    const indicator = sessionIndicatorState({
      status: session.status,
      lastOutputPreview: session.lastOutputPreview,
      runtimeState: session.runtimeState,
      toolType: session.toolType,
    });
    if (indicator === "ended") continue;
    const lane = byLane[session.laneId] ?? { runningCount: 0, activeCount: 0, needsAttentionCount: 0 };
    lane.runningCount += 1;
    runningCount += 1;
    if (indicator === "running-needs-attention") {
      lane.needsAttentionCount += 1;
      needsAttentionCount += 1;
    } else {
      lane.activeCount += 1;
      activeCount += 1;
    }
    byLane[session.laneId] = lane;
  }

  const byLaneId: Record<string, LaneTerminalAttentionSummary> = {};
  for (const [laneId, lane] of Object.entries(byLane)) {
    byLaneId[laneId] = {
      ...lane,
      indicator: indicatorFromCounts(lane.runningCount, lane.needsAttentionCount)
    };
  }

  return {
    runningCount,
    activeCount,
    needsAttentionCount,
    indicator: indicatorFromCounts(runningCount, needsAttentionCount),
    byLaneId
  };
}
