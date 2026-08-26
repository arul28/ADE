/**
 * The small pure helpers the desktop Work row depends on that are trapped
 * inside `.tsx` files, plus the projection that lets a TUI chat summary be read
 * by the shared session modules.
 *
 * Everything importable was imported (see `workListModel.ts`): the canonical
 * state machine, the presentation vocabulary, the filing rule, the lane
 * ordering and the label/relative-time helpers all come straight from
 * `apps/desktop/src/**` because they are React-free. Only the two functions
 * below could not be — they live in JSX modules that pull in framer-motion,
 * Phosphor icons and the renderer store.
 *
 * Both are COPIES with attribution. If the desktop version changes, this one
 * must change with it: they are the reason a TUI row and a desktop row read the
 * same words in the same order.
 */

import type {
  TerminalSessionSummary,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalToolType,
} from "../../../desktop/src/shared/types/sessions";
import { CHAT_TOOL_TYPE_BY_PROVIDER, preferredSessionLabel } from "../../../desktop/src/renderer/lib/sessions";
import type { KnownChatProvider } from "../../../desktop/src/renderer/lib/sessions";
import { sanitizeTerminalInlineText, sessionFilingBucket } from "../../../desktop/src/renderer/lib/terminalAttention";
import type { TuiChatSessionSummary } from "./adeApi";

// ---------------------------------------------------------------------------
// Copied from apps/desktop/src/renderer/components/terminals/SessionCard.tsx
// (`SessionPreviewLine` / `getPreviewLine`, :175-211).
// ---------------------------------------------------------------------------

export type SessionPreviewLine = {
  text: string;
  /** Desktop linkifies `#123` / `ABC-12` in these; the TUI keeps the flag for parity. */
  linkify: boolean;
  source: "ask" | "note" | "output" | "summary" | "goal";
};

/**
 * The row's second line, highest priority first:
 *   1. an escalated ask (`ade chat ask`) while attention is still requested,
 *   2. the agent-authored status note — prefixed "done: " once settled, because
 *      in the settled tail the note IS the outcome,
 *   3. the last output preview, then the summary, then the goal — each skipped
 *      when it merely repeats the title the row already shows.
 * Every candidate is sanitized to 120 characters, which is also what stops a
 * CLI's escape soup from reaching the pane.
 */
