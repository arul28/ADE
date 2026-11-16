import { sessionTurnLive } from "../../../shared/sessionStatusPresentation";
import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
  TerminalSessionSummary,
} from "../../../shared/types";

function chatEventEndsTurn(event: AgentChatEventEnvelope["event"]): boolean {
  return event.type === "done" || (event.type === "status" && event.turnStatus !== "started");
}

export function isParentUserMessage(
  event: AgentChatEventEnvelope["event"],
): event is Extract<AgentChatEvent, { type: "user_message" }> {
  return event.type === "user_message"
    && (!event.steerId || Boolean(event.messageId?.trim()));
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
      isParentUserMessage(event)
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

/**
 * The brain says the chat is idle, in a summary at least as new as the
 * transcript's last event: the transcript's open turn ended with no end event
 * (its brain restarted, or its ADE Cloud computer slept mid-turn). The Work
 * row reads the same summary. A turn that starts after the summary was read
 * has a newer event (or patched the summary active), so it still shows.
 */
export function summarySaysTurnEnded(
  events: AgentChatEventEnvelope[],
  summary: AgentChatSessionSummary | null | undefined,
): boolean {
  if (!summary || summary.status === "active" || summary.currentTurnStartedAt || summary.awaitingInput === true) return false;
  const last = events[events.length - 1];
  if (!last) return false;
  const summaryAt = Date.parse(summary.lastActivityAt);
  const lastAt = Date.parse(last.timestamp);
  return Number.isFinite(summaryAt) && Number.isFinite(lastAt) && lastAt <= summaryAt;
}

/**
 * The chat's Work row, read from its own machine, says no turn runs, and it
 * is at least as new as the transcript's last event. The pane then shows what
 * the row shows: after a wake or a reconnect nothing else re-reads the
 * summary, and a turn that ended with no end event would read as running for
 * as long as the pane stays open. A saved copy (its computer asleep) is left
 * to the sleep rule; a send or a turn started elsewhere adds a newer event, so
 * it still shows until the row catches up.
 */
export function rowSaysTurnEnded(
  events: readonly AgentChatEventEnvelope[] | undefined,
  row: Pick<TerminalSessionSummary, "cloudSavedCopy" | "currentTurnStartedAt" | "chatIdleSinceAt" | "endedAt" | "lastActivityAt"> | null | undefined,
): boolean {
  if (!row || row.cloudSavedCopy === true || sessionTurnLive(row)) return false;
  const last = events?.[events.length - 1];
  if (!last) return false;
  const rowAt = Math.max(
    ...[row.chatIdleSinceAt, row.lastActivityAt, row.endedAt].map((at) => (at ? Date.parse(at) : Number.NaN)).filter(Number.isFinite),
  );
  const lastAt = Date.parse(last.timestamp);
  return Number.isFinite(rowAt) && Number.isFinite(lastAt) && lastAt <= rowAt;
}

export function resolveTurnActive(
  events: AgentChatEventEnvelope[],
  derivedTurnActive: boolean,
  summary: AgentChatSessionSummary | null | undefined,
): boolean {
  if (derivedTurnActive) return !summarySaysTurnEnded(events, summary);
  return events.length > 0
    && summary?.status === "active"
    && summary.awaitingInput !== true
    && !transcriptLatestTurnIsTerminal(events);
}
