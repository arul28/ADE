import { describe, expect, it } from "vitest";

import { askCto, createService, functionOutputs, openCall, tick } from "./ctoVoiceCallHarness";

/**
 * The ledger of function calls a session has in flight.
 *
 * Every case here is about WHEN a result may go on the wire. An output naming a
 * `call_id` the conversation has not finished writing is refused outright, and
 * a result that waits for a name that never arrives is never spoken at all —
 * the two failures are opposites and the ledger has to avoid both.
 */

describe("a call the model made", () => {
  /**
   * A function result may only be written once the response that asked for it
   * is finished. The fast tools answer a beat before that — they are dispatched
   * off `response.function_call_arguments.done` — and an output naming a
   * `call_id` the conversation has not finished writing is refused.
   */
  it("holds a function result until the response that asked for it is done", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "response.created", response: { id: "resp_fn" } });
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      name: "cancel_work",
      call_id: "call_c",
      arguments: "{}",
    });
    expect(functionOutputs(harness.fake)).toEqual([]);

    harness.fake.receive({ type: "response.done", response: { id: "resp_fn", status: "completed" } });
    expect(functionOutputs(harness.fake)).toEqual([{ status: "nothing_running" }]);
  });

  /**
   * The same call arrives twice: once as `response.function_call_arguments.done`
   * and again inside `response.done`'s output list. Both are handled, because
   * which one a surface sends is not a thing to guess at — so the `call_id` is
   * what stops one request running the CTO twice.
   */
  it("runs one function call exactly once, however many times it is delivered", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      name: "ask_cto",
      call_id: "call_1",
      arguments: JSON.stringify({ request: "how many lanes" }),
    });
    askCto(harness, "how many lanes", { callId: "call_1" });
    await tick();
    expect(seen).toEqual(["how many lanes"]);
  });
});

describe("a function result waiting on the response that asked for it", () => {
  it("waits for ITS OWN response to finish, not for any response at all", async () => {
    const harness = createService();
    await openCall(harness);

    // The call arrives a beat before its own `response.done`, so the
    // conversation has not written it yet and its result has to wait.
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      response_id: "resp_tool",
      call_id: "call_tool",
      name: "cancel_work",
      arguments: "{}",
    });
    expect(functionOutputs(harness.fake)).toHaveLength(0);

    // A DIFFERENT response finishing says nothing about this call: the old code
    // cleared every unsettled id here and handed the result over early, where
    // OpenAI refuses it for naming a `call_id` it has not written.
    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_other", status: "completed", output: [] },
    });
    expect(functionOutputs(harness.fake)).toHaveLength(0);

    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_tool", status: "completed", output: [] },
    });
    expect(functionOutputs(harness.fake)).toHaveLength(1);
  });
});

describe("a response that finished without naming itself", () => {
  it("releases everything it was holding, rather than stranding it forever", async () => {
    const harness = createService();
    await openCall(harness);

    // The call names the response that made it, so its result waits.
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      response_id: "resp_tool",
      call_id: "call_tool",
      name: "cancel_work",
      arguments: "{}",
    });
    expect(functionOutputs(harness.fake)).toHaveLength(0);

    // A done with no `response.id` on it is the only done this call will ever
    // see for what it was generating. Matching on the id alone left the result
    // waiting for a name that was never coming, and the model went on referring
    // to a `function_call` it never saw answered.
    harness.fake.receive({ type: "response.done", response: { status: "completed", output: [] } });
    expect(functionOutputs(harness.fake)).toHaveLength(1);
  });
});

