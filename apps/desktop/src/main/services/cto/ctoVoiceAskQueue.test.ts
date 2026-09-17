import { describe, expect, it } from "vitest";

import { createFakeSocket } from "./ctoVoiceTestDoubles";
import {
  askCto,
  callTool,
  createService,
  functionOutputs,
  hearMic,
  modelResponses,
  openCall,
  tick,
  utter,
} from "./ctoVoiceCallHarness";

/**
 * Two requests at once, and who decides what happens to the first.
 *
 * Both used to be lost: the second one's `runSessionTurn` was attempted before
 * the first had been interrupted, threw "Session already has an active
 * background turn", and the abort landed three milliseconds later. The user
 * heard that the CTO could not be reached, twice.
 */
describe("two requests at once", () => {
  /**
   * A harness whose backend records when each turn starts and finishes, and
   * releases them one at a time.
   */
  function createSerialHarness() {
    const events: string[] = [];
    const release = new Map<string, () => void>();
    const harness = createService({
      backchannelsEnabled: () => false,
      runBackendTurn: async ({ intent, signal }) => {
        const name = intent.split(" ")[0] ?? intent;
        events.push(`start:${name}`);
        await new Promise<void>((resolve) => release.set(name, resolve));
        events.push(`end:${name}`);
        if (signal.aborted) return { spoken: "", status: "interrupted" as const };
        return { spoken: `${name} answer` };
      },
    });
    return {
      ...harness,
      events,
      finish: async (name: string) => {
        release.get(name)?.();
        await tick();
      },
    };
  }

  it("replaces the running request, and does not start the new one until it has unwound", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A the open PRs", { callId: "call_a" });
    await tick();
    expect(harness.events).toEqual(["start:A"]);

    askCto(harness, "B no wait the merged ones", { callId: "call_b", mode: "replace" });
    await tick();
    // The correction does NOT start here. The aborted turn is still unwinding
    // on the one CTO session, and starting on top of it is the bug.
    expect(harness.events).toEqual(["start:A"]);

    await harness.finish("A");
    expect(harness.events).toEqual(["start:A", "end:A", "start:B"]);

    await harness.finish("B");
    const results = functionOutputs(harness.fake);
    expect(results).toContainEqual({ status: "superseded", answer: "" });
    expect(results).toContainEqual({ status: "ok", answer: "B answer" });
    // Only the surviving answer is spoken about.
    expect(modelResponses(harness.fake)).toBe(1);
  });

  it("queues an additional request and answers both, in order", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A the open PRs", { callId: "call_a" });
    await tick();
    askCto(harness, "B run the tests", { callId: "call_b", mode: "queue" });
    await tick();
    // Queued, not started: the CTO thread is one session.
    expect(harness.events).toEqual(["start:A"]);

    await harness.finish("A");
    expect(harness.events).toEqual(["start:A", "end:A", "start:B"]);
    // A's answer is being relayed; one response at a time, so B's relay waits
    // for it exactly as any other queued response does.
    expect(modelResponses(harness.fake)).toBe(1);
    await harness.finish("B");
    harness.fake.receive({ type: "response.done", response: { id: "resp_relay_a", status: "completed", output: [] } });
    await tick();

    expect(functionOutputs(harness.fake)).toEqual([
      { status: "ok", answer: "A answer" },
      { status: "ok", answer: "B answer" },
    ]);
    // Each answer is relayed on its own, as it lands.
    expect(modelResponses(harness.fake)).toBe(2);
  });

  it("refuses a third waiting request rather than stacking it", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    askCto(harness, "B two", { callId: "call_b", mode: "queue" });
    askCto(harness, "C three", { callId: "call_c", mode: "queue" });
    askCto(harness, "D four", { callId: "call_d", mode: "queue" });
    await tick();

    const busy = functionOutputs(harness.fake).filter((row) => row.status === "busy");
    expect(busy).toHaveLength(1);
    expect(String(busy[0]!.reason)).toContain("already waiting");
    expect(harness.events).toEqual(["start:A"]);
  });

  it("treats a request with no usable mode as an additional one", async () => {
    // Nothing is thrown away by guessing "queue": the worst case is an answer
    // a few seconds late. Guessing "replace" throws a running turn's work out.
    const harness = createSerialHarness();
    await openCall(harness);
    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    harness.fake.receive({
      type: "response.done",
      response: {
        id: "resp_nomode",
        status: "completed",
        output: [{
          type: "function_call",
          name: "ask_cto",
          call_id: "call_b",
          arguments: JSON.stringify({ request: "B two" }),
        }],
      },
    });
    await tick();
    expect(harness.events).toEqual(["start:A"]);
    await harness.finish("A");
    expect(harness.events).toContain("start:B");
    await harness.finish("B");
  });

  it("cancel_work stops the running request and drops the queue", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    askCto(harness, "B two", { callId: "call_b", mode: "queue" });
    await tick();

    callTool(harness, "cancel_work", "call_cancel");
    await tick();
    // The queued one is answered immediately — an unanswered `function_call`
    // sits in the conversation forever — and never runs.
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "cancelled", answer: "" });

    await harness.finish("A");
    expect(harness.events).toEqual(["start:A", "end:A"]);
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "cancelled" });
  });

  /**
   * Hang-up stops the queue, not just the turn that is running.
   *
   * The drain loop reads the queue again the moment the aborted turn unwinds,
   * which is after the call is over: a request left there is a full CTO turn —
   * its own session, its own tools — run for a call the user has hung up.
   */
  it("a queued request does not run after hang-up", async () => {
    const harness = createSerialHarness();
    await openCall(harness);

    askCto(harness, "A one", { callId: "call_a" });
    await tick();
    askCto(harness, "B two", { callId: "call_b", mode: "queue" });
    await tick();
    expect(harness.events).toEqual(["start:A"]);

    await harness.service.end("owner_end");
    // The aborted turn unwinds AFTER the call ended, which is where the loop
    // picks the queue back up.
    await harness.finish("A");

    expect(harness.events).toEqual(["start:A", "end:A"]);
  });

  /**
   * A new call does not inherit the last one's drain loop.
   *
   * The loop's "I own this" flag lives on the per-call record, so a new call
   * clears it while the old loop is still awaiting an aborted turn. The new
   * call then starts a loop of its own, the old one wakes up on the new call's
   * queue, and two turns run on the one CTO session.
   */
  it("a new call does not start a second drain loop", async () => {
    const events: string[] = [];
    const release = new Map<string, () => void>();
    const sockets = [createFakeSocket(), createFakeSocket()];
    let index = 0;
    const harness = createService({
      backchannelsEnabled: () => false,
      createWebSocket: () => sockets[index]!.socket,
      runBackendTurn: async ({ intent, signal }) => {
        const name = intent.split(" ")[0] ?? intent;
        events.push(`start:${name}`);
        await new Promise<void>((resolve) => release.set(name, resolve));
        events.push(`end:${name}`);
        if (signal.aborted) return { spoken: "", status: "interrupted" as const };
        return { spoken: `${name} answer` };
      },
    });
    const first = { ...harness, fake: sockets[0]! };
    await openCall(first);
    askCto(first, "A one", { callId: "call_a" });
    await tick();
    await harness.service.end("owner_end");

    index = 1;
    const second = { ...harness, fake: sockets[1]! };
    await openCall(second);
    askCto(second, "B two", { callId: "call_b" });
    await tick();
    askCto(second, "C three", { callId: "call_c", mode: "queue" });
    await tick();
    expect(events).toEqual(["start:A", "start:B"]);

    // The first call's loop wakes up here, with the second call's queue in
    // front of it and that call's own turn still running.
    release.get("A")?.();
    await tick();

    expect(events).toEqual(["start:A", "start:B", "end:A"]);
    release.get("B")?.();
    await tick();
    await harness.service.end("owner_end");
  });
});

