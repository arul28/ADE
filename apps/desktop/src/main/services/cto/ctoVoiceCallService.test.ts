import { describe, expect, it, vi } from "vitest";
import type {
  CtoVoiceApprovalNotice,
  CtoVoiceBackendResult,
} from "./ctoVoiceCallService";
import {
  CTO_VOICE_END_CALL_AUDIO_TAIL_MS,
  CTO_VOICE_MODEL,
  CTO_VOICE_SAMPLE_RATE,
  CTO_VOICE_TRANSCRIBE_LANGUAGE,
  CTO_VOICE_TRANSCRIBE_MODEL,
  CTO_VOICE_TRANSCRIBE_PROMPT,
  ctoVoiceStatusLine,
  ctoVoiceTranscriptHasSpeech,
} from "../../../shared/types/ctoVoice";
import { createFakeSocket } from "./ctoVoiceTestDoubles";
import {
  askCto,
  callTool,
  createService,
  functionOutputs,
  hearMic,
  modelResponses,
  openCall,
  spoken,
  tick,
  utter,
} from "./ctoVoiceCallHarness";

describe("createCtoVoiceCallService", () => {
  it("refuses to start without a key, and says so", async () => {
    const { service, latest } = createService({ getApiKey: async () => null });
    const result = await service.start();
    expect(result).toEqual({ ok: false, error: "missing-key" });
    expect(latest().phase).toBe("failed");
    expect(latest().error).toContain("API key");
  });

  it("opens the realtime endpoint with the model as its one query parameter", async () => {
    const urls: string[] = [];
    const fake = createFakeSocket();
    const { service } = createService({
      createWebSocket: (url: string) => { urls.push(url); return fake.socket; },
    });
    await service.start();
    expect(urls).toEqual([`wss://api.openai.com/v1/realtime?model=${CTO_VOICE_MODEL}`]);
  });

  /**
   * The event that decides whether this is a CTO call or a chat with a
   * stranger. The model composes its own speech now — it has to, or a call
   * cannot be a conversation — so what keeps it honest is the tool list and
   * the instruction that
   * goes with it: it may answer from its context and it may not invent a
   * project fact. If `tools` ever goes missing from this event, the model has
   * no way to reach the CTO at all and will answer everything itself.
   */
  it("configures the session as a conversational front with one seam to the CTO", async () => {
    const harness = createService({
      voice: () => "cedar",
      context: async () => "Who you are\n- Name: Ada",
    });
    await harness.service.start();
    harness.fake.open();

    const update = harness.fake.lastOfType("session.update") as Record<string, any>;
    expect(update).toBeTruthy();
    expect(update.session.type).toBe("realtime");
    expect(update.session.output_modalities).toEqual(["audio"]);
    expect(update.session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      create_response: true,
      interrupt_response: true,
    });
    // The five functions, and nothing else: everything a call can DO happens on
    // the other side of `ask_cto`.
    expect(update.session.tool_choice).toBe("auto");
    // Written out rather than compared to a constant: a list checked against
    // itself agrees with any change, including one that takes a tool away.
    expect((update.session.tools as Array<{ name: string }>).map((tool) => tool.name))
      .toEqual(["ask_cto", "cancel_work", "approve_pending_action", "deny_pending_action", "end_call"]);
    // The context block rides in the session prompt, so the model can answer
    // "who are you" without a round trip through the CTO thread.
    expect(String(update.session.instructions)).toContain("- Name: Ada");
    // Without transcription there are no captions and no spoken yes/no, and
    // without a language the transcriber guesses per utterance — which is how a
    // phantom "好" reached the CTO and came back as a reply in Chinese.
    expect(update.session.audio.input.transcription).toEqual({
      model: CTO_VOICE_TRANSCRIBE_MODEL,
      language: CTO_VOICE_TRANSCRIBE_LANGUAGE,
      prompt: CTO_VOICE_TRANSCRIBE_PROMPT,
    });
    expect(update.session.audio.input.format)
      .toEqual({ type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE });
    expect(update.session.audio.output.format)
      .toEqual({ type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE });
    expect(update.session.audio.output.voice).toBe("cedar");
    // Nothing in the session names a backend model — that is what keeps the
    // CTO's own thinking on whatever plan it already runs on.
    expect(JSON.stringify(update.session)).not.toContain("responses");
  });

  it("starts the clock when OpenAI answers with a session", async () => {
    const harness = createService();
    await harness.service.start();
    harness.fake.open();
    expect(harness.latest().phase).toBe("connecting");
    harness.fake.receive({ type: "session.created", session: { id: "sess_1" } });
    expect(harness.latest().phase).toBe("listening");
  });

  it("sends microphone audio as input_audio_buffer.append", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.sent.length = 0;
    harness.service.pushAudio("AAAA");
    const appended = harness.fake.sent.filter((m) => m.type === "input_audio_buffer.append");
    expect(appended.map((m) => m.audio)).toEqual(["AAAA"]);
  });

  /**
   * A plain transcript is no longer an instruction to anyone.
   *
   * Under the old protocol every accepted transcript became a CTO turn, which
   * is what made "hello" cost three to five seconds. The model hears the audio
   * itself now and decides; ADE only writes the caption down.
   */
  it("never starts a CTO turn from a transcript alone", async () => {
    const intents: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { intents.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    utter(harness, "hello, who are you");
    await tick();

    expect(intents).toEqual([]);
    expect(spoken(harness.fake)).toEqual([]);
    // The caption is still written: the call record is what the gate guards.
    expect(harness.latest().captions.map((caption) => caption.text))
      .toEqual(["hello, who are you"]);
  });

  it("says nothing of its own while the CTO works", async () => {
    const order: string[] = [];
    let releaseBackend: () => void = () => {};
    const harness = createService({
      runBackendTurn: async () => {
        order.push("backend-started");
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "Three merged yesterday." };
      },
    });
    await openCall(harness);
    askCto(harness, "how many lanes do we have");
    await tick();

    // The acknowledgement is the MODEL's, said in the same turn as the call —
    // ADE has no line here, and a fixed filler is exactly what the owner hated.
    expect(spoken(harness.fake)).toEqual([]);
    expect(order).toEqual(["backend-started"]);
    expect(harness.latest().phase).toBe("thinking");
    releaseBackend();
  });

  it("hands the answer back as a function result and lets the model speak it", async () => {
    const harness = createService();
    await openCall(harness);
    askCto(harness, "how many lanes do we have");
    await tick();

    expect(functionOutputs(harness.fake))
      .toEqual([{ status: "ok", answer: "Three merged yesterday." }]);
    // Asked for IN the conversation, deliberately: the model has to see the
    // call it made in order to relay the answer to it.
    expect(modelResponses(harness.fake)).toBe(1);
    expect(spoken(harness.fake)).toEqual([]);
  });

  /**
   * Cheap and worth it: the facts in the context block are exactly the ones a
   * turn is most likely to have just changed, and a model answering "nine
   * lanes" straight after creating the tenth is worse than one that asks.
   */
  it("re-sends the context block after a completed ask_cto", async () => {
    let contexts = 0;
    const harness = createService({
      context: async () => `Who you are\n- Name: Ada (read ${(contexts += 1)})`,
    });
    await openCall(harness);
    expect(harness.fake.sent.filter((message) => message.type === "session.update")).toHaveLength(1);

    askCto(harness, "how many lanes do we have");
    await tick();
    await tick();

    const updates = harness.fake.sent.filter((message) => message.type === "session.update");
    expect(updates).toHaveLength(2);
    expect(String((updates[1]!.session as Record<string, unknown>).instructions))
      .toContain("- Name: Ada (read 2)");
  });

  it("does not refresh the context for a turn that was superseded", async () => {
    let contexts = 0;
    const release: Array<() => void> = [];
    const harness = createService({
      context: async () => `Who you are\n- Name: Ada (read ${(contexts += 1)})`,
      runBackendTurn: async ({ intent }: { intent: string }) => {
        if (intent.includes("first")) {
          await new Promise<void>((r) => release.push(r));
          return { spoken: "STALE" };
        }
        return { spoken: "FRESH" };
      },
    });
    await openCall(harness);
    askCto(harness, "the first question", { callId: "call_1" });
    await tick();
    askCto(harness, "the second question", { callId: "call_2" });
    await tick();
    await tick();
    release.forEach((fn) => fn());
    await tick();
    await tick();

    // One refresh, for the turn that actually answered.
    expect(harness.fake.sent.filter((message) => message.type === "session.update"))
      .toHaveLength(2);
  });

  /**
   * The two response shapes, and why they are not one.
   *
   * ADE's own lines must be read word for word, and inside the conversation the
   * user's audio outweighs the instruction: measured against the live API on
   * 2026-09-16, 6 of 8 in-conversation read-alouds were hijacked into
   * self-answers ("I'm ChatGPT…") and out-of-band read 24 of 24 word for word.
   * A function result is the opposite case — out-of-band it would be generated
   * with no conversation at all, so the model would have nothing to relay.
   */
  it("keeps ADE's own lines out-of-band and the function result in conversation", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    const ade = harness.fake.sent
      .filter((message) => message.type === "response.create")
      .map((message) => message.response as Record<string, unknown> | undefined)
      .filter((response): response is Record<string, unknown> => response !== undefined);
    expect(ade).toHaveLength(1);
    expect(ade[0]!.conversation).toBe("none");
    expect(ade[0]!.input).toEqual([]);
    expect(String(ade[0]!.instructions)).toContain("word for word");

    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    askCto(harness, "how many lanes do we have");
    await tick();
    expect(modelResponses(harness.fake)).toBe(1);
  });


  it("stops the running work on cancel_work, and says nothing_running when there is none", async () => {
    const seenSignal: { current: AbortSignal | null } = { current: null };
    let releaseBackend: () => void = () => {};
    const harness = createService({
      runBackendTurn: async ({ signal }) => {
        seenSignal.current = signal;
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "STALE ANSWER" };
      },
    });
    await openCall(harness);
    askCto(harness, "run the tests");
    await tick();
    expect(seenSignal.current?.aborted).toBe(false);

    callTool(harness, "cancel_work", "call_cancel");
    await tick();
    expect(seenSignal.current?.aborted).toBe(true);
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "cancelled" });
    expect(harness.latest().phase).toBe("listening");

    releaseBackend();
    await tick();
    // The stale answer answers its own call so the conversation is not left
    // dangling, and nobody is asked to speak about it.
    expect(functionOutputs(harness.fake)).toContainEqual({ status: "superseded", answer: "" });
    expect(modelResponses(harness.fake)).toBe(1);

    callTool(harness, "cancel_work", "call_cancel_2");
    await tick();
    expect(functionOutputs(harness.fake).at(-1)).toEqual({ status: "nothing_running" });
  });


  it("asks the CTO exactly what the model passed, in the user's own words", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    askCto(harness, "what is the status of the PRs");
    await tick();
    expect(seen).toEqual(["what is the status of the PRs"]);
  });

  it("refuses an empty request rather than asking the CTO nothing", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    harness.fake.receive({
      type: "response.done",
      response: {
        id: "resp_fn",
        status: "completed",
        output: [{ type: "function_call", name: "ask_cto", call_id: "call_1", arguments: "{}" }],
      },
    });
    await tick();
    expect(seen).toEqual([]);
    expect(functionOutputs(harness.fake)[0]).toMatchObject({ status: "failed" });
  });


  it("says it did not catch a turn the transcriber could not read", async () => {
    const seen: string[] = [];
    const harness = createService({
      runBackendTurn: async ({ intent }) => { seen.push(intent); return { spoken: "ok" }; },
    });
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    await tick();

    // No turn was burned on a question nobody could read...
    expect(seen).toEqual([]);
    // ...and the call did not simply go quiet.
    expect(spoken(harness.fake).join("\n")).toContain("didn't catch that");
  });

  it("holds a mutation behind a confirmation instead of running it", async () => {
    // The confirmation comes from the CTO thread's own approval — the turn is
    // parked inside `canUseTool` — not from a field on the turn's result.
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.service.raiseApproval({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });

    expect(harness.latest().phase).toBe("confirming");
    expect(harness.latest().pendingConfirmation?.toolName).toBe("openPr");
    expect(harness.latest().pendingConfirmation?.destructive).toBe(false);
  });

  it("drops a replaced answer instead of speaking it over the next one", async () => {
    // The user asks, then corrects themselves. The model calls `ask_cto` again
    // with `mode: "replace"`; the first turn is still running, and when it
    // finishes its answer is to a question the user has moved on from. Reading
    // the abort flag off the module binding asked the WRONG controller — by
    // then it named the replacing turn — so the stale answer was spoken over
    // the live one.
    const release: Array<() => void> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      runBackendTurn: async ({ intent }) => {
        if (intent.includes("first")) {
          await new Promise<void>((r) => release.push(r));
          return { spoken: "STALE ANSWER" };
        }
        return { spoken: "FRESH ANSWER" };
      },
    });
    await openCall(harness);

    askCto(harness, "the first question", { callId: "call_1" });
    await tick();
    askCto(harness, "no wait, the second question", { callId: "call_2", mode: "replace" });
    await tick();

    // The first turn only finishes now, after it was replaced.
    release.forEach((fn) => fn());
    await tick();

    const results = functionOutputs(harness.fake);
    expect(results).toContainEqual({ status: "ok", answer: "FRESH ANSWER" });
    expect(JSON.stringify(results)).not.toContain("STALE ANSWER");
    // The superseded call is still answered — an unanswered `function_call` sits
    // in the conversation forever — and nobody is asked to speak about it.
    expect(results).toContainEqual({ status: "superseded", answer: "" });
    expect(modelResponses(harness.fake)).toBe(1);
  });

  /**
   * Two requests at once, and who decides what happens to the first.
   *
   * On the live call of 2026-09-16 both requests were lost: the second one's
   * `runSessionTurn` was attempted before the first had been interrupted, threw
   * "Session already has an active background turn", and the abort landed three
   * milliseconds later. The user heard that the CTO could not be reached, twice.
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

  /**
   * The whole point of the call being able to act.
   *
   * The CTO's turn parks inside `canUseTool` when it reaches a tool that
   * writes. Nothing comes back through `runBackendTurn` to say so, so the call
   * learns about it from the chat's own approval event — and a spoken yes has
   * to reach that waiter, or the user hears "doing that now" and nothing runs.
   */
  describe("acting on a call", () => {
    function createCallWithApprovals(
      overrides: Parameters<typeof createService>[0] = {},
    ) {
      // The service's own notice type, so a field added to an approval breaks
      // these tests rather than being quietly dropped by a narrower shape.
      let raise: ((notice: CtoVoiceApprovalNotice) => void) | null = null;
      const resolved: Array<{ itemId: string; approved: boolean }> = [];
      let watcherReleased = false;
      const harness = createService({
        watchApprovals: (onApproval) => {
          raise = onApproval;
          return () => { watcherReleased = true; };
        },
        resolveApproval: async (args) => { resolved.push(args); },
        ...overrides,
      });
      return {
        ...harness,
        resolved,
        raise: (notice: CtoVoiceApprovalNotice) => raise?.(notice),
        wasWatcherReleased: () => watcherReleased,
      };
    }

    it("asks out loud, then lets the blocked turn through on a spoken yes", async () => {
      // The real sequence: the turn is still running — parked inside
      // `canUseTool` — when the approval is raised, so it has not returned an
      // answer and the question is the only thing ADE has said.
      let releaseBackend: () => void = () => {};
      const harness = createCallWithApprovals({
        runBackendTurn: async () => {
          await new Promise<void>((resolve) => { releaseBackend = resolve; });
          return { spoken: "Opened it." };
        },
      });
      await openCall(harness);
      askCto(harness, "open a pr for the sync lane");
      await tick();

      harness.raise({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
      expect(harness.latest().phase).toBe("confirming");
      expect(harness.latest().pendingConfirmation?.prompt).toContain("pull request");
      // The user has to HEAR the question, not find it in the chat.
      expect(spoken(harness.fake).join("\n")).toContain("pull request");

      utter(harness, "yes");
      await tick();

      expect(harness.latest().pendingConfirmation).toBeNull();
      expect(harness.resolved).toEqual([{ itemId: "item-1", approved: true }]);
      releaseBackend();
    });

    /**
     * Answering out loud while the CTO is still reading the question is the
     * ordinary case, not an edge one. The audio has to stop — but the turn
     * behind it is the one parked on this very approval, and aborting it would
     * kill the work the "yes" exists to release.
     */
    it("does not abandon the parked turn when the user answers over the question", async () => {
      const seenSignal: { current: AbortSignal | null } = { current: null };
      let releaseBackend: () => void = () => {};
      const harness = createCallWithApprovals({
        runBackendTurn: async ({ signal }: { signal: AbortSignal }) => {
          seenSignal.current = signal;
          await new Promise<void>((resolve) => { releaseBackend = resolve; });
          return { spoken: "Opened it." };
        },
      });
      await openCall(harness);
      askCto(harness, "open a pr for the sync lane");
      await tick();

      harness.raise({ itemId: "item-9", toolName: "openPr", prompt: "Open a pull request?" });
      harness.fake.receive({ type: "response.created", response: { id: "resp_q" } });

      // Talking over the question: the audio stops, the card stays, the turn lives.
      harness.fake.receive({ type: "input_audio_buffer.speech_started" });
      expect(harness.fake.typesSent()).toContain("response.cancel");
      expect(seenSignal.current?.aborted).toBe(false);
      expect(harness.latest().phase).toBe("confirming");
      expect(harness.latest().pendingConfirmation?.id).toBeTruthy();

      // Spoken over ADE's own voice and still accepted: a segment that carries
      // real energy is a barge-in, not the microphone hearing the CTO.
      hearMic(harness);
      harness.fake.receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "yes",
      });
      await tick();
      expect(harness.resolved).toEqual([{ itemId: "item-9", approved: true }]);
      releaseBackend();
    });

    it("turns the tool away on a spoken no", async () => {
      const harness = createCallWithApprovals();
      await openCall(harness);
      utter(harness, "clean up the branch");
      await tick();

      harness.raise({ itemId: "item-2", toolName: "openPr", prompt: "Open a pull request?" });
      utter(harness, "no, don't");
      await tick();

      expect(harness.latest().pendingConfirmation).toBeNull();
      expect(harness.resolved).toEqual([{ itemId: "item-2", approved: false }]);
    });

    it("will not let a voice approve a force-push, however clearly it is said", async () => {
      const harness = createCallWithApprovals();
      await openCall(harness);
      utter(harness, "force push it");
      await tick();

      harness.raise({ itemId: "item-3", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
      expect(harness.latest().pendingConfirmation?.destructive).toBe(true);

      utter(harness, "yes do it");
      await tick();

      // Still waiting on a tap, and nothing was released.
      expect(harness.latest().pendingConfirmation?.id).toBeTruthy();
      expect(harness.resolved).toEqual([]);

      // The card is the only way through.
      harness.service.approve(harness.latest().pendingConfirmation!.id);
      await tick();
      expect(harness.resolved).toEqual([{ itemId: "item-3", approved: true }]);
    });

    it("stops watching the chat when the call ends", async () => {
      const harness = createCallWithApprovals();
      await openCall(harness);
      expect(harness.wasWatcherReleased()).toBe(false);
      await harness.service.end();
      expect(harness.wasWatcherReleased()).toBe(true);
    });
  });

  it("marks a history-rewriting tool destructive, so voice cannot approve it", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.service.raiseApproval({ itemId: "item-1", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
    expect(harness.latest().pendingConfirmation?.destructive).toBe(true);
  });


  it("restores the CTO's mode when the call is ended before its socket opens", async () => {
    // The renderer opens the microphone as soon as the phase is `connecting`,
    // and a denied microphone hangs up immediately. Tearing down on the socket
    // alone missed that window and left the CTO unable to write for the life of
    // the process.
    const readOnly: boolean[] = [];
    const { service, fake } = createService({
      setCallConfirmMode: async (value: boolean) => { readOnly.push(value); },
    });
    await service.start();
    // No `fake.open()`: the socket exists but has never opened.
    await service.end();
    expect(readOnly).toEqual([true, false]);
    fake.open();
  });

  it("refuses to open a socket for a call that was ended while connecting", async () => {
    let ended = false;
    const { service } = createService({
      setCallConfirmMode: async (value: boolean) => {
        // Hang up from inside the await `start` is blocked on.
        if (value && !ended) { ended = true; await service.end(); }
      },
    });
    const result = await service.start();
    expect(result.ok).toBe(false);
  });

  it("writes the call down even when nothing else went right", async () => {
    const persistCall = vi.fn<[{ captions: unknown[] }], Promise<void>>(async () => {});
    const harness = createService({ persistCall });
    await openCall(harness);
    utter(harness, "hello");
    await harness.service.end();
    expect(persistCall).toHaveBeenCalledTimes(1);
    expect(persistCall.mock.calls[0]?.[0]?.captions.length).toBe(1);
  });

  it("captions what the CTO said from the response transcript", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({ type: "response.output_audio_transcript.delta", delta: "Three" });
    expect(harness.latest().phase).toBe("speaking");
    harness.fake.receive({
      type: "response.output_audio_transcript.done",
      transcript: "Three merged yesterday.",
    });
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    expect(harness.latest().captions.at(-1))
      .toMatchObject({ role: "assistant", text: "Three merged yesterday." });
    expect(harness.latest().phase).toBe("listening");
  });

  /**
   * The realtime model cannot read an image. The only place a captured window
   * can actually be looked at is the CTO thread behind `ask_cto`.
   */
  it("sends a captured image to the backend, not to the voice model", async () => {
    const seen: Array<string | null | undefined> = [];
    const harness = createService({
      runBackendTurn: async ({ imageBase64 }) => { seen.push(imageBase64); return { spoken: "ok" }; },
    });
    await openCall(harness);

    harness.service.attachImage({ pngBase64: "PNGDATA", note: "the CI run" });
    // The model is told it happened, and told in the silent channel: a
    // conversation item, with no response asked for, so nothing is read out.
    const item = harness.fake.lastOfType("conversation.item.create") as Record<string, any>;
    expect(item.item.role).toBe("system");
    expect(JSON.stringify(item.item.content)).toContain("the CI run");
    expect(JSON.stringify(harness.fake.sent)).not.toContain("PNGDATA");

    askCto(harness, "what is this showing", { callId: "call_1" });
    await tick();
    expect(seen).toEqual(["PNGDATA"]);

    // One capture, one turn: it must not ride along on the next one too.
    askCto(harness, "and the one before it", { callId: "call_2" });
    await tick();
    expect(seen).toEqual(["PNGDATA", null]);
  });

  it("hands output audio straight to the renderer", async () => {
    const chunks: string[] = [];
    const harness = createService({ onOutputAudio: (b64) => chunks.push(b64) });
    await openCall(harness);
    harness.fake.receive({ type: "response.output_audio.delta", delta: "AAAB" });
    // The same event under the name the older surface still uses for it.
    harness.fake.receive({ type: "response.audio.delta", delta: "AAAC" });
    expect(chunks).toEqual(["AAAB", "AAAC"]);
  });

  /**
   * The safety property of the whole feature. A call shares the CTO's one
   * session and there is no per-turn permission argument, so the only place the
   * guarantee can live is a window held open for the call. If this test ever
   * goes red, a spoken sentence can reach a tool that writes.
   */
  it("puts the CTO in confirm-first mode for the life of the call, and restores it after", async () => {
    const calls: boolean[] = [];
    const harness = createService({ setCallConfirmMode: async (v: boolean) => { calls.push(v); } });

    await harness.service.start();
    // Read-only is on BEFORE the socket exists — no audio may be in flight
    // while the CTO can still write.
    expect(calls).toEqual([true]);

    harness.fake.open();
    harness.fake.receive({ type: "session.created", session: { id: "sess_1" } });
    await harness.service.end();
    expect(calls).toEqual([true, false]);
  });

  it("refuses to start a call whose permissions it cannot set", async () => {
    const { service, latest } = createService({
      setCallConfirmMode: async () => { throw new Error("session is busy"); },
    });
    const result = await service.start();
    expect(result.ok).toBe(false);
    expect(latest().phase).toBe("failed");
  });

  it("stops sending audio while muted", async () => {
    const harness = createService();
    await openCall(harness);
    harness.service.setMuted(true);
    harness.fake.sent.length = 0;
    harness.service.pushAudio("AAAA");
    expect(harness.fake.typesSent()).not.toContain("input_audio_buffer.append");
    harness.service.setMuted(false);
    harness.service.pushAudio("AAAA");
    expect(harness.fake.typesSent()).toContain("input_audio_buffer.append");
  });
});


