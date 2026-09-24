/**
 * Turn fold: once a chat turn has ended, the rows between its user message and
 * its answer collapse into ONE "Worked for 4m 12s · 18 tools" row, so a
 * finished turn reads user message → fold → answer → turn-end line.
 *
 * Pure and UI-free on purpose. Desktop feeds it grouped transcript rows (see
 * `deriveChatTranscriptTurnFolds` in the renderer's `chatTranscriptRows.ts`);
 * the TUI and iOS can describe their own rows with the same roles and get the
 * same folds. Presentation only: nothing here touches events, storage, sync, or
 * canonical text.
 *
 * Rules (owner-approved):
 * 1. Nothing folds while a turn is live. Only a turn with a `done` row folds.
 * 2. The ANSWER is the last text row of the turn — or the last `final_answer`
 *    row when the provider labelled one. `commentary` rows are never the answer.
 *    A turn with no answer (tool-only, interrupted before text, error) does not
 *    fold at all.
 * 3. The span is the rows strictly between the turn's user message and the
 *    answer. Rows after the answer never fold.
 * 4. Inside the span only HISTORY folds — including warning and info notices,
 *    which have nothing to act on. Rows that were still working or needing the
 *    user when the turn ended, actionable rows (errors, sign-in, continuity
 *    recovery, reset credit), finished subagent results, and proof stay
 *    visible below the fold row. A fold that would hide only trivial rows
 *    (status/diagnostics receipts, empty text) is not drawn.
 * 5. That decision is STICKY: liveness is read from a snapshot taken when the
 *    turn's `done` arrived ({@link snapshotTurnEnd}), so a card that settles
 *    later never jumps into the fold, and replaying the same events (a full
 *    reload) reproduces the same folds.
 */

import { isHostSleepNoticeEvent } from "./hostSleepNotice";
import { isLegacyProviderRetryNotice, type LegacyProviderRetryNotice } from "./providerRetryPresentation";
import { pluralCount } from "./formatting";

export { pluralCount } from "./formatting";

export type TurnFoldRowRole =
  /** A user message. Starts a new visual response; never folds. */
  | "boundary"
  /** The turn's `done` row. */
  | "turn_end"
  /** Assistant prose — the answer candidates. Non-answer text folds. */
  | "text"
  /** Finished work that folds: thoughts, plans, receipts, chips. */
  | "history"
  /** Always visible: errors, subagent results, proof, anything unknown. */
  | "keep"
  /** Visible only when it was still live at turn end. */
  | "keep_if_live";

export type TurnFoldTextPhase = "commentary" | "final_answer";

export type TurnEndStatus = "completed" | "interrupted" | "failed";

/** One row, described in the fold's vocabulary. */
export type TurnFoldRow = {
  key: string;
  role: TurnFoldRowRole;
  turnId: string | null;
  /** `text` rows only: the provider's narration/answer label, when it sent one. */
  phase?: TurnFoldTextPhase | null;
  /**
   * `keep_if_live` rows: the snapshot keys that decide this row's liveness.
   * A grouped row (an activity bundle, a background-job group) lists every row
   * it folded; any one live member keeps it visible. Defaults to `[key]`.
   */
  liveKeys?: readonly string[];
  /** `turn_end` rows: how the turn ended. */
  status?: TurnEndStatus;
  /**
   * `text` rows: the prose, when the surface can supply it. Only read to find
   * an earlier row that repeats the answer word for word
   * ({@link TurnFold.duplicateAnswerKeys}).
   */
  text?: string | null;
  /**
   * The row carries nothing a reader would open a fold for: a status or
   * diagnostics receipt, or a row with no content. A fold that would hide
   * only trivial rows is not drawn ({@link isTrivialTurnFoldEvent}).
   */
  trivial?: boolean;
};