it("accepts a spoken yes from the utterance after the question", async () => {
  const harness = createService();
  await openCall(harness);

  utter(harness, "open a pr for the sync lane");
  await tick();
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
  expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");

  utter(harness, "yes");
  await tick();
  expect(harness.latest().pendingConfirmation).toBeNull();
});

it("never lets the utterance that raised a question also answer it", async () => {
  const harness = createService();
  await openCall(harness);

  // One utterance that both asks and sounds like consent. The approval lands
  // while that turn is still open, so it is bound to the same utterance id.
  harness.fake.receive({ type: "input_audio_buffer.speech_started" });
  hearMic(harness);
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
  harness.fake.receive({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "open a pr, yes do it",
  });
  await tick();
  expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
});

it("refuses a second ask_cto while one is parked on a confirmation", async () => {
  // The turn that raised the question is still inside `canUseTool`. A second
  // turn on the same session would collide with it, so the model is told the
  // seam is busy rather than being allowed to open one.
  const intents: string[] = [];
  const harness = createService({
    runBackendTurn: async ({ intent }) => { intents.push(intent); return { spoken: "ok" }; },
  });
  await openCall(harness);
  askCto(harness, "open a pr for the sync lane", { callId: "call_1" });
  await tick();
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request?" });

  askCto(harness, "what time is it", { callId: "call_2" });
  await tick();

  expect(intents).toEqual(["open a pr for the sync lane"]);
  expect(functionOutputs(harness.fake).at(-1)).toMatchObject({ status: "busy", answer: "" });
  expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
});

/**
 * Two things hear the same "yes" now: the transcript parser, and the model
 * calling `approve_pending_action`. Whichever lands first decides; the second
 * must be a no-op rather than a second decision on a gate that is already open.
 */
it("lets the model approve a pending action, once, however many hear the yes", async () => {
  const resolved: Array<{ itemId: string; approved: boolean }> = [];
  const harness = createService({
    resolveApproval: async (args: { itemId: string; approved: boolean }) => { resolved.push(args); },
  });
  await openCall(harness);
  harness.fake.receive({ type: "input_audio_buffer.speech_started" });
  harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request?" });
  // The model is told, silently, that a question is open — without that it
  // hears the user say "yes" to nothing it can see.
  const note = harness.fake.sent
    .filter((message) => message.type === "conversation.item.create")
    .map((message) => JSON.stringify(message.item))
    .join("\n");
  expect(note).toContain("approve_pending_action");

  callTool(harness, "approve_pending_action", "call_a");
  await tick();
  // And again, as the parser would: the same spoken word, heard twice.
  utter(harness, "yes");
  await tick();

  expect(resolved).toEqual([{ itemId: "item-1", approved: true }]);
  expect(functionOutputs(harness.fake)).toContainEqual({ status: "ok" });
});

it("will not let the model approve a destructive action either", async () => {
  const resolved: Array<{ itemId: string; approved: boolean }> = [];
  const harness = createService({
    resolveApproval: async (args: { itemId: string; approved: boolean }) => { resolved.push(args); },
  });
  await openCall(harness);
  harness.fake.receive({ type: "input_audio_buffer.speech_started" });
  harness.service.raiseApproval({
    itemId: "item-1",
    toolName: "gitForcePush",
    prompt: "Force-push ade/sync-fix?",
  });

  callTool(harness, "approve_pending_action", "call_a");
  await tick();

  expect(resolved).toEqual([]);
  expect(harness.latest().pendingConfirmation?.id).toBeTruthy();
  expect(functionOutputs(harness.fake).at(-1)).toMatchObject({ status: "needs_tap" });
});