import type { AgentChatEvent } from "../../../shared/types";

/**
 * A blocking turn ended because its chat went away (ended, deleted, disposed),
 * not because the agent failed. Retrying it would start a new agent.
 */
export class SessionTurnAbandonedError extends Error {}

/** Largest delay a Node timer honors; anything longer fires immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A turn limit in ms: at least 15 s, and never past what a timer can hold. */
export function clampTurnTimerMs(ms: number): number {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(15_000, Math.floor(ms)));
}

/** An event stamped with a different turn than the one the collector is waiting on. */
export function isForeignTurnEvent(
  collectorTurnId: string | null | undefined,
  eventTurnId: string | null | undefined,
): boolean {
  return Boolean(collectorTurnId && eventTurnId && eventTurnId !== collectorTurnId);
}

/**
 * Update the set of work a turn still has open from one of its events. While
 * the set is non-empty the turn is waiting, not idle: a command running a long
 * build, a tool call, a foreground subagent, or an approval the user owes.
 *
 * Background tasks are not tracked — they often outlive the turn without a
 * result event, and holding the watch open for them would switch it off.
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
