import type { SessionSettleOverride, TerminalRuntimeState, TerminalSessionStatus, TerminalSessionSummary, TerminalToolType } from "../../shared/types";
import {
  canonicalSessionState,
  canonicalStatusBucket,
  type CanonicalSessionPhase,
  type CanonicalSessionState,
  type SessionBadge,
} from "../../shared/sessionCanonicalState";
import { isChatToolType } from "./sessions";

export type TerminalRunIndicatorState = "none" | "running-active" | "running-needs-attention";
export type SessionStatusFilter = "all" | "running" | "awaiting-input" | "ended" | "settled";
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

type SessionCanonicalUiInput = {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
  lastActivityAt?: string | null;
  exitCode?: number | null;
  settledAt?: string | null;
  settleOverride?: SessionSettleOverride | null;
  attentionRequestedAt?: string | null;
  lastTurnFailedAt?: string | null;
  nowMs?: number;
};

/**
 * Project a session summary onto the canonical-state input — the ONE place
 * that knows which summary fields feed the state machine, so call sites can't
 * drift as fields are added.
 */
export function canonicalInputFromSummary(session: TerminalSessionSummary): SessionCanonicalUiInput {
  return {
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
    toolType: session.toolType,
    pendingInputItemId: session.pendingInputItemId,
    lastActivityAt: session.lastActivityAt,
    exitCode: session.exitCode,
    settledAt: session.settledAt,
    settleOverride: session.settleOverride,
    attentionRequestedAt: session.attentionRequestedAt,
    lastTurnFailedAt: session.lastTurnFailedAt,
  };
}

export function sessionCanonicalUiState(session: SessionCanonicalUiInput): CanonicalSessionState {
  return canonicalSessionState({
    status: session.status,
    runtimeState: session.runtimeState ?? null,
    toolType: session.toolType ?? null,
    pendingInputItemId: session.pendingInputItemId ?? null,
    lastOutputPreview: session.lastOutputPreview,
    lastActivityAt: session.lastActivityAt ?? null,
    exitCode: session.exitCode ?? null,
    settledAt: session.settledAt ?? null,
    settleOverride: session.settleOverride ?? null,
    attentionRequestedAt: session.attentionRequestedAt ?? null,
    lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    nowMs: session.nowMs,
    previewSuggestsNeedsInput: runningSessionNeedsAttention,
    isChatTool: isChatToolType,
  });
}

/**
 * The one-word attention capsule for a session row (desktop SessionCard; iOS
 * mirrors the vocabulary). Null for every calm state — rows must not shift
 * layout when no capsule renders. Backed by the shared canonical state module
 * so the capsule, the Live Activity phase, and notifications always agree.
 */
export function sessionCapsuleBadge(session: SessionCanonicalUiInput): SessionBadge | null {
  return sessionCanonicalUiState(session).badge;
}

export function sessionInlineStatusLabel(session: SessionCanonicalUiInput): string | null {
  const state = sessionCanonicalUiState(session);
  if (state.phase === "stopped") return "Stopped";
  return null;
}

export function sessionNeedsUserInput(args: {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
  attentionRequestedAt?: string | null;
}): boolean {
  if (args.runtimeState === "waiting-input") return true;
  if (args.pendingInputItemId) return true;
  if (args.attentionRequestedAt) return true;
  if (isChatToolType(args.toolType)) return false;
  if (args.status !== "running") return false;
  return runningSessionNeedsAttention(args.lastOutputPreview);
}

/** Yellow Work tab border — agent chats blocked on approval/question/`ade chat ask` only. */
export function sessionNeedsChatTabHighlight(args: {
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
  attentionRequestedAt?: string | null;
}): boolean {
  if (!isChatToolType(args.toolType)) return false;
  if (args.runtimeState === "waiting-input") return true;
  if (args.pendingInputItemId) return true;
  if (args.attentionRequestedAt) return true;
  return false;
}

export function sessionStatusBucket(args: SessionCanonicalUiInput): SessionStatusBucket {
  return canonicalStatusBucket(sessionCanonicalUiState(args).phase);
}

export function sessionMatchesStatusFilter(
  args: SessionCanonicalUiInput,
  filter: SessionStatusFilter,
): boolean {
  if (filter === "all") return true;
  return sessionStatusBucket(args) === filter;
}

/** Loud tier only: rows that must interrupt (badge, notification, dock/tab count). */
export function sessionNeedsYou(args: SessionCanonicalUiInput): boolean {
  return sessionCanonicalUiState(args).phase === "needs_you";
}

export type SessionStatusDot = {
  cls: string;
  spinning: boolean;
  label: string;
};

/**
 * Map a session's canonical phase to CSS classes for rendering a status dot.
 * Green = work happening · amber = your move (loud or quiet) · red = died ·
 * hollow ring = settled (visually "less than" every filled dot, matching the
 * quietest tier).
 */
export function sessionStatusDot(session: SessionCanonicalUiInput): SessionStatusDot {
  const phase = sessionCanonicalUiState(session).phase;
  switch (phase) {
    case "starting":
    case "running":
    case "stale":
      return { cls: "rounded-full bg-emerald-400", spinning: false, label: "Running" };
    case "needs_you":
      return {
        cls: "rounded-full bg-amber-300",
        spinning: false,
        label: "Needs you",
      };
    case "ready":
      return { cls: "rounded-full bg-amber-300", spinning: false, label: "Ready" };
    case "idle":
      return idleRuntimeNeedsAttention(session.toolType)
        ? { cls: "rounded-full bg-amber-300", spinning: false, label: "Idle" }
        : { cls: "rounded-full bg-emerald-400", spinning: false, label: "Running" };
    case "settled":
      return {
        cls: "rounded-full border border-white/35 bg-transparent",
        spinning: false,
        label: "Settled",
      };
    case "stopped":
      return { cls: "rounded-full bg-red-400", spinning: false, label: "Stopped" };
    case "failed":
      return { cls: "rounded-full bg-red-400", spinning: false, label: "Failed" };
    default:
      return { cls: "rounded-full bg-red-400", spinning: false, label: "Ended" };
  }
}

/**
 * Rollup that feeds the Work tab indicator and dock badge. needsAttention is
 * the LOUD tier only (canonical needs_you) — a merely resting chat no longer
 * lights the tab amber; only a deterministic ask does.
 */
export function summarizeTerminalAttention(sessions: TerminalSessionSummary[]): TerminalAttentionSummary {
  let runningCount = 0;
  let activeCount = 0;
  let needsAttentionCount = 0;
  const byLane: Record<string, { runningCount: number; activeCount: number; needsAttentionCount: number }> = {};

  for (const session of sessions) {
    const phase = sessionCanonicalUiState(canonicalInputFromSummary(session)).phase;
    const isLoud = phase === "needs_you";
    const isWorking = phase === "starting" || phase === "running" || phase === "stale";
    if (!isLoud && !isWorking) continue;
    const lane = byLane[session.laneId] ?? { runningCount: 0, activeCount: 0, needsAttentionCount: 0 };
    lane.runningCount += 1;
    runningCount += 1;
    if (isLoud) {
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
