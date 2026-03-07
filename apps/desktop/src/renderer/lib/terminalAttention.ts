import type { TerminalRuntimeState, TerminalSessionStatus, TerminalSessionSummary } from "../../shared/types";

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
const CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CHARSET_REGEX = /\u001b[\(\)][0-9A-Za-z]/g;
const TWO_CHAR_ESC_REGEX = /\u001b[@-Z\\-_]/g;

const NEEDS_INPUT_PATTERNS: RegExp[] = [
  /\b(?:waiting|awaiting)\b.{0,28}\b(?:input|confirmation|response|prompt)\b/i,
  /\b(?:press|hit)\b.{0,14}\b(?:enter|return|any key)\b/i,
  /\b(?:select|choose|pick)\b.{0,28}\b(?:option|number|profile|item)\b/i,
  /\b(?:confirm|continue|proceed|retry)\b.{0,24}\?/i,
  /\((?:y\/n|yes\/no)\)/i,
  /\[(?:y\/n|yes\/no)\]/i,
  /\b(?:enter|type)\b.{0,24}:\s*$/i,
];

function normalizeInlineWhitespace(raw: string): string {
  if (!raw) return "";
  return raw.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeTerminalInlineText(raw: string | null | undefined, maxChars = 220): string {
  if (!raw) return "";
  const stripped = raw
    .replace(OSC_REGEX, "")
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
}): SessionUiState {
  if (args.status === "running") {
    if (args.runtimeState === "waiting-input") return "running-needs-attention";
    return runningSessionNeedsAttention(args.lastOutputPreview) ? "running-needs-attention" : "running-active";
  }
  return "ended";
}

export function sessionStatusBucket(args: {
  status: TerminalSessionStatus;
  lastOutputPreview: string | null;
  runtimeState?: TerminalRuntimeState;
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
}): SessionStatusDot {
  const indicator = sessionIndicatorState(session);
  if (indicator === "running-active") {
    return { cls: "border-2 border-emerald-400 border-t-transparent bg-transparent", spinning: true, label: "Running" };
  }
  if (indicator === "running-needs-attention") {
    return { cls: "border-2 border-amber-300 border-t-transparent bg-transparent", spinning: true, label: "Awaiting input" };
  }
  return { cls: "bg-red-400", spinning: false, label: "Ended" };
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
