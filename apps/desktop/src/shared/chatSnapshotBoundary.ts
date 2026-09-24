import type { AgentChatEventEnvelope } from "./types";

/**
 * Turn-boundary alignment for byte-capped chat snapshots (`chatLogV2`).
 *
 * A snapshot is the newest N bytes of a transcript, so its first event is
 * usually in the middle of a turn: the reply's opening deltas, the tool call it
 * belongs to, or the user message that started it sit just outside the window.
 * A client can only render that correctly by fetching an older page first.
 *
 * Moving the cut back to the nearest `user_message` or turn `status: started`
 * gives the client a window that starts where a turn starts. The move is
 * bounded: at most `maxExtraBytes` more than the natural cut. If no boundary
 * lies within that span the natural cut stands (a single turn larger than the
 * budget cannot be aligned without unbounded snapshots).
 */
export function isChatTurnBoundaryEnvelope(envelope: AgentChatEventEnvelope | null | undefined): boolean {
  const event = envelope?.event as { type?: unknown; turnStatus?: unknown } | undefined;
  if (!event || typeof event !== "object") return false;
  if (event.type === "user_message") return true;
  return event.type === "status" && event.turnStatus === "started";
}

/**
 * Index of the first event to keep once the cut at `naturalStart` is moved back
 * to a turn boundary. `sizeOf(i)` is the byte cost of `events[i]`. Returns
 * `naturalStart` when it is already a boundary, when it is 0, or when no
 * boundary exists within `maxExtraBytes` before it.
 */
export function turnAlignedSnapshotStart(
  events: readonly AgentChatEventEnvelope[],
  naturalStart: number,
  maxExtraBytes: number,
  sizeOf: (index: number) => number,
): number {
  const start = Math.max(0, Math.min(events.length, Math.floor(naturalStart)));
  if (start <= 0 || start >= events.length) return start;
  if (isChatTurnBoundaryEnvelope(events[start])) return start;
  let extra = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    extra += Math.max(0, sizeOf(index));
    if (extra > maxExtraBytes) break;
    if (isChatTurnBoundaryEnvelope(events[index])) return index;
  }
  return start;
}
