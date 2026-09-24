import type { AgentChatEventEnvelope, PendingInputRequest } from "../../../shared/types/chat";
import { readPendingInputRequest } from "../../../shared/pendingInputRequest";

export type PendingInputRecord = {
  request: PendingInputRequest | null;
  resolvedAs: "accepted" | "declined" | "cancelled" | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The durable record of one card, read back from the transcript.
 *
 * A card is durable (it is an `approval_request` event, and the renderer
 * rebuilds it from that event after a restart) while its waiter is
 * process-local. So "the card is on screen" and "something is waiting for
 * the answer" are two different facts, and this reads the first one when the
 * second is already false.
 *
 * `resolvedAs` is the other half. An `accepted` receipt means this card was
 * already answered and delivered, so a second response for it must change
 * nothing — overwriting it with a `cancelled` receipt is how an answered
 * question came to read "unanswered". A `cancelled` one carries no such
 * claim: nothing was delivered, so a late answer is still worth saving.
 *
 * A request record that does not read as a `PendingInputRequest` is dropped,
 * the same as an event that carries none.
 */
export function readPendingInputRecord(
  events: readonly AgentChatEventEnvelope[],
  itemId: string,
): PendingInputRecord {
  let request: PendingInputRequest | null = null;
  let resolvedAs: PendingInputRecord["resolvedAs"] = null;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "approval_request") {
      const recorded = readRecord(readRecord(event.detail)?.request);
      const recordedItemId = typeof recorded?.itemId === "string" && recorded.itemId.trim().length
        ? recorded.itemId.trim()
        : event.itemId;
      if (recordedItemId !== itemId) continue;
      // A re-raised card supersedes its own earlier receipt.
      request = readPendingInputRequest(recorded) ?? request;
      resolvedAs = null;
      continue;
    }
    if (event.type === "pending_input_resolved" && event.itemId === itemId) {
      resolvedAs = event.resolution;
    }
  }
  return { request, resolvedAs };
}

/**
 * Question shapes whose answer is prose a model can simply read.
 *
 * A secret question is excluded even though it is a question: its answer
 * reaches the provider over the request it was asked on and is deliberately
 * kept out of the durable transcript (`sanitizeAnswersForTranscript` drops
 * it). Re-routing one as a `user_message` would write the credential into
 * the transcript and sync it to every paired device, so a secret whose
 * asker is gone is a dead card rather than a message.
 */
export function isQuestionShapedPendingInput(request: PendingInputRequest | null): boolean {
  if (request?.kind !== "question" && request?.kind !== "structured_question") return false;
  return !(request.questions ?? []).some((question) => question.isSecret === true);
}
