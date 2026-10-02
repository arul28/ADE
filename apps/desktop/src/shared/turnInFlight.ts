import type { AgentChatEvent } from "./types";

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
