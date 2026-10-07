import { isDroppedSteerDeliveryState } from "./chatTranscript";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types";

/**
 * Update the set of work a turn still has open from one of its events. While
 * the set is non-empty the turn is waiting, not idle: a command running a long
 * build, a tool call, a foreground subagent, or an approval the user owes.
 *
 * Background tasks are not tracked — they often outlive the turn without a
 * result event, and holding the watch open for them would switch it off.
 *
 * ONE owner for this contract. The main-process turn watchdogs fold a turn's
 * events with it, and the chat pane folds the same events to tell "waiting on
 * real work" apart from "gone quiet" before it says a turn looks stuck. Two
 * copies would drift, and the drift would land on the user as either a false
 * stall alarm or a silent hang.
 */
export function trackTurnInFlight(inFlight: Set<string>, event: AgentChatEvent): void {
  switch (event.type) {
    case "tool_call":
      inFlight.add(`tool:${event.itemId}`);
      break;
    case "tool_result":
      if (event.status !== "running") inFlight.delete(`tool:${event.itemId}`);
      break;
    case "command":
      if (event.status === "running") inFlight.add(`command:${event.itemId}`);
      else inFlight.delete(`command:${event.itemId}`);
      break;
    case "subagent_started":
      if (event.background !== true && event.taskType !== "background") inFlight.add(`subagent:${event.taskId}`);
      break;
    case "subagent_result":
      inFlight.delete(`subagent:${event.taskId}`);
      break;
    case "approval_request":
      inFlight.add(`input:${event.itemId}`);
      break;
    case "pending_input_resolved":
      inFlight.delete(`input:${event.itemId}`);
      break;
    // Codex's sleep tool is a deliberate wait, the same as a long command.
    case "codex_sleep":
      if (event.status === "running") inFlight.add(`sleep:${event.itemId}`);
      else inFlight.delete(`sleep:${event.itemId}`);
      break;
    default:
      break;
  }
}

/**
 * Does a turn still own work that legitimately produces no output right now?
 *
 * Folded over a turn's events in order, so a finished tool or command drops out
 * of the set and only genuinely-open work answers true. A result event that
 * never arrived (the provider wedged mid-tool) leaves its entry in place, which
 * errs toward staying quiet rather than raising a false stall — the same
 * direction the main-process watchdogs already take.
 */
export function turnHasOpenWork(events: Iterable<AgentChatEvent>): boolean {
  const inFlight = new Set<string>();
  for (const event of events) {
    // A turn boundary resets the fold. This caller folds the session's whole
    // resident window, so a tool or command from an earlier turn that never
    // received its result — exactly what an interrupt leaves behind — would
    // otherwise stay open forever and keep every later turn looking busy. The
    // main-process watchdogs fold one turn already, so this reset is only for
    // the whole-history fold.
    if (event.type === "status" && event.turnStatus === "started") {
      inFlight.clear();
      continue;
    }
    trackTurnInFlight(inFlight, event);
  }
  return inFlight.size > 0;
}

/**
 * Is this event evidence that the turn is moving?
 *
 * Every provider (Claude, Codex, Cursor, OpenCode, Droid) streams its progress
 * as these same event types: reasoning, text, tool calls and results, commands,
 * activity, token and context usage. What is NOT progress is what ADE itself
 * writes while a turn is quiet: its own stall and recovery notices, queue and
 * schedule bookkeeping, metadata patches, cards, and a steer the model never
 * read. Counting those would let ADE's own "this turn looks stuck" notice reset
 * the silence it reports. Unknown types count as progress, so a new provider
 * event can never raise a false stall alarm.
 */
export function isTurnProgressEvent(event: AgentChatEvent): boolean {
  switch (event.type) {
    case "session_meta_updated":
    case "scheduled_work_update":
    case "prompt_suggestion":
    case "queue_reordered":
    case "queue_recovery":
    case "turn_health":
    case "turn_recovery":
    case "codex_turn_recovery":
    case "turn_diagnostics":
    case "codex_turn_stalled":
    case "interrupt_receipt":
    case "system_notice":
    case "ade_card":
      return false;
    case "user_message":
      // A queued steer is staged, not delivered — the model has not read it,
      // so counting it would reset the stall clock over a still-quiet turn.
      return event.deliveryState !== "queued"
        && !isDroppedSteerDeliveryState(event.deliveryState);
    default:
      return true;
  }
}

/**
 * Timestamp of the newest progress event in a transcript window, or null.
 *
 * The chat pane's session summary only refreshes on lifecycle edges, so its
 * `lastActivityAt` freezes for a whole turn of tool calls and thinking; the
 * transcript itself is the live clock. Walks from the end and stops at the
 * first hit, so a streaming turn costs one step.
 */
export function latestTurnProgressAt(envelopes: readonly AgentChatEventEnvelope[]): string | null {
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const envelope = envelopes[index];
    if (envelope && isTurnProgressEvent(envelope.event)) return envelope.timestamp;
  }
  return null;
}
