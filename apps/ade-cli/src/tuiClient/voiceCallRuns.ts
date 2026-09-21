/**
 * CTO voice calls in the terminal transcript.
 *
 * A voice call thinks on the CTO's own chat thread, so its turns are written
 * like every other turn and carry `provenance.voiceCallId` (see
 * `agentChatService`). The desktop folds a consecutive run of them into one
 * collapsible card, because a stream of bubbles nobody typed reads as a bug.
 *
 * The terminal cannot fold the same way and keep the content: `ade code` has no
 * general per-row disclosure — the only keyboard expansion is the LATEST failed
 * line, and mouse expansion exists only for work groups — so a folded call here
 * would be a call nobody can ever read back. It would also be the only place
 * the CTO's spoken answers exist on this surface: `ade code --session <id>` is
 * the one way to open an identity thread at all (`chat.listSessions` filters
 * identity sessions out), and someone who typed that id did it to read the
 * thread.
 *
 * So the terminal marks instead of folding: one dim line at the head of each
 * run saying a call happened, how long it ran, and how much was said, and the
 * turns themselves render normally underneath it. Same fact as the desktop
 * card's collapsed title, no content dropped.
 */
import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";

/** Prefix for the synthetic marker line's id, so it cannot collide with a real
 *  event line id (those are derived from the envelope, never from a call id). */
export const VOICE_CALL_LINE_PREFIX = "voice-call:";

export function voiceCallLineId(callId: string): string {
  return `${VOICE_CALL_LINE_PREFIX}${callId}`;
}

export type VoiceCallRun = {
  callId: string;
  /** Index into the events array of the run's FIRST envelope — where the
   *  marker line is emitted. */
  startIndex: number;
  /** Turns the user spoke into this call, counted the way the desktop card
   *  counts exchanges: one per user message. */
  exchanges: number;
  /** Wall time between the run's first and last envelope, or null when the
   *  timestamps are unusable. Grows while a call is still running. */
  durationMs: number | null;
  /** True when ADE stopped the call to ask the user out loud. */
  hadApproval: boolean;
};

function callIdOf(envelope: AgentChatEventEnvelope): string | null {
  const raw = envelope.provenance?.voiceCallId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function spanMs(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const span = end - start;
  return span >= 0 ? span : null;
}

/**
 * Split `events` into maximal consecutive runs sharing one voice call id, keyed
 * by the index of each run's first envelope.
 *
 * Array order, not timestamp order: both callers index into this same array,
 * and a run is defined by adjacency in it. With no voice-stamped envelope the
 * map is empty and every caller's behaviour is unchanged.
 */
export function voiceCallRunsByStartIndex(
  events: readonly AgentChatEventEnvelope[],
): Map<number, VoiceCallRun> {
  const runs = new Map<number, VoiceCallRun>();
  let index = 0;
  while (index < events.length) {
    const callId = callIdOf(events[index]!);
    if (!callId) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < events.length && callIdOf(events[end]!) === callId) end += 1;

    let exchanges = 0;
    let hadApproval = false;
    for (let scan = index; scan < end; scan += 1) {
      const type = events[scan]!.event.type;
      if (type === "user_message") exchanges += 1;
      else if (type === "approval_request") hadApproval = true;
    }
    runs.set(index, {
      callId,
      startIndex: index,
      exchanges,
      durationMs: spanMs(events[index]!.timestamp, events[end - 1]!.timestamp),
      hadApproval,
    });
    index = end;
  }
  return runs;
}

/** Mirrors the desktop card's compact duration so the same call reads the same
 *  length on both surfaces. */
function compactDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs < 1000) return null;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

/** The one dim line a call's run is headed by. */
export function voiceCallMarkerBody(run: VoiceCallRun): string {
  const parts: string[] = [
    `${run.exchanges} ${run.exchanges === 1 ? "exchange" : "exchanges"}`,
  ];
  const duration = run.durationMs === null ? null : compactDuration(run.durationMs);
  if (duration) parts.push(duration);
  if (run.hadApproval) parts.push("approval");
  return `[voice call] ${parts.join(" · ")}`;
}
