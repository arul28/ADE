import type { SessionSettleOverride, TerminalRuntimeState, TerminalSessionStatus, TerminalSessionSummary, TerminalToolType } from "../../shared/types";
import {
  canonicalSessionState,
  canonicalStatusBucket,
  isSessionFiledAsSnoozed,
  type CanonicalSessionState,
  type SessionBadge,
} from "../../shared/sessionCanonicalState";
import {
  sessionStatusPresentation,
  SESSION_TONE_DOT_CLASS,
  type SessionStatusOverlay,
  type SessionStatusPresentation,
} from "../../shared/sessionStatusPresentation";
import type { CanonicalSessionPhase } from "../../shared/sessionCanonicalState";
import { isChatToolType } from "./sessions";

export type TerminalRunIndicatorState = "none" | "running-active" | "running-needs-attention";
export type SessionStatusFilter = "all" | "running" | "awaiting-input" | "ended" | "settled";
export type SessionStatusBucket = Exclude<SessionStatusFilter, "all">;
export type SessionFilingBucket = SessionStatusBucket | "snoozed";

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

/**
 * Rule characters repeated as a separator — `----`, `====`, `━━━━`, a markdown
 * `---`, a banner of `####`. Agents and CLIs emit these constantly.
 *
 * Verbatim, a run like this fills a sidebar row edge to edge and renders as a
 * horizontal line struck through the card, which reads as a broken layout
 * rather than as text. Collapsing each run to a single character keeps the
 * preview honest (the separator WAS there) without letting it draw furniture.
 *
 * Deliberately not a blanket "collapse any repeated character": real output
 * legitimately contains `...`, `!!!`, and `???`, and flattening those would
 * change the tone of a message rather than just its geometry.
 */
const RULE_RUN_REGEX = /([-=_~*#—–─-╿])\1{3,}/g;

function collapseRuleRuns(raw: string): string {
  return raw.replace(RULE_RUN_REGEX, "$1");
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
  const normalized = normalizeInlineWhitespace(collapseRuleRuns(stripped));
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
  attentionSource?: TerminalSessionSummary["attentionSource"];
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
    attentionSource: session.attentionSource,
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
    attentionSource: session.attentionSource ?? null,
    lastOutputPreview: session.lastOutputPreview,
    lastActivityAt: session.lastActivityAt ?? null,
    exitCode: session.exitCode ?? null,
    settledAt: session.settledAt ?? null,
    settleOverride: session.settleOverride ?? null,
    attentionRequestedAt: session.attentionRequestedAt ?? null,
    lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    nowMs: session.nowMs,
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

/**
 * The row's single status label — `{ label, tone, glyph }` from the shared
 * presentation module, with the snooze/woke overlays already applied.
 *
 * This is what the sidebar's status slot renders, and it replaces the old
 * scatter of capsule + inline label + dot + wake chip + woke chip, each of
 * which decided its own copy and color. Callers pass the overlay explicitly
 * because snooze lives outside the canonical phase by design — see
 * `sessionStatusPresentation`'s header for why the two stay orthogonal.
 */
export function sessionStatusDisplay(
  session: SessionCanonicalUiInput,
  overlay: SessionStatusOverlay = {},
): SessionStatusPresentation | null {
  return sessionStatusPresentation(sessionCanonicalUiState(session).phase, overlay);
}

/** Yellow Work tab border — agent chats blocked on approval/question/`ade chat ask` only. */
export function sessionNeedsChatTabHighlight(args: {
  runtimeState?: TerminalRuntimeState;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
  attentionSource?: TerminalSessionSummary["attentionSource"];
  attentionRequestedAt?: string | null;
}): boolean {
  if (!isChatToolType(args.toolType)) return false;
  if (args.pendingInputItemId) return true;
  if (args.attentionSource === "provider_structured") return true;
  if (args.attentionRequestedAt) return true;
  return false;
}

export function sessionStatusBucket(args: SessionCanonicalUiInput): SessionStatusBucket {
  return canonicalStatusBucket(sessionCanonicalUiState(args).phase);
}

/** Sidebar filing rule: canonical lifecycle plus the snooze visibility overlay. */
export function sessionFilingBucket(
  session: TerminalSessionSummary,
  nowMs: number = Date.now(),
): SessionFilingBucket {
  const input = canonicalInputFromSummary(session);
  const phase = sessionCanonicalUiState(input).phase;
  return isSessionFiledAsSnoozed(session, phase, nowMs)
    ? "snoozed"
    : canonicalStatusBucket(phase);
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
 * The compact status dot, for surfaces too dense for a word (the `compact` row
 * variant, lane rollups).
 *
 * Derived from `sessionStatusPresentation` rather than switching on the phase
 * itself, so the dot and the label physically cannot disagree. They used to:
 * a stale session rendered a GREEN dot labelled "Running" while a separate
 * capsule on the same row said "Stale" — the dot was asserting work was
 * happening at the exact moment the row was explaining that none was. Anything
 * that needs a color for a session state must come through here or through the
 * presentation module; no third mapping.
 *
 * Settled keeps its hollow ring, which reads as visually "less than" every
 * filled dot and matches its position as the quietest tier.
 */
export function sessionStatusDot(
  session: SessionCanonicalUiInput,
  overlay: SessionStatusOverlay = {},
): SessionStatusDot {
  const phase = sessionCanonicalUiState(session).phase;
  if (phase === "settled") {
    return {
      cls: "rounded-full border border-white/35 bg-transparent",
      spinning: false,
      label: "Settled",
    };
  }
  const presentation = sessionStatusPresentation(phase, overlay);
  if (presentation) {
    return {
      cls: `rounded-full ${SESSION_TONE_DOT_CLASS[presentation.tone]}`,
      spinning: false,
      label: presentation.label,
    };
  }
  return legacySessionStatusDot(phase);
}

/**
 * Fallback for a phase with no presentation entry.
 *
 * Currently unreachable — `PHASE_PRESENTATION` is a `Record` over the full
 * `CanonicalSessionPhase` union, so TypeScript already guarantees every phase
 * resolves (only `settled` returns null, handled above). It exists so a phase
 * added to the union later degrades to a visible dot instead of rendering
 * nothing.
 *
 * Deliberately NEUTRAL rather than reproducing the old per-phase colours: an
 * unknown state has, by definition, not earned a hue. The previous version of
 * this fallback still mapped `ready`/`idle` to amber, which would have quietly
 * reintroduced the exact second meaning for amber that this redesign removed.
 */
function legacySessionStatusDot(phase: CanonicalSessionPhase): SessionStatusDot {
  return {
    cls: `rounded-full ${SESSION_TONE_DOT_CLASS.neutral}`,
    spinning: false,
    label: phase,
  };
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
