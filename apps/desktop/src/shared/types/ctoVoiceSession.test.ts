import { describe, expect, it } from "vitest";

import {
  CTO_VOICE_DEFAULT,
  CTO_VOICE_SAMPLE_RATE,
  CTO_VOICE_TRANSCRIBE_LANGUAGE,
  CTO_VOICE_TRANSCRIBE_MODEL,
  CTO_VOICE_TRANSCRIBE_PROMPT,
} from "./ctoVoice";
import {
  buildCtoVoiceInstructionsUpdate,
  buildCtoVoiceSessionUpdate,
} from "./ctoVoiceSession";
import { CTO_VOICE_REALTIME_TOOLS } from "./ctoVoiceTools";

const args = {
  ctoName: "Ada",
  projectName: "ADE",
  context: "Three lanes are open.",
  acknowledgeAloud: true,
};

describe("buildCtoVoiceSessionUpdate", () => {
  /**
   * These flags are what make the call a hybrid rather than a dictation
   * machine: the server both detects the turn AND generates the answer, and it
   * truncates its own response a round trip sooner than ADE could. Either one
   * off is a call that either never speaks unprompted or talks over the user.
   */
  it("asks the server to detect turns AND answer them, and to interrupt itself", () => {
    const update = buildCtoVoiceSessionUpdate(args);

    expect(update.type).toBe("session.update");
    expect(update.session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      create_response: true,
      interrupt_response: true,
    });
  });

  // The seam. Without the tools the model can only talk, and every project
  // question becomes something it invents rather than something it asks for.
  it("carries the five function tools with a free choice between them", () => {
    const update = buildCtoVoiceSessionUpdate(args);

    expect(update.session.tools).toBe(CTO_VOICE_REALTIME_TOOLS);
    expect(update.session.tool_choice).toBe("auto");
    expect(update.session.output_modalities).toEqual(["audio"]);
  });

  /**
   * Transcription is not what drives a turn any more, but it is what the
   * captions, the saved call record and the spoken yes/no parser are made of.
   * The language is NAMED: an unnamed short utterance is how a call ends up
   * with a phantom word in another script in its transcript.
   */
  it("names the transcription model, its language and its prompt", () => {
    const update = buildCtoVoiceSessionUpdate(args);

    expect(update.session.audio.input.transcription).toEqual({
      model: CTO_VOICE_TRANSCRIBE_MODEL,
      language: CTO_VOICE_TRANSCRIBE_LANGUAGE,
      prompt: CTO_VOICE_TRANSCRIBE_PROMPT,
    });
  });

  it("speaks and listens in PCM at the one sample rate the renderer plays", () => {
    const update = buildCtoVoiceSessionUpdate(args);
    const format = { type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE };

    expect(update.session.audio.input.format).toEqual(format);
    expect(update.session.audio.output.format).toEqual(format);
  });

  it("uses the chosen voice, and the default when none was chosen", () => {
    expect(buildCtoVoiceSessionUpdate({ ...args, voice: "cedar" }).session.audio.output.voice)
      .toBe("cedar");
    expect(buildCtoVoiceSessionUpdate(args).session.audio.output.voice).toBe(CTO_VOICE_DEFAULT);
  });

  /**
   * The instructions must be COMPLETE in this first payload: anything the model
   * says before they land is said by a stranger. The `event_id` is deliberately
   * absent — it is per-send, and the call service stamps it.
   */
  it("carries the whole session prompt and leaves the event id to the sender", () => {
    const update = buildCtoVoiceSessionUpdate(args);

    expect(update.session.instructions).toContain("Ada");
    expect(update.session.instructions).toContain("ADE");
    expect(update.session.instructions).toContain("Three lanes are open.");
    expect(update).not.toHaveProperty("event_id");
  });
});

/**
 * The call re-sends the prompt on its own after every completed `ask_cto` — a
 * model answering "nine lanes" straight after creating the tenth is worse than
 * one that asks. It is the same builder rather than a second hand-built copy,
 * because two spellings of one event drift.
 */
describe("buildCtoVoiceInstructionsUpdate", () => {
  it("is the session update's prompt half and nothing else", () => {
    const update = buildCtoVoiceInstructionsUpdate(args);

    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("realtime");
    expect(update.session.instructions)
      .toBe(buildCtoVoiceSessionUpdate(args).session.instructions);
    // No tools, no audio, no voice: a refresh must not re-declare the session.
    expect(Object.keys(update.session)).toEqual(["type", "instructions"]);
  });
});
