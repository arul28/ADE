import { describe, expect, it } from "vitest";

import { createResponseQueue } from "./ctoVoiceResponseQueue";
import {
  askCto,
  createService,
  functionOutputs,
  openCall,
  spoken,
  tick,
} from "./ctoVoiceCallHarness";

/**
 * One response at a time, and which side asked for it.
 *
 * The Realtime API allows exactly one response to be generating, so everything
 * ADE asks to have said goes through one lock. What these cases are about is
 * what happens at the edges of that lock: a line held behind a response in
 * flight, a barge-in that lands before the server has named what it is
 * cancelling, and a create the server refuses outright.
 */

describe("the response lock", () => {
  /**
   * One response at a time is an API rule, not a style choice: a second
   * `response.create` while one is generating is answered with an error instead
   * of with speech, so the line would simply never be heard.
   */
  it("holds one of ADE's own lines until the response in flight is over", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });

    expect(spoken(harness.fake)).toEqual([]);

    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    expect(spoken(harness.fake)).toHaveLength(1);
    expect(spoken(harness.fake)[0]).toContain("didn't catch that");
  });

  /**
   * Barge-in is split now, and this is the half that is NOT ours.
   *
   * The session runs with `interrupt_response: true`, so the server truncates
   * its own response the moment it hears speech — a round trip sooner than ADE
   * could, and sending our own cancel at it as well races that truncation and
   * comes back as "no active response".
   */
  it("leaves a server response for the server to truncate", async () => {
    const harness = createService();
    await openCall(harness);
    // A response the SERVER created: nothing ADE sent asked for it.
    harness.fake.receive({ type: "response.created", response: { id: "resp_model" } });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });

    expect(harness.fake.typesSent()).not.toContain("response.cancel");
    expect(harness.latest().interrupted).toBe(true);
  });

  /**
   * And this is the half that IS ours, and why the work behind it keeps going.
   *
   * Talking while the CTO works is ordinary on a hybrid call — a follow-up, or
   * thinking out loud — so killing the turn for it would make the call
   * unusable. Work stops two ways and only two: `cancel_work`, and a new
   * `ask_cto` superseding it.
   */
  it("stops ADE's own line but not the work behind it", async () => {
    const seenSignal: { current: AbortSignal | null } = { current: null };
    let releaseBackend: () => void = () => {};
    const harness = createService({
      runBackendTurn: async ({ signal }) => {
        seenSignal.current = signal;
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "An answer." };
      },
    });
    await openCall(harness);
    askCto(harness, "run the tests");
    await tick();
    // ADE says something of its own, and the server names that response.
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    harness.fake.receive({ type: "response.created", response: { id: "resp_ade" } });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });

    const cancel = harness.fake.lastOfType("response.cancel") as Record<string, unknown>;
    expect(cancel).toBeTruthy();
    // A cancel has to NAME the response: a bare one is understood as "cancel
    // the response in the DEFAULT conversation", where an out-of-band one never
    // is, and every barge-in failed silently while the CTO talked on.
    expect(cancel.response_id).toBe("resp_ade");
    expect(seenSignal.current?.aborted).toBe(false);
    expect(harness.latest().interrupted).toBe(true);
    // Still thinking, because the work is still running.
    expect(harness.latest().phase).toBe("thinking");

    // And a cancelled response releases the lock exactly like a completed one.
    harness.fake.receive({ type: "response.done", response: { status: "cancelled" } });
    releaseBackend();
    await tick();
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "ok", answer: "An answer." });
  });

  /**
   * `response.create` and `response.created` are a round trip apart, and the
   * user can talk inside it. Dropping the cancel there loses the one thing a
   * call must always honour, so it waits for the name instead.
   */
  it("holds a barge-in that arrived before the response had a name, and sends it when it does", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });

    // The line has been asked for, and the server has not named it yet.
    expect(harness.fake.typesSent()).toContain("response.create");
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.fake.typesSent()).not.toContain("response.cancel");

    harness.fake.receive({ type: "response.created", response: { id: "resp_late" } });

    const cancel = harness.fake.lastOfType("response.cancel") as Record<string, unknown>;
    expect(cancel).toBeTruthy();
    expect(cancel.response_id).toBe("resp_late");
    // And only once: the flag is cleared, so the next response is not cancelled
    // by an interruption the user already made.
    harness.fake.receive({ type: "response.done", response: { status: "cancelled" } });
    harness.fake.receive({ type: "response.created", response: { id: "resp_next" } });
    expect(harness.fake.sent.filter((message) => message.type === "response.cancel"))
      .toHaveLength(1);
  });

  it("does not cancel a response that is not running", async () => {
    // `response.cancel` with nothing in flight is an error event, and an error
    // event is a banner over a call that is working perfectly.
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.fake.typesSent()).not.toContain("response.cancel");
  });
});