/**
 * The CTO row's second line, during a call and after it.
 *
 * The owner watched it read "hey there?" while the call moved on through several
 * exchanges: the generated status line takes a model round trip per settled turn
 * and a spoken turn takes one second. A call therefore reports its own progress.
 */
describe("what a call tells the CTO row", () => {
  it("counts exchanges as they happen, and closes with the truth", async () => {
    const reports: Array<{ exchanges: number; live: boolean }> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      onExchange: (args: { exchanges: number; live: boolean }) => reports.push(args),
    });
    await openCall(harness);

    utter(harness, "hey there");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    utter(harness, "what is this project");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    utter(harness, "what should I do next");
    await tick();

    expect(reports).toEqual([
      { exchanges: 1, live: true },
      { exchanges: 2, live: true },
      { exchanges: 3, live: true },
    ]);

    await harness.service.end();
    expect(reports.at(-1)).toEqual({ exchanges: 3, live: false });
  });

  /**
   * An exchange is a transcript with words in it, and nothing else.
   *
   * The meter used to decide this too, and on the call of 2026-09-16 it
   * subtracted three sentences the user really said from a count the CTO row
   * shows them. Silence the transcriber wrote punctuation for is still not an
   * exchange, because there is nothing in it.
   */
  it("counts every transcript with words in it, and nothing without", async () => {
    const reports: Array<{ exchanges: number; live: boolean }> = [];
    const harness = createService({
      backchannelsEnabled: () => false,
      logger: { info: vi.fn(), warn: vi.fn() },
      onExchange: (args: { exchanges: number; live: boolean }) => reports.push(args),
    });
    await openCall(harness);

    utter(harness, "hey there");
    await tick();
    harness.fake.receive({ type: "response.done", response: { status: "completed" } });
    // A sentence the meter did not hear is still a sentence the user said.
    utter(harness, "what's going on", { level: 0 });
    await tick();
    utter(harness, " … ");
    await tick();

    expect(reports).toEqual([{ exchanges: 1, live: true }, { exchanges: 2, live: true }]);
  });

  it("reads as one exchange in the singular, and as none before anything is said", async () => {
    expect(ctoVoiceStatusLine({ exchanges: 0, live: true })).toBe("Voice call");
    expect(ctoVoiceStatusLine({ exchanges: 1, live: true })).toBe("Voice call · 1 exchange");
    expect(ctoVoiceStatusLine({ exchanges: 4, live: true })).toBe("Voice call · 4 exchanges");
    expect(ctoVoiceStatusLine({ exchanges: 0, live: false })).toBe("Voice call ended");
    expect(ctoVoiceStatusLine({ exchanges: 2, live: false }))
      .toBe("Voice call ended · 2 exchanges");
  });
});