/** What was true at the moment a turn's `done` arrived. */
export type TurnEndSnapshot = {
  /** Row keys that were still working or waiting on the user. */
  liveRowKeys: ReadonlySet<string>;
  /** Distinct subagents whose cards sat inside the turn. */
  subagentCount: number;
};

export type TurnFold = {
  /** Stable row key and disclosure id for the fold row. */
  foldId: string;
  turnId: string;
  turnEndKey: string;
  status: TurnEndStatus;
  answerKey: string;
  /** Index of the first span row; the fold row renders in its place. */
  spanStartIndex: number;
  answerIndex: number;
  /** Span rows hidden while the fold is closed. */
  hiddenKeys: ReadonlySet<string>;
  /** Span rows that stay visible under the fold row, in order. */
  keptKeys: readonly string[];
  subagentCount: number;
  /**
   * Earlier text rows of this turn whose trimmed prose is identical to the
   * answer's. A model that answers, calls a tool, then restates the same answer
   * (Grok on Cursor does) would otherwise show the answer twice in the open
   * fold. Hidden in the open fold too; a subset of `hiddenKeys`. Presentation
   * only: the canonical transcript keeps both.
   */
  duplicateAnswerKeys: ReadonlySet<string>;
};

type TurnFoldEventInput = { type: string };

type SystemNoticeProjection = {
  type: "system_notice";
  status?: string;
  noticeKind?: string;
  severity?: string;
  detail?: unknown;
  message?: string;
  hostSleep: boolean;
  legacyRetry: boolean;
};

/** A small discriminated view of the event fields turn folding actually reads. */
export type TurnFoldEventProjection =
  | { type: "user_message"; deliveryState?: string }
  | { type: "done" }
  | { type: "text" | "reasoning"; text?: string }
  | SystemNoticeProjection
  | { type: "ade_card"; variant?: string; state?: string }
  | { type: "background_job_line"; status?: string }
  | { type: "background_job_group" | "activity_bundle" }
  | { type: "approval_request" | "structured_question"; itemId?: string }
  | { type: "todo_update"; turnId?: string }
  | { type: "scheduled_work_update"; id?: string; status?: string }
  | { type: "subagent_started"; agentId?: string; taskId?: string }
  | { type: "subagent_spawn_anchor" | "subagent_result_card"; agentKey?: string }
  | { type: "task_list" }
  | { type: HistoryEventType }
  | { type: "unknown" };

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function turnFoldId(turnId: string): string {
  return `turn-fold:${turnId}`;
}

const HISTORY_EVENT_TYPE_LIST = [
  // Thinking and tool work. Tool groups are not drawn as rows on desktop, but
  // other surfaces draw them, and they are the most foldable thing there is.
  "reasoning",
  "work_log_group",
  "work_log_entry",
  "tool_call",
  "tool_result",
  "tool_use_summary",
  "command",
  "file_change",
  "web_search",
  "activity",
  "step_boundary",
  // A plan-mode proposal card (Codex). Desktop turns every other plan into
  // the chat's one `task_list` row, which is kept (see below).
  "plan",
  // Receipts and diagnostics the turn left behind. Desktop merges a turn's
  // diagnostics and recovery receipt into one `turn_details` row.
  "turn_details",
  "turn_diagnostics",
  "turn_recovery",
  "codex_turn_recovery",
  "codex_turn_stalled",
  "turn_health",
  "codex_safety_buffering",
  "codex_sleep",
  "auto_approval_review",
  "command_lifecycle",
  "conversation_reset",
  "prompt_suggestion",
  // Dividers and pills.
  "context_compact",
  "codex_context_compaction",
  "claude_goal_updated",
  "claude_goal_cleared",
  "codex_goal_updated",
  "codex_goal_cleared",
] as const;
type HistoryEventType = Exclude<typeof HISTORY_EVENT_TYPE_LIST[number], "reasoning">;
const HISTORY_EVENT_TYPES: ReadonlySet<string> = new Set(HISTORY_EVENT_TYPE_LIST);

