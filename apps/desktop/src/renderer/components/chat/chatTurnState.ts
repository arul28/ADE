import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
} from "../../../shared/types";

function chatEventEndsTurn(event: AgentChatEventEnvelope["event"]): boolean {
  return event.type === "done" || (event.type === "status" && event.turnStatus !== "started");
}

export function findUserMessageForTurn(
  events: AgentChatEventEnvelope[],
  turnId: string,
): Extract<AgentChatEvent, { type: "user_message" }> | null {
  let turnAnchor = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!.event;
    if ("turnId" in event && event.turnId === turnId) {
      turnAnchor = index;
      break;
    }
  }
  if (turnAnchor < 0) return null;

  for (let index = turnAnchor; index >= 0; index -= 1) {
    const event = events[index]!.event;
    if (
      event.type === "user_message"
      && !event.steerId
      && typeof event.text === "string"
      && event.text.trim().length > 0
      && (!event.turnId || event.turnId === turnId)
    ) {
      return event;
    }
    if (
      index < turnAnchor
      && chatEventEndsTurn(event)
      && (!("turnId" in event) || event.turnId !== turnId)
    ) {
      break;
    }
  }
  return null;
}

/** Terminal transcript evidence outranks an eventually-consistent summary. */
export function transcriptLatestTurnIsTerminal(events: AgentChatEventEnvelope[]): boolean {
  let terminalIndex = -1;
  let terminalTurnId: string | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!.event;
    if (!chatEventEndsTurn(event)) continue;
    terminalIndex = index;
    terminalTurnId = "turnId" in event && typeof event.turnId === "string" ? event.turnId : null;
    break;
  }
  if (terminalIndex < 0) return false;

  for (let index = terminalIndex + 1; index < events.length; index += 1) {
    const event = events[index]!.event;
    if (event.type === "status" && event.turnStatus === "started") return false;
    if (event.type === "user_message") return false;
    const eventTurnId = "turnId" in event && typeof event.turnId === "string" ? event.turnId : null;
    if (eventTurnId && eventTurnId !== terminalTurnId) return false;
  }
  return true;
}

export function resolveTurnActive(
  events: AgentChatEventEnvelope[],
  derivedTurnActive: boolean,
  summary: AgentChatSessionSummary | null | undefined,
): boolean {
  if (derivedTurnActive) return true;
  return events.length > 0
    && summary?.status === "active"
    && summary.awaitingInput !== true
    && !transcriptLatestTurnIsTerminal(events);
}