/**
 * The words appearing as they are heard.
 *
 * A final transcript can land seconds after the sentence, and on the call of
 * 2026-09-16 the owner repeated themselves into a HUD that showed nothing until
 * it did.
 */
describe("the live partial caption", () => {
  it("shows what is being heard, and clears it when the transcript lands", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "what merged",
    });
    expect(harness.latest().pendingUserText).toBe("what merged");
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.delta",
      delta: " yesterday",
    });
    expect(harness.latest().pendingUserText).toBe("what merged yesterday");

    hearMic(harness);
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "what merged yesterday",
    });
    await tick();

    expect(harness.latest().pendingUserText).toBeNull();
    expect(harness.latest().captions.map((caption) => caption.text))
      .toEqual(["what merged yesterday"]);
  });

  it("clears the partial when the transcription fails", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "what mer",
    });
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio too short" },
    });
    await tick();

    expect(harness.latest().pendingUserText).toBeNull();
  });

  /**
   * Some surfaces deliver a transcript as one `.completed` with no deltas at
   * all, and nothing about the captions may depend on the deltas arriving.
   */
  it("changes nothing when the API sends no deltas", async () => {
    const harness = createService();
    await openCall(harness);

    utter(harness, "what merged yesterday");
    await tick();

    expect(harness.latest().pendingUserText).toBeNull();
    expect(harness.latest().captions.map((caption) => caption.text))
      .toEqual(["what merged yesterday"]);
  });
});