/**
 * The two errors this service's own timing causes, and why they are not one.
 *
 * Both are benign and neither is worth a banner, but they say opposite things
 * about the response lock — and treating them the same burned the whole queue.
 */
describe("the benign server errors", () => {
  /** Two lines ADE wrote: one in flight, one behind it. */
  async function twoQueuedLines() {
    const harness = createService();
    await openCall(harness);
    harness.service.raiseApproval({ itemId: "a", toolName: "openPr", prompt: "First question?" });
    harness.service.raiseApproval({ itemId: "b", toolName: "openPr", prompt: "Second question?" });
    return harness;
  }

  it("releases the lock when a cancel arrived after the response was over", async () => {
    const harness = await twoQueuedLines();
    expect(spoken(harness.fake)).toHaveLength(1);

    harness.fake.receive({
      type: "error",
      error: { message: "Cancellation failed: no active response found" },
    });

    // The lock was stale, so the line waiting behind it goes now.
    expect(spoken(harness.fake).join("\n")).toContain("Second question?");
    expect(harness.latest().error).toBeNull();
  });

  it("keeps the line, and the lock, when the server is still generating", async () => {
    const harness = await twoQueuedLines();

    harness.fake.receive({
      type: "error",
      error: { message: "Conversation already has an active response" },
    });
    // Nothing else is sent into a server that just said it is busy.
    expect(spoken(harness.fake)).toHaveLength(1);

    // And when its own response finishes, the refused line is asked for again,
    // ahead of the one that was queued behind it.
    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_server", status: "completed", output: [] },
    });
    const asked = spoken(harness.fake);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("First question?");

    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_first", status: "completed", output: [] },
    });
    expect(spoken(harness.fake)[2]).toContain("Second question?");
  });
});

describe("a create the server refused", () => {
  function createQueue() {
    const sent: Array<Record<string, unknown>> = [];
    const queue = createResponseQueue({ send: (payload) => sent.push(payload), isOpen: () => true });
    return { queue, sent };
  }

  it("puts back exactly the line that was refused, and nothing else", () => {
    const { queue, sent } = createQueue();
    queue.speak("Shall I open the PR?");
    expect(sent).toHaveLength(1);

    queue.requeueRefused();
    // The lock is still real: nothing goes out until the response in flight is
    // over, and then the refused line — not a fresh one — is what is said.
    expect(sent).toHaveLength(1);
    queue.release();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toContain("Shall I open the PR?");
  });

  it("stops claiming the refusing response as ADE's own", () => {
    const { queue, sent } = createQueue();
    queue.speak("Shall I open the PR?");
    queue.requeueRefused();

    // The response that refused us is the SERVER's, and the server truncates
    // its own on a barge-in. Leaving the flag set had the next `response.created`
    // recorded as ADE's, and the barge-in then raced that truncation with a
    // cancel of its own.
    queue.noteCreated("resp_server");
    sent.length = 0;
    queue.stopSpeaking();
    expect(sent).toHaveLength(0);
  });
});

