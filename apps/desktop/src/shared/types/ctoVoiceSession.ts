import {
  CTO_VOICE_DEFAULT,
  CTO_VOICE_SAMPLE_RATE,
  CTO_VOICE_TRANSCRIBE_LANGUAGE,
  CTO_VOICE_TRANSCRIBE_MODEL,
  CTO_VOICE_TRANSCRIBE_PROMPT,
} from "./ctoVoice";
import { buildCtoVoiceInstructions } from "./ctoVoicePrompt";
import { CTO_VOICE_REALTIME_TOOLS } from "./ctoVoiceTools";

/** What both payloads need in order to write the session prompt. */
type CtoVoiceInstructionsArgs = {
  ctoName: string;
  projectName: string;
  context: string;
  acknowledgeAloud: boolean;
};

/**
 * The instructions-only `session.update`.
 *
 * Exported because the call re-sends exactly this after every completed
 * `ask_cto` — the facts in the context block are the ones a turn is most likely
 * to have just changed — and a second, hand-built copy of the payload in the
 * call service is how the two spellings of one event drift apart.
 */
export function buildCtoVoiceInstructionsUpdate(args: CtoVoiceInstructionsArgs) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: buildCtoVoiceInstructions({
        ctoName: args.ctoName,
        projectName: args.projectName,
        context: args.context,
        acknowledgeAloud: args.acknowledgeAloud,
      }),
    },
  };
}

/**
 * The one event that decides what kind of call this is.
 *
 * Every wire fact about a session — the turn-detection flags, the tool list,
 * the audio formats, the transcription model and the voice — is here rather
 * than inline in the socket's `open` handler, so the shape can be asserted
 * without opening a socket. The call service adds the `event_id` and sends it;
 * nothing else about the payload is decided there.
 */
export function buildCtoVoiceSessionUpdate(args: CtoVoiceInstructionsArgs & { voice?: string }) {
  // The first `session.update` is the instructions one plus everything a
  // session also needs, so the prompt half is written in exactly one place.
  const instructions = buildCtoVoiceInstructionsUpdate(args);
  return {
    ...instructions,
    session: {
      ...instructions.session,
      // The seam, as five functions. `auto` because the whole design is the
      // model deciding which side of the line a sentence falls on.
      tools: CTO_VOICE_REALTIME_TOOLS,
      tool_choice: "auto",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE },
          turn_detection: {
            type: "server_vad",
            // Server turn detection DOES create the model's responses: it is
            // the conversational front, and it answers from the context block
            // in the instructions. What it may not do is invent a project fact
            // — that is what `ask_cto` is for, and the instructions say so.
            create_response: true,
            // The server truncates its own response the moment it hears
            // speech, which is a round trip sooner than ADE could. ADE still
            // cancels the responses IT created out-of-band, which this does not
            // cover: they are not in the conversation.
            interrupt_response: true,
          },
          // Not on by default. No longer what drives a turn — the model hears
          // the audio itself — but still what the captions, the saved
          // transcript and the spoken yes/no parser are made of. The language
          // is named rather than guessed: an unnamed short utterance is how a
          // call ended up with a phantom "好" in it.
          transcription: {
            model: CTO_VOICE_TRANSCRIBE_MODEL,
            language: CTO_VOICE_TRANSCRIBE_LANGUAGE,
            // Both, because measured against the live API neither one is
            // sufficient on its own — see `CTO_VOICE_TRANSCRIBE_PROMPT`.
            prompt: CTO_VOICE_TRANSCRIBE_PROMPT,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: CTO_VOICE_SAMPLE_RATE },
          voice: args.voice ?? CTO_VOICE_DEFAULT,
        },
      },
    },
  };
}