/** Status and diagnostics receipts: a fold of only these hides nothing worth opening. */
const TRIVIAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "status",
  "activity",
  "step_boundary",
  "context_usage",
  "turn_details",
  "turn_diagnostics",
  "turn_health",
  "done",
]);

/**
 * True for a row a fold should not exist for on its own: a status or
 * diagnostics receipt, or prose/thought with no visible content. A fold whose
 * hidden rows are all trivial (an internal follow-up turn that left one status
 * row and a one-word answer) would read `Worked for …` over nothing, so the
 * turn does not fold and those rows draw as they are.
 */
function projectTurnFoldEvent(input: TurnFoldEventInput): TurnFoldEventProjection {
  const record = input as Record<string, unknown>;
  const string = (field: string) => readString(record, field);
  switch (input.type) {
    case "user_message":
      return { type: "user_message", deliveryState: string("deliveryState") };
    case "done":
      return { type: "done" };
    case "text":
    case "reasoning":
      return { type: input.type, text: string("text") };
    case "system_notice": {
      const message = string("message");
      const notice = {
        type: "system_notice" as const,
        status: string("status"),
        noticeKind: string("noticeKind"),
        severity: string("severity"),
        detail: record.detail,
        message,
        hostSleep: isHostSleepNoticeEvent({ type: input.type, status: string("status"), detail: record.detail }),
        legacyRetry: typeof message === "string" && isLegacyProviderRetryNotice(record as LegacyProviderRetryNotice),
      };
      return notice;
    }
    case "ade_card":
      return { type: "ade_card", variant: string("variant"), state: string("state") };
    case "background_job_line":
      return { type: "background_job_line", status: string("status") };
    case "background_job_group":
    case "activity_bundle":
      return { type: input.type };
    case "approval_request":
    case "structured_question":
      return { type: input.type, itemId: string("itemId") };
    case "todo_update":
      return { type: "todo_update", turnId: string("turnId") };
    case "scheduled_work_update":
      return { type: "scheduled_work_update", id: string("id"), status: string("status") };
    case "subagent_started":
      return { type: "subagent_started", agentId: string("agentId"), taskId: string("taskId") };
    case "subagent_spawn_anchor":
    case "subagent_result_card":
      return { type: input.type, agentKey: string("agentKey") };
    case "task_list":
      return { type: "task_list" };
    default:
      if (HISTORY_EVENT_TYPES.has(input.type)) return { type: input.type as HistoryEventType };
      return { type: "unknown" };
  }
}

function isTrivialTurnFoldProjection(event: TurnFoldEventProjection): boolean {
  if (TRIVIAL_EVENT_TYPES.has(event.type)) return true;
  if (event.type === "text" || event.type === "reasoning") return !(event.text ?? "").trim();
  return false;
}

export function isTrivialTurnFoldEvent(event: TurnFoldEventInput): boolean {
  return isTrivialTurnFoldProjection(projectTurnFoldEvent(event));
}

const KEEP_IF_LIVE_EVENT_TYPE_LIST = [
  "background_job_line",
  "background_job_group",
  "approval_request",
  "structured_question",
  "activity_bundle",
  "todo_update",
  "scheduled_work_update",
] as const;
const KEEP_IF_LIVE_EVENT_TYPES: ReadonlySet<string> = new Set(KEEP_IF_LIVE_EVENT_TYPE_LIST);

