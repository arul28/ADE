import { randomUUID } from "node:crypto";

/**
 * The ledger of function calls a realtime session has in flight.
 *
 * Three facts about one `call_id`, which is why they belong together rather
 * than as three variables in the call service's closure: whether the call has
 * already been dispatched, whether the response that MADE it has finished, and
 * whether its result is still waiting on that. Every one of them is read or
 * written on the same two events, and getting any of them wrong shows up as the
 * same symptom — a `function_call` the conversation never sees answered, which
 * the model then talks around for the rest of the call.
 *
 * Nothing here knows about tools, phases or the CTO: it is given a `call_id`
 * and a result and it decides WHEN the result may go on the wire.
 */
export type CtoVoiceFunctionCallLedger = ReturnType<typeof createFunctionCallLedger>;

export function createFunctionCallLedger(deps: {
  send: (payload: Record<string, unknown>) => void;
  /** Ask the model to speak about a result it is worth hearing about. */
  requestModelResponse: () => void;
}) {
  /**
   * Calls already dispatched, by `call_id`.
   *
   * The same call arrives twice: once inside `response.done`'s output list and
   * once as `response.function_call_arguments.done`. Both are handled — one
   * socket's vocabulary is not a thing to guess at — so the id is what stops a
   * request running twice.
   */
  const handled = new Set<string>();

  /**
   * Calls dispatched before the response that made them was finished.
   *
   * `response.function_call_arguments.done` arrives first, which is worth
   * having on a five-second turn — but the conversation has not written the
   * call yet, so its result has to wait for `response.done`.
   *
   * Keyed to the response that MADE each call (`call_id` → `response_id`), so a
   * `response.done` only releases its own: clearing the lot on any done let a
   * result out while the response that asked for it was still generating, and
   * an output naming a `call_id` the conversation has not written is refused.
   * A call that arrived without a response id maps to null and is released by
   * the first done, because nothing else will ever name it.
   */
  const unsettled = new Map<string, string | null>();

  /**
   * Results that cannot be sent yet.
   *
   * See `answer`: a result may only be written once the response that asked for
   * it is finished, and the fast tools answer before it is.
   */
  let pending: Array<{
    callId: string;
    output: Record<string, unknown>;
    speakResult: boolean;
  }> = [];

  const write = (callId: string, output: Record<string, unknown>): void => {
    deps.send({
      type: "conversation.item.create",
      event_id: randomUUID(),
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
  };

  return {
    /**
     * This call is ours to run — or it is a redelivery of one already running.
     *
     * Returns false for both the duplicate and the call with no id, because
     * neither can be answered: an output has to name the call it belongs to.
     */
    claim(callId: string): boolean {
      if (!callId || handled.has(callId)) return false;
      handled.add(callId);
      return true;
    },

    /** This call was dispatched before its own response finished. */
    noteUnsettled(callId: string, responseId: string | null): void {
      unsettled.set(callId, responseId);
    },

    /**
     * Hand a function's result back and, when it is worth hearing, let the
     * model speak about it.
     *
     * `speakResult: false` is for the results nobody is waiting on: an
     * `ask_cto` that was superseded or cancelled still has to answer its call —
     * an unanswered `function_call` sits in the conversation forever and the
     * model keeps referring to it — but asking for a response about it would
     * have the model narrate a question the user has already moved past.
     */
    answer(callId: string, output: Record<string, unknown>, speakResult = true): void {
      // Never while the response that MADE this call is still generating. An
      // output naming a `call_id` the conversation has not finished writing is
      // refused, and that is exactly the case for a call dispatched off
      // `response.function_call_arguments.done` — a beat before its own
      // `response.done`. Any other response being in flight is irrelevant: a
      // conversation item is appended, not generated.
      if (unsettled.has(callId)) {
        pending.push({ callId, output, speakResult });
        return;
      }
      write(callId, output);
      if (speakResult) deps.requestModelResponse();
    },

    /**
     * A response finished: everything it was still writing is now written.
     *
     * A response that named itself releases only its own calls, and the ones
     * that never had a response id at all — nothing else will ever name those.
     * A response that named NOTHING releases everything: it is the only done
     * this call will see for whatever it was generating, so holding an id-owned
     * result back for a name that is never coming strands it forever.
     */
    settle(responseId: string | null): void {
      for (const [callId, owner] of [...unsettled]) {
        if (responseId === null || owner === null || owner === responseId) unsettled.delete(callId);
      }
      const waiting = pending;
      // Only the ones whose own response has finished. A result still owed to a
      // response that is generating stays where it is, or it is refused for
      // naming a `call_id` the conversation has not written yet.
      pending = waiting.filter((entry) => unsettled.has(entry.callId));
      for (const entry of waiting) {
        if (unsettled.has(entry.callId)) continue;
        write(entry.callId, entry.output);
        if (entry.speakResult) deps.requestModelResponse();
      }
    },

    /** The socket is gone: nothing queued can be written to it. */
    dropPendingOutputs(): void {
      pending = [];
    },

    /** A call is starting: none of the last one's calls belong to it. */
    reset(): void {
      handled.clear();
      unsettled.clear();
      pending = [];
    },
  };
}