/**
 * A call the CTO can end.
 *
 * On the call of 2026-09-16 the user said "close yourself now" and the model
 * answered that it could not — there was no tool for it, so the only way out of
 * a call was the End button.
 */
describe("end_call", () => {
  /** The audio one second of PCM16 at the session rate is carried in. */
  const ONE_SECOND_OF_AUDIO = Buffer.alloc(CTO_VOICE_SAMPLE_RATE * 2).toString("base64");

  function endCallOnWire(harness: ReturnType<typeof createService>) {
    harness.fake.receive({
      type: "response.done",
      response: {
        id: "resp_bye",
        status: "completed",
        output: [{ type: "function_call", name: "end_call", call_id: "call_bye", arguments: "{}" }],
      },
    });
  }

  it("says goodbye, waits for the audio, then ends the call as a normal ending", async () => {
    vi.useFakeTimers();
    try {
      const ended: string[] = [];
      const harness = createService({
        logger: {
          info: (event: string, meta?: unknown) => {
            if (event === "cto_voice.call_end") ended.push(String((meta as { reason?: unknown }).reason));
          },
          warn: vi.fn(),
        },
      });
      await openCall(harness);

      // The goodbye is spoken in the same response the call arrives in, so its
      // audio is already on the wire when the call is dispatched.
      harness.fake.receive({ type: "response.created", response: { id: "resp_bye" } });
      harness.fake.receive({ type: "response.output_audio.delta", delta: ONE_SECOND_OF_AUDIO });
      endCallOnWire(harness);
      await vi.advanceTimersByTimeAsync(0);

      // The call answers its own function call and does not ask for a second
      // response to talk over the goodbye.
      const outputs = harness.fake.sent.filter((message) => {
        const item = message.item as { type?: unknown } | undefined;
        return item?.type === "function_call_output";
      });
      expect(outputs).toHaveLength(1);

      // Still up while the goodbye is playing: hanging up on `response.done`
      // cuts the one sentence the user is guaranteed to be listening to.
      expect(harness.latest().phase).not.toBe("ended");
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.latest().phase).not.toBe("ended");

      await vi.advanceTimersByTimeAsync(100 + CTO_VOICE_END_CALL_AUDIO_TAIL_MS);
      expect(harness.latest().phase).toBe("ended");
      expect(harness.latest().error).toBeNull();
      expect(ended).toEqual(["assistant_end"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends after the tail alone when the model said goodbye without audio", async () => {
    vi.useFakeTimers();
    try {
      const harness = createService();
      await openCall(harness);

      endCallOnWire(harness);
      await vi.advanceTimersByTimeAsync(CTO_VOICE_END_CALL_AUDIO_TAIL_MS + 1);

      expect(harness.latest().phase).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms one hang-up however many times the model asks for it", async () => {
    vi.useFakeTimers();
    try {
      const persistCall = vi.fn(async () => {});
      const harness = createService({ persistCall });
      await openCall(harness);

      endCallOnWire(harness);
      harness.fake.receive({
        type: "response.function_call_arguments.done",
        name: "end_call",
        call_id: "call_bye_2",
        arguments: "{}",
      });
      await vi.advanceTimersByTimeAsync(CTO_VOICE_END_CALL_AUDIO_TAIL_MS + 1);

      expect(persistCall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A caption that was cut off says so.
 *
 * A barge-in truncates the response mid-word and the transcript that arrives is
 * whatever had been said — "I'm the CTO" for a sentence going somewhere else —
 * so the record has to carry the fact that the user stopped it.
 */
describe("an interrupted caption", () => {
  it("marks the assistant caption the user talked over", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "response.output_audio_transcript.delta", delta: "I'm" });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    harness.fake.receive({
      type: "response.output_audio_transcript.done",
      transcript: "I'm the CTO",
    });
    await tick();

    expect(harness.latest().captions.at(-1)).toMatchObject({
      role: "assistant",
      text: "I'm the CTO",
      interrupted: true,
    });
  });

  it("leaves an ordinary answer unmarked", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({
      type: "response.output_audio_transcript.done",
      transcript: "Three merged yesterday.",
    });
    await tick();

    expect(harness.latest().captions.at(-1)?.interrupted).toBeUndefined();
  });
});


/** Words, or a transcriber filling silence with punctuation. */
describe("ctoVoiceTranscriptHasSpeech", () => {
  it("counts letters and digits in any script, and nothing else", () => {
    expect(ctoVoiceTranscriptHasSpeech("what merged yesterday")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("好好好")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("아니")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("3")).toBe(true);
    expect(ctoVoiceTranscriptHasSpeech("")).toBe(false);
    expect(ctoVoiceTranscriptHasSpeech("   ")).toBe(false);
    expect(ctoVoiceTranscriptHasSpeech("…")).toBe(false);
    expect(ctoVoiceTranscriptHasSpeech(" ... !? ")).toBe(false);
  });
});


describe("a question raised before the socket opened", () => {
  it("is still asked out loud once the session exists", async () => {
    // `watchApprovals` is attached before the connection is made, so a tool
    // that asks during the handshake has a question waiting with nowhere to go.
    const harness = createService();
    await harness.service.start();
    harness.service.raiseApproval({
      itemId: "item-early",
      toolName: "openPr",
      prompt: "Open a pull request?",
    });
    expect(harness.fake.typesSent()).toEqual([]);

    harness.fake.open();
    const asked = harness.fake.sent
      .filter((message) => message.type === "response.create")
      .map((message) => String((message.response as { instructions?: unknown }).instructions ?? ""));
    expect(asked.join("\n")).toContain("Open a pull request?");
  });
});

/**
 * What must not survive a hang-up.
 *
 * A call is a socket, a lock, a queue and four flags, and every one of them
 * used to outlive the call that made it: `ws` delivers whatever it had already
 * queued after the close, and nothing detached the message listener.
 */
describe("a call that is over", () => {
  it("does not start a CTO turn for a function call delivered after hang-up", async () => {
    const runBackendTurn = vi.fn(async () => ({ spoken: "too late" }));
    const harness = createService({ runBackendTurn });
    await openCall(harness);
    await harness.service.end("owner_end");

    // Exactly what `ws` does with the frames it had already buffered.
    askCto(harness, "what merged yesterday");
    harness.fake.receive({
      type: "response.function_call_arguments.done",
      response_id: "resp_late",
      call_id: "call_late",
      name: "ask_cto",
      arguments: JSON.stringify({ request: "and this one", mode: "queue" }),
    });
    await tick();

    expect(runBackendTurn).not.toHaveBeenCalled();
  });

  it("leaves the next call no opinion about a response it never created", async () => {
    // The leak: `pendingOurResponse` is set on the send and cleared on
    // `response.created`, which never arrived for the line this call was in the
    // middle of. Carried into the next call it made the FIRST server response
    // look like one of ADE's own, so the first barge-in cancelled a response the
    // server was already truncating itself.
    const sockets = [createFakeSocket(), createFakeSocket()];
    let index = 0;
    const harness = createService({ createWebSocket: () => sockets[index++]!.socket });

    await harness.service.start();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "session.created", session: { id: "sess_1" } });
    // A line ADE asked for and the server never named.
    harness.service.raiseApproval({
      itemId: "item-1",
      toolName: "openPr",
      prompt: "Open a pull request?",
    });
    expect(sockets[0]!.typesSent()).toContain("response.create");
    await harness.service.end("owner_end");

    await harness.service.start();
    sockets[1]!.open();
    sockets[1]!.receive({ type: "session.created", session: { id: "sess_2" } });
    // The server's own response, and the user talking over it.
    sockets[1]!.receive({ type: "response.created", response: { id: "resp_server" } });
    sockets[1]!.receive({ type: "input_audio_buffer.speech_started" });

    expect(sockets[1]!.typesSent()).not.toContain("response.cancel");
  });
});


describe("the scene on the HUD", () => {
  it("belongs to the answer being spoken, and is cleared by one that drew nothing", async () => {
    const answers = [
      { spoken: "Here is what I drew.", sceneSource: "<p>chart</p>" },
      { spoken: "Three merged yesterday." },
    ];
    const harness = createService({ runBackendTurn: async () => answers.shift()! });
    await openCall(harness);

    askCto(harness, "show me the prs", { callId: "call_1", responseId: "resp_1" });
    await tick();
    expect(harness.latest().sceneSource).toBe("<p>chart</p>");

    askCto(harness, "and what merged", { callId: "call_2", responseId: "resp_2" });
    await tick();
    // The picture from four turns ago used to stay on screen for the rest of
    // the call, because only a result WITH a scene ever wrote this field.
    expect(harness.latest().sceneSource).toBeNull();
  });
});

describe("the interrupted flag", () => {
  it("falls back between utterances, so the next barge-in is still an edge", async () => {
    // The runtime drops its queued output audio on the false→true EDGE. A flag
    // left true by an earlier barge-in makes the next one drop nothing at all,
    // and the CTO carries on over the user with twenty seconds of stale answer.
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(true);

    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: "audio was unintelligible" },
    });
    expect(harness.latest().interrupted).toBe(false);
  });

  it("falls back when a transcript arrives with no words in it at all", async () => {
    // The empty-transcript path used to return before the flag was cleared, so
    // a second barge-in had no false→true edge and the runtime kept the stale
    // answer queued and talked over the user with it.
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(true);

    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "...",
    });
    expect(harness.latest().interrupted).toBe(false);
  });

  it("falls back when the next utterance opens over nothing", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({ type: "response.created", response: { id: "resp_1" } });
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(true);
    harness.fake.receive({
      type: "response.done",
      response: { id: "resp_1", status: "completed", output: [] },
    });

    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.latest().interrupted).toBe(false);
  });
});

describe("a picture already on the HUD", () => {
  it("survives a turn that failed, because that turn drew nothing of its own", async () => {
    const answers: CtoVoiceBackendResult[] = [
      { spoken: "Here is what I drew.", sceneSource: "<p>chart</p>" },
      { spoken: "", status: "failed", reason: "The CTO could not be reached." },
    ];
    const harness = createService({ runBackendTurn: async () => answers.shift()! });
    await openCall(harness);

    askCto(harness, "show me the prs", { callId: "call_1", responseId: "resp_1" });
    await tick();
    expect(harness.latest().sceneSource).toBe("<p>chart</p>");

    // The scene used to be blanked before the status was read, so a turn that
    // never answered took away the chart the user was still reading.
    askCto(harness, "and the checks", { callId: "call_2", responseId: "resp_2" });
    await tick();
    expect(harness.latest().sceneSource).toBe("<p>chart</p>");
  });
});