function classifySystemNotice(event: SystemNoticeProjection): TurnFoldRowRole {
  const { status, noticeKind, severity } = event;
  const detail = readRecord(event.detail);
  // Needs the user: a continuity recovery card and a spendable reset credit.
  if (detail?.kind === "continuity_recovery") return "keep";
  if (status === "reset_credit_available") return "keep";
  // Spawn chips: the spawn/result cards carry the same facts and stay visible.
  if (status === "subagent_spawned" || status === "spawn_completed") return "history";
  if (event.hostSleep) return "history";
  // Old persisted retry notices draw nothing; they must not hold a kept slot.
  if (event.legacyRetry) return "history";
  // Failures and sign-in stay: they are what the user acts on next.
  if (severity === "error") return "keep";
  if (
    noticeKind === "auth"
    || noticeKind === "provider_health"
    || noticeKind === "thread_error"
    || noticeKind === "error"
  ) return "keep";
  // A usage notice is an error (limit hit) unless it says it is only a warning.
  if (noticeKind === "rate_limit") return severity === "warning" || severity === "info" ? "history" : "keep";
  // Model switches and takeovers change what the rest of the thread means.
  if (status === "model_switched" || status === "spawn_takeover" || status === "spawn_parent_gone") return "keep";
  // Warnings and info are a record of the turn, with nothing to act on
  // (a Codex config warning, a hook notice, a compaction that could not run).
  if (
    severity === "warning"
    || severity === "info"
    || noticeKind === "warning"
    || noticeKind === "info"
    || noticeKind === "hook"
    || noticeKind === "file_persist"
    || noticeKind === "config"
  ) {
    return "history";
  }
  return "keep";
}

/**
 * Role of one row, by event type. Accepts raw `AgentChatEvent`s and the
 * desktop's render/grouped row events alike (both are keyed by `type`).
 * Anything unrecognised stays visible — folding an unknown card is the one
 * mistake this cannot take back.
 */
function classifyTurnFoldProjection(event: TurnFoldEventProjection): TurnFoldRowRole {
  switch (event.type) {
    case "user_message":
      // A queued steer is not a message yet (it draws nothing until delivered),
      // so it must not split the turn.
      if (event.deliveryState === "queued") return "keep";
      return "boundary";
    case "done":
      return "turn_end";
    case "text":
      return "text";
    case "reasoning":
      return "history";
    case "task_list":
      // The chat's one task list (desktop row) never folds: it is the thread's
      // standing answer to "where is the agent in its plan".
      return "keep";
    case "system_notice":
      return classifySystemNotice(event);
    case "ade_card": {
      // A new-lane setup record folds once setup has finished; every other
      // card (PR/CI/review/merge/conflict, proof, quota, unknown) stays.
      return event.variant === "lane_setup" ? "keep_if_live" : "keep";
    }
    default:
      if (HISTORY_EVENT_TYPES.has(event.type)) return "history";
      if (KEEP_IF_LIVE_EVENT_TYPES.has(event.type)) return "keep_if_live";
      return "keep";
  }
}

export function classifyTurnFoldEvent(event: TurnFoldEventInput): TurnFoldRowRole {
  return classifyTurnFoldProjection(projectTurnFoldEvent(event));
}

const ACTIVE_SCHEDULED_WORK_STATUSES: ReadonlySet<string> = new Set(["scheduled", "paused", "running"]);

export type TurnEndLivenessOptions = {
  /** True once a `pending_input_resolved` arrived for this approval/question. */
  isInputResolved: (itemId: string) => boolean;
  /** True when the turn's latest task list still has unfinished items. */
  isTodoListUnfinished: (turnId: string | null) => boolean;
};

/**
 * Liveness of one row at turn end, from the row's own state. Scheduled work is
 * judged by its latest update only; {@link snapshotTurnEnd} handles that.
 */
function isProjectedTurnFoldEventLive(event: TurnFoldEventProjection, options: TurnEndLivenessOptions): boolean {
  switch (event.type) {
    case "background_job_line":
      return event.status === "running";
    case "ade_card":
      return event.variant === "lane_setup" && event.state === "live";
    case "approval_request":
    case "structured_question": {
      const itemId = event.itemId;
      return itemId ? !options.isInputResolved(itemId) : true;
    }
    case "todo_update":
      return options.isTodoListUnfinished(event.turnId ?? null);
    case "scheduled_work_update":
      return ACTIVE_SCHEDULED_WORK_STATUSES.has(event.status ?? "");
    default:
      return false;
  }
}

