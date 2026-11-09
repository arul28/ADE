/**
 * Failures ADE is fixing by itself, folded to one quiet line instead of a
 * trail of errors: a provider thread that was lost and rebuilt, and a Claude
 * turn retried after the Mac's keychain did not answer its sign-in read.
 *
 * Kept apart from `chatTranscriptRows.ts`, which runs the fold; this file takes
 * only (erased) types back from it, so there is no runtime cycle.
 */
import type { AgentChatNoticeDetail } from "../../../shared/types";
import type { ChatTranscriptRenderEnvelope, ChatTranscriptRenderEvent } from "./chatTranscriptRows";

/**
 * A queued turn that ran into the lost thread fails with the provider's own
 * text, and transcripts saved before this fold carry nothing else to go on.
 */
const LOST_PROVIDER_THREAD_ERROR = /no conversation found with session id|could not resume the original codex thread/i;

function turnIdOf(event: ChatTranscriptRenderEvent): string | null {
  const value = (event as { turnId?: unknown }).turnId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function continuityDetail(event: ChatTranscriptRenderEvent): AgentChatNoticeDetail | null {
  if (event.type !== "system_notice") return null;
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || detail.kind !== "continuity_recovery") return null;
  return detail;
}

function isHandOffMessage(event: ChatTranscriptRenderEvent): boolean {
  return event.type === "user_message" && event.metadata?.kind === "continuity_recovery";
}

/**
 * What "Try again" wrote before its receipt carried a continuity detail. It
 * names no thread, so in those saved transcripts it settles every unresolved
 * notice so far.
 */
function isUntaggedReconnectNotice(event: ChatTranscriptRenderEvent): boolean {
  return event.type === "system_notice" && !event.detail && event.message === "Reconnected to the original thread.";
}

function isKeychainRetryNotice(event: ChatTranscriptRenderEvent): boolean {
  return event.type === "system_notice" && event.status === "claude_keychain_retry";
}

/** The rows that draw a turn as failed: its FAILED pill, its failed end and (optionally) its error. */
function isFailureRowOf(event: ChatTranscriptRenderEvent, turnIds: ReadonlySet<string>, withErrors: boolean): boolean {
  const turnId = turnIdOf(event);
  if (!turnId || !turnIds.has(turnId)) return false;
  if (event.type === "error") return withErrors;
  if (event.type === "status") return event.turnStatus === "failed";
  if (event.type === "done") return event.status === "failed";
  return false;
}

/**
 * - an earlier recovery's hand-off message (ADE's, not the user's) never draws;
 * - only the newest notice about one lost thread draws, so "Reconnecting…",
 *   repeats and "Reconnected" do not stack;
 * - once the thread is rebuilt (or moved to a new chat), the failed turns that
 *   ran into the missing thread draw nothing. "Try again" getting the same
 *   thread back answers nothing, so those turns keep their Retry.
 */
function foldContinuityRecovery(rows: ChatTranscriptRenderEnvelope[]): ChatTranscriptRenderEnvelope[] {
  const lastNoticeIndexByThread = new Map<string, number>();
  const isResolved = (detail: AgentChatNoticeDetail) => detail.state === "reconstructed" || Boolean(detail.supersededBySessionId);
  rows.forEach((row, index) => {
    if (isUntaggedReconnectNotice(row.event)) {
      for (const [thread, noticeIndex] of lastNoticeIndexByThread) {
        if (!isResolved(continuityDetail(rows[noticeIndex]!.event)!)) lastNoticeIndexByThread.delete(thread);
      }
    }
    const detail = continuityDetail(row.event);
    if (detail) lastNoticeIndexByThread.set(detail.originalThreadId ?? "", index);
  });
  const resolvedThreads = new Set<string>();
  for (const [thread, index] of lastNoticeIndexByThread) {
    const detail = continuityDetail(rows[index]!.event)!;
    if (isResolved(detail) && !detail.originalThreadResumed) resolvedThreads.add(thread);
  }
  // Turns that failed because the thread was gone, for threads that came back.
  // A "not found" error belongs to the next notice after it: a thread lost
  // later, and not yet back, keeps its errors.
  const failedTurnIds = new Set<string>();
  let nextNoticeThread: string | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const event = rows[index]!.event;
    const detail = continuityDetail(event);
    const turnId = turnIdOf(event);
    if (detail) {
      nextNoticeThread = detail.originalThreadId ?? "";
      if (turnId && resolvedThreads.has(nextNoticeThread)) failedTurnIds.add(turnId);
      continue;
    }
    if (
      turnId
      && event.type === "error"
      && nextNoticeThread !== null
      && resolvedThreads.has(nextNoticeThread)
      && LOST_PROVIDER_THREAD_ERROR.test(event.message)
    ) {
      failedTurnIds.add(turnId);
    }
  }
  return rows.filter((row, index) => {
    const event = row.event;
    if (isHandOffMessage(event)) return false;
    const detail = continuityDetail(event);
    if (detail) return lastNoticeIndexByThread.get(detail.originalThreadId ?? "") === index;
    return !isFailureRowOf(event, failedTurnIds, true);
  });
}

/**
 * A turn ADE is trying once more reads as one quiet line, not a FAILED pill.
 * If the retry fails too, that turn's error still draws.
 */
function foldKeychainRetry(rows: ChatTranscriptRenderEnvelope[]): ChatTranscriptRenderEnvelope[] {
  const retriedTurnIds = new Set<string>();
  for (const row of rows) {
    const turnId = isKeychainRetryNotice(row.event) ? turnIdOf(row.event) : null;
    if (turnId) retriedTurnIds.add(turnId);
  }
  return rows.filter((row) => !isFailureRowOf(row.event, retriedTurnIds, false));
}

export function foldSelfHealedFailures(rows: ChatTranscriptRenderEnvelope[]): ChatTranscriptRenderEnvelope[] {
  // Almost every chat has none of this: one cheap pass, no copy.
  let continuity = false;
  let keychain = false;
  for (const { event } of rows) {
    if (continuityDetail(event) || isHandOffMessage(event)) continuity = true;
    else if (isKeychainRetryNotice(event)) keychain = true;
  }
  let folded = rows;
  if (continuity) folded = foldContinuityRecovery(folded);
  if (keychain) folded = foldKeychainRetry(folded);
  return folded;
}
