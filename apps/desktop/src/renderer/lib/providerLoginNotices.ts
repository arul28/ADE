/**
 * Reads the sign-in notices that the brain puts in a chat
 * (`system_notice.providerLogin`) for the cards above the prompt box.
 *
 * - `latestOwnerOffNotice`: the turn that just stopped on its sign-in waited
 *   for another computer that did not renew it. The sign-in card says so.
 * - `latestSwitchThenFailure`: the first turn after the account of the chat
 *   changed failed. The provider may refuse to continue the old conversation
 *   under the new account; the card offers a new thread or the old account.
 */
import type { AgentChatEvent, AgentChatEventEnvelope, AgentChatProviderLoginNotice } from "../../shared/types";

/** How far back a card looks; a turn's own events are far fewer. */
const LOOKBACK = 80;

type SwitchedNotice = Extract<AgentChatProviderLoginNotice, { kind: "switched" }>;

function providerLoginOf(event: AgentChatEvent): AgentChatProviderLoginNotice | null {
  if (event.type !== "system_notice") return null;
  return event.providerLogin ?? null;
}

/** Something worked: text, a tool, or a turn that completed. */
function isSuccess(event: AgentChatEvent): boolean {
  if (event.type === "text" && event.text.trim().length > 0) return true;
  if (event.type === "done" && event.status === "completed") return true;
  return event.type === "tool_call" || event.type === "tool_result";
}

function isFailedTurnEnd(event: AgentChatEvent): boolean {
  return (event.type === "done" && event.status === "failed")
    || (event.type === "status" && event.turnStatus === "failed");
}

function keyOf(envelope: AgentChatEventEnvelope, index: number): string {
  return `${envelope.sequence ?? index}:${envelope.timestamp ?? ""}`;
}

/**
 * The computer that did not renew the provider's sign-in for the last turn,
 * when nothing has worked since. Null otherwise.
 */
export function latestOwnerOffNotice({
  provider,
  events,
}: {
  provider: string | null | undefined;
  events: AgentChatEventEnvelope[];
}): { provider: string; ownerLabel: string } | null {
  if (!provider) return null;
  for (let index = events.length - 1; index >= 0 && index >= events.length - LOOKBACK; index -= 1) {
    const event = events[index]?.event;
    if (!event) continue;
    if (isSuccess(event)) return null;
    const notice = providerLoginOf(event);
    if (notice?.kind === "owner_off" && notice.provider === provider) {
      return { provider, ownerLabel: notice.ownerLabel };
    }
  }
  return null;
}

/**
 * The account change before the chat's last turn, when that turn was the
 * first one after the change and it failed. Null while a turn runs, after
 * anything worked, or when the last turn did not fail.
 */
export function latestSwitchThenFailure({
  provider,
  events,
  turnActive = false,
}: {
  provider: string | null | undefined;
  events: AgentChatEventEnvelope[];
  turnActive?: boolean;
}): { notice: SwitchedNotice; eventKey: string } | null {
  if (!provider || turnActive) return null;
  let failedTurn = false;
  for (let index = events.length - 1; index >= 0 && index >= events.length - LOOKBACK; index -= 1) {
    const envelope = events[index];
    const event = envelope?.event;
    if (!event) continue;
    if (!failedTurn) {
      // The newest turn boundary decides: only a failed last turn counts.
      if (isFailedTurnEnd(event)) failedTurn = true;
      else if (isSuccess(event)) return null;
      continue;
    }
    if (isSuccess(event)) return null;
    const notice = providerLoginOf(event);
    if (notice?.kind === "switched" && notice.provider === provider && notice.from) {
      return { notice, eventKey: keyOf(envelope, index) };
    }
    // An earlier failed turn: the switch, if any, was not right before this one.
    if (isFailedTurnEnd(event)) return null;
  }
  return null;
}