export function isTurnFoldEventLive(event: TurnFoldEventInput, options: TurnEndLivenessOptions): boolean {
  return isProjectedTurnFoldEventLive(projectTurnFoldEvent(event), options);
}

function subagentIdentity(event: TurnFoldEventProjection): string | null {
  switch (event.type) {
    case "subagent_spawn_anchor":
    case "subagent_result_card":
      return event.agentKey ?? null;
    case "subagent_started":
      return event.agentId ?? event.taskId ?? null;
    default:
      return null;
  }
}

/**
 * Snapshot a turn at the moment its `done` arrives. `windowRows` are the rows
 * of that turn in order (everything after its user message, before the done),
 * in their state at that moment. Call it exactly once per turn, while replaying
 * events in order, and the fold is identical for a live session and a reload.
 */
export function snapshotTurnEnd<Row extends { key: string; event: TurnFoldEventInput }>(
  windowRows: readonly Row[],
  options: TurnEndLivenessOptions,
): TurnEndSnapshot {
  const liveRowKeys = new Set<string>();
  const subagents = new Set<string>();
  // Walk newest-first so each scheduled-work id is judged by its latest update;
  // older rows of a finished job are not live even though they said "running".
  const scheduledStatusById = new Map<string, boolean>();
  for (let index = windowRows.length - 1; index >= 0; index -= 1) {
    const row = windowRows[index]!;
    const event = projectTurnFoldEvent(row.event);
    const subagent = subagentIdentity(event);
    if (subagent) subagents.add(subagent);
    if (event.type === "scheduled_work_update") {
      const id = event.id ?? row.key;
      let live = scheduledStatusById.get(id);
      if (live === undefined) {
        live = isProjectedTurnFoldEventLive(event, options);
        scheduledStatusById.set(id, live);
      }
      if (live) liveRowKeys.add(row.key);
      continue;
    }
    if (isProjectedTurnFoldEventLive(event, options)) liveRowKeys.add(row.key);
  }
  return { liveRowKeys, subagentCount: subagents.size };
}

/**
 * A `done` that belongs to someone else's window — a subagent's turn ending
 * inside the parent turn. The window already has rows naming a turn, and none
 * of them names this one. Such a row neither ends the window nor folds a turn
 * of its own, so the parent's fold (and its turn-end snapshot) still spans the
 * whole turn whatever order the `done` events arrive in. An id-less `done`, or
 * one ending a window that names no turn at all, always owns its window.
 */
export function isForeignTurnEnd(
  turnId: string | null | undefined,
  windowTurnIds: ReadonlySet<string>,
): boolean {
  return Boolean(turnId) && windowTurnIds.size > 0 && !windowTurnIds.has(turnId!);
}

/**
 * The turn a `done` without a turn id ended: the id on the window's user
 * message, else the id on the window's last assistant text. The desktop
 * collapse pass (turn-end snapshot) and the fold derive it the same way, so the
 * snapshot is found under the same key.
 */
export function inferTurnEndTurnId(
  boundaryTurnId: string | null | undefined,
  windowRows: Iterable<{ role: TurnFoldRowRole; turnId: string | null }>,
): string | null {
  if (boundaryTurnId) return boundaryTurnId;
  let lastTextTurnId: string | null = null;
  for (const row of windowRows) {
    if (row.role === "text" && row.turnId) lastTextTurnId = row.turnId;
  }
  return lastTextTurnId;
}

function rowFolds(row: TurnFoldRow, turnId: string, snapshot: TurnEndSnapshot | undefined): boolean {
  switch (row.role) {
    case "history":
      return true;
    case "turn_end":
      // Only a foreign `done` (a subagent's) can sit inside a span; the turn's
      // own `done` closes the window. It is a receipt of finished work.
      return true;
    case "text":
      // Interim narration of THIS turn folds; a stray row from another turn
      // is not ours to hide.
      return !row.turnId || row.turnId === turnId;
    case "keep_if_live": {
      // No snapshot means we cannot know what was live: keep it visible.
      if (!snapshot) return false;
      const keys = row.liveKeys?.length ? row.liveKeys : [row.key];
      return !keys.some((key) => snapshot.liveRowKeys.has(key));
    }
    default:
      return false;
  }
}