export function getPreviewLine(
  session: TerminalSessionSummary,
  primaryText: string,
  settled: boolean,
): SessionPreviewLine | null {
  if (session.attentionRequestedAt) {
    const ask = sanitizeTerminalInlineText(session.attentionMessage, 120);
    if (ask) return { text: ask, linkify: true, source: "ask" };
  }
  const note = sanitizeTerminalInlineText(session.statusNote, 120);
  if (note) {
    return {
      text: settled ? `done: ${note}` : note,
      linkify: true,
      source: "note",
    };
  }
  const output = sanitizeTerminalInlineText(session.lastOutputPreview, 120);
  if (output && output !== primaryText) {
    return { text: output, linkify: false, source: "output" };
  }
  const summary = preferredSessionLabel(session.summary);
  if (summary && summary !== primaryText) {
    return { text: summary, linkify: false, source: "summary" };
  }
  const goal = preferredSessionLabel(session.goal);
  if (goal && goal !== primaryText) {
    return { text: goal, linkify: false, source: "goal" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Copied from apps/desktop/src/renderer/components/terminals/SessionListPane.tsx
// (`partitionQuietSessions`, :263-284). `nowMs` is a parameter here so the
// partition is testable without freezing the clock.
// ---------------------------------------------------------------------------

export type QuietPartition<T> = {
  active: T[];
  snoozed: T[];
  settled: T[];
};

export function partitionQuietSessions<T extends TerminalSessionSummary>(
  sessions: readonly T[],
  nowMs: number = Date.now(),
): QuietPartition<T> {
  const active: T[] = [];
  const snoozed: T[] = [];
  const settled: T[] = [];
  for (const session of sessions) {
    const bucket = sessionFilingBucket(session, nowMs);
    if (bucket === "snoozed") {
      snoozed.push(session);
    } else if (bucket === "settled") {
      settled.push(session);
    } else {
      active.push(session);
    }
  }
  return { active, snoozed, settled };
}

// ---------------------------------------------------------------------------
// TUI ↔ desktop projection
// ---------------------------------------------------------------------------

const CHAT_STATUS_TO_SESSION_STATUS: Record<string, TerminalSessionStatus> = {
  active: "running",
  idle: "running",
  ended: "completed",
};

/**
 * Runtime state fallback for a chat with no `session.list` row yet. Deliberately
 * conservative: a chat blocked on input reads `waiting-input` so the canonical
 * state machine can raise its hand, an ended chat reads `exited`, and anything
 * else reads `idle` rather than claiming a live turn we cannot see.
 */
function fallbackRuntimeState(session: TuiChatSessionSummary): TerminalRuntimeState {
  if (session.awaitingInput || session.pendingInputItemId) return "waiting-input";
  if (session.status === "ended" || session.endedAt) return "exited";
  return session.status === "active" ? "running" : "idle";
}

/**
 * Reads the desktop's canonical provider → tool-type table rather than
 * restating it, so a seventh provider cannot land there and leave a TUI row
 * with no tool type. The one deliberate difference from
 * `chatToolTypeForProvider` is the unknown case: the desktop falls back to
 * `opencode-chat`, while a TUI row with an unrecognised provider stays null so
 * the caller's other sources get a chance before we guess.
 */
function fallbackToolType(provider: string | null | undefined): TerminalToolType | null {
  if (typeof provider !== "string") return null;
  // `Object.hasOwn`, not a plain lookup: the provider is runtime input, so
  // "constructor" must miss rather than resolve to an Object.prototype member.
  if (!Object.hasOwn(CHAT_TOOL_TYPE_BY_PROVIDER, provider)) return null;
  return CHAT_TOOL_TYPE_BY_PROVIDER[provider as KnownChatProvider];
}

/**
 * Project a TUI chat row onto the `TerminalSessionSummary` shape every shared
 * session module speaks. The enriched `workSummary` is authoritative when the
 * runtime handed one over; the chat summary fills the gaps (and is the only
 * source for a chat the runtime has not projected yet).
 *
 * This is the single adapter: no other module may hand-roll a partial summary,
 * or the canonical phase computed here and the phase computed there will
 * disagree on exactly the rows that matter.
 */
export function toWorkSessionSummary(
  session: TuiChatSessionSummary,
  laneName: string | null = null,
): TerminalSessionSummary {
  const summary = session.workSummary;
  const toolType = session.toolType ?? summary?.toolType ?? fallbackToolType(session.provider);
  return {
    id: session.sessionId,
    laneId: session.laneId,
    laneName: session.laneName ?? summary?.laneName ?? laneName ?? "",
    ptyId: summary?.ptyId ?? null,
    tracked: summary?.tracked ?? false,
    pinned: session.pinned ?? summary?.pinned ?? false,
    goal: session.goal ?? summary?.goal ?? null,
    toolType,
    title: summary?.title ?? session.title ?? "",
    status: summary?.status ?? CHAT_STATUS_TO_SESSION_STATUS[session.status] ?? "running",
    startedAt: session.startedAt ?? summary?.startedAt ?? "",
    endedAt: session.endedAt ?? summary?.endedAt ?? null,
    archivedAt: session.archivedAt ?? summary?.archivedAt ?? null,
    exitCode: session.exitCode ?? summary?.exitCode ?? null,
    transcriptPath: summary?.transcriptPath ?? "",
    headShaStart: summary?.headShaStart ?? null,
    headShaEnd: summary?.headShaEnd ?? null,
    lastOutputPreview: session.lastOutputPreview ?? summary?.lastOutputPreview ?? null,
    lastActivityAt: session.lastActivityAt ?? summary?.lastActivityAt ?? null,
    currentTurnStartedAt: session.currentTurnStartedAt ?? summary?.currentTurnStartedAt ?? null,
    summary: session.summary ?? summary?.summary ?? null,
    runtimeState: session.runtimeState ?? summary?.runtimeState ?? fallbackRuntimeState(session),
    pendingInputItemId: session.pendingInputItemId ?? summary?.pendingInputItemId ?? null,
    settledAt: session.settledAt ?? null,
    statusNote: session.statusNote ?? null,
    attentionRequestedAt: session.attentionRequestedAt ?? null,
    attentionMessage: session.attentionMessage ?? null,
    attentionSource: session.attentionSource ?? null,
    lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    settleOverride: session.settleOverride ?? null,
    snoozedUntil: session.snoozedUntil ?? null,
    snoozedAt: session.snoozedAt ?? null,
    wokeAt: session.wokeAt ?? null,
    wokeReason: session.wokeReason ?? null,
    resumeCommand: summary?.resumeCommand ?? null,
    nextWakeAt: session.nextWakeAt ?? summary?.nextWakeAt ?? null,
    chatActivityMode: session.chatActivityMode ?? summary?.chatActivityMode ?? null,
    activeBackgroundTaskCount: session.activeBackgroundTaskCount ?? summary?.activeBackgroundTaskCount,
    backgroundWork: session.backgroundWork ?? summary?.backgroundWork,
    backgroundWorkSince: session.backgroundWorkSince ?? summary?.backgroundWorkSince ?? null,
    claudeTag: session.claudeTag ?? summary?.claudeTag ?? null,
    chatSessionId: summary?.chatSessionId ?? session.sessionId,
    spawnKind: session.spawnKind ?? summary?.spawnKind,
  };
}