function foldTurn(
  rows: readonly TurnFoldRow[],
  windowStart: number,
  turnEndIndex: number,
  turnId: string,
  snapshotFor: (turnId: string) => TurnEndSnapshot | undefined,
  deferredTurnId: string | null,
): TurnFold | null {
  const turnEnd = rows[turnEndIndex]!;

  let lastText = -1;
  let lastFinalAnswer = -1;
  for (let index = windowStart; index < turnEndIndex; index += 1) {
    const row = rows[index]!;
    if (row.role !== "text") continue;
    if (row.turnId && row.turnId !== turnId) continue;
    if (row.phase === "commentary") continue;
    lastText = index;
    if (row.phase === "final_answer") lastFinalAnswer = index;
  }
  const answerIndex = lastFinalAnswer >= 0 ? lastFinalAnswer : lastText;
  if (answerIndex < 0) return null;

  const snapshot = snapshotFor(turnId);
  const hiddenKeys = new Set<string>();
  const keptKeys: string[] = [];
  const answerText = rows[answerIndex]!.text?.trim() ?? "";
  const duplicateAnswerKeys = new Set<string>();
  let hidesContent = false;
  for (let index = windowStart; index < answerIndex; index += 1) {
    const row = rows[index]!;
    const belongsToDeferredTurn = Boolean(deferredTurnId && row.turnId === deferredTurnId);
    if (!belongsToDeferredTurn && rowFolds(row, turnId, snapshot)) {
      hiddenKeys.add(row.key);
      if (!row.trivial) hidesContent = true;
      if (row.role === "text" && answerText && isSameProse(row.text, answerText)) duplicateAnswerKeys.add(row.key);
    } else {
      keptKeys.push(row.key);
    }
  }
  // A fold over nothing but receipts and empty rows is noise: draw the rows.
  if (!hidesContent) return null;

  return {
    foldId: turnFoldId(turnId),
    turnId,
    turnEndKey: turnEnd.key,
    status: turnEnd.status ?? "completed",
    answerKey: rows[answerIndex]!.key,
    spanStartIndex: windowStart,
    answerIndex,
    hiddenKeys,
    keptKeys,
    subagentCount: snapshot?.subagentCount ?? 0,
    duplicateAnswerKeys,
  };
}

/** Byte-identical once trimmed; the length check skips the trim for most rows. */
function isSameProse(text: string | null | undefined, trimmedAnswer: string): boolean {
  if (!text || text.length < trimmedAnswer.length) return false;
  return text.trim() === trimmedAnswer;
}

/**
 * Every fold in a transcript, in order. O(n): one pass to find turn ends, and
 * each row is visited by at most one turn's answer scan and span scan.
 *
 * A turn's window starts after the nearest user message or previous turn end,
 * so a steer (its own user message) starts a new visual response, and a turn
 * with no user message (a scheduled wake, a background completion) starts
 * after the previous turn. A subagent's `done` inside the window does not end
 * it ({@link isForeignTurnEnd}); it folds with the turn's other history. A
 * `done` without a turn id folds under the id {@link inferTurnEndTurnId}
 * finds. One fold per turn id: a repeated `done` for the same turn finds an
 * empty window and folds nothing.
 */
export function deriveTurnFolds(
  rows: readonly TurnFoldRow[],
  snapshotFor: (turnId: string) => TurnEndSnapshot | undefined,
): TurnFold[] {
  const folds: TurnFold[] = [];
  const foldedTurnIds = new Set<string>();
  let windowStart = 0;
  let boundaryTurnId: string | null = null;
  let windowTurnIds = new Set<string>();
  let deferredBoundary: { index: number; turnId: string } | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.role === "boundary") {
      // A queued follow-up keeps its original transcript position when it is
      // delivered. If it names a later turn while the current window already
      // names another turn, remember it for the next window instead of
      // truncating the turn whose `done` is still ahead in chronological data.
      if (
        row.turnId
        && windowTurnIds.size > 0
        && !windowTurnIds.has(row.turnId)
      ) {
        deferredBoundary ??= { index, turnId: row.turnId };
        continue;
      }
      windowStart = index + 1;
      boundaryTurnId = row.turnId;
      windowTurnIds = new Set(row.turnId ? [row.turnId] : []);
      continue;
    }
    if (row.role !== "turn_end") {
      if (row.turnId && row.turnId !== deferredBoundary?.turnId) windowTurnIds.add(row.turnId);
      continue;
    }
    if (isForeignTurnEnd(row.turnId, windowTurnIds)) continue;
    const turnId = row.turnId
      ?? inferTurnEndTurnId(boundaryTurnId, rows.slice(windowStart, index));
    if (turnId && !foldedTurnIds.has(turnId)) {
      const fold = foldTurn(rows, windowStart, index, turnId, snapshotFor, deferredBoundary?.turnId ?? null);
      if (fold) {
        folds.push(fold);
        foldedTurnIds.add(fold.turnId);
      }
    }
    if (deferredBoundary) {
      windowStart = deferredBoundary.index + 1;
      boundaryTurnId = deferredBoundary.turnId;
      windowTurnIds = new Set([deferredBoundary.turnId]);
      deferredBoundary = null;
    } else {
      windowStart = index + 1;
      boundaryTurnId = null;
      windowTurnIds = new Set();
    }
  }
  return folds;
}

/** `5 jobs`, or `5 jobs (1 failed)` when any background job failed. */
export function formatTurnFoldJobCount(jobCount: number, failedJobCount = 0): string {
  const base = pluralCount(jobCount, "job");
  return failedJobCount > 0 ? `${base} (${failedJobCount} failed)` : base;
}

/** The fold label's lead: `Worked for 4m 12s`, or `Stopped after …` for an interrupted turn. */
export function formatTurnFoldHead(input: { duration: string | null; status: TurnEndStatus }): string {
  if (input.status === "interrupted") return input.duration ? `Stopped after ${input.duration}` : "Stopped";
  return input.duration ? `Worked for ${input.duration}` : "Worked";
}

/**
 * `Worked for 4m 12s · 18 tools · 3 files · 2 subagents · 5 jobs (1 failed) · 4 sources`. A stopped turn reads
 * `Stopped after …` — deliberately not "You stopped": an interrupted `done`
 * does not say who stopped it, and ADE only attributes a stop to the user when
 * the event says so. Zero counts are omitted.
 */
export function formatTurnFoldLabel(input: {
  /** Pre-formatted turn duration (the same one the turn-end line shows), or null. */
  duration: string | null;
  status: TurnEndStatus;
  toolCount: number;
  fileCount: number;
  subagentCount: number;
  /** Background jobs (backgrounded shell commands) the turn ran. */
  jobCount?: number;
  failedJobCount?: number;
  /** Sources the turn drew on (`shared/chatSources.ts` byTurn). */
  sourceCount?: number;
}): string {
  const parts = [formatTurnFoldHead(input)];
  if (input.toolCount > 0) parts.push(pluralCount(input.toolCount, "tool"));
  if (input.fileCount > 0) parts.push(pluralCount(input.fileCount, "file"));
  if (input.subagentCount > 0) parts.push(pluralCount(input.subagentCount, "subagent"));
  if ((input.jobCount ?? 0) > 0) parts.push(formatTurnFoldJobCount(input.jobCount!, input.failedJobCount));
  if ((input.sourceCount ?? 0) > 0) parts.push(pluralCount(input.sourceCount!, "source"));
  return parts.join(" · ");
}
