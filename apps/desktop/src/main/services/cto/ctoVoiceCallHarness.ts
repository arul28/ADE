import type { CtoVoiceState } from "../../../shared/types/ctoVoice";
import { createCtoVoiceCallService } from "./ctoVoiceCallService";
import { createFakeSocket } from "./ctoVoiceTestDoubles";

/**
 * One live call, driven from the wire.
 *
 * Every voice suite needs the same four things — a service with a fake socket
 * under it, a way to open the session, a way to say something out loud, and a
 * way to read what went back — and the modules the call service is built from
 * are tested through exactly this seam rather than by reaching into them. Kept
 * here so a suite that moves does not take a copy of the harness with it.
 */

export function createService(overrides: Partial<Parameters<typeof createCtoVoiceCallService>[0]> = {}) {
  const fake = createFakeSocket();
  const states: CtoVoiceState[] = [];
  const service = createCtoVoiceCallService({
    getApiKey: async () => "sk-test",
    ctoName: () => "CTO",
    projectName: () => "ADE",
    backchannelsEnabled: () => true,
    runBackendTurn: async () => ({ spoken: "Three merged yesterday." }),
    persistCall: async () => {},
    onState: (state) => states.push(state),
    createWebSocket: () => fake.socket,
    ...overrides,
  });
  return { service, fake, states, latest: () => states[states.length - 1] };
}

/** One macrotask of silence, which is enough to let every queued microtask run. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Bring a call up to the point where OpenAI has answered with a session. */
export async function openCall(harness: VoiceHarness) {
  await harness.service.start();
  harness.fake.open();
  harness.fake.receive({ type: "session.created", session: { id: "sess_1" } });
}

/**
 * One microphone frame, the size the renderer actually produces.
 *
 * 2048 samples of PCM16 at the session rate — about 85 ms — because the
 * transcript gate measures a segment's length off the audio's own byte count
 * rather than off a clock.
 */
export const MIC_FRAME = Buffer.alloc(2048 * 2).toString("base64");

/** Peak level a close-mic sentence reaches with the capture chain's AGC on. */
export const SPEAKING_LEVEL = 0.4;

/** Peak level a quiet room produces after noise suppression: not speech. */
export const ROOM_NOISE_LEVEL = 0.01;

/** Feed the call frames, exactly as the renderer's meter would. */
export function hearMic(
  harness: VoiceHarness,
  options: { level?: number; frames?: number } = {},
) {
  const level = options.level ?? SPEAKING_LEVEL;
  const frames = options.frames ?? 5;
  for (let i = 0; i < frames; i += 1) harness.service.pushAudio(MIC_FRAME, level);
}

/**
 * One user turn, exactly as the wire delivers it: VAD opens the turn, the
 * microphone carries the speech, VAD closes it, and the transcription lands
 * separately.
 *
 * The frames are not decoration. A transcript with no microphone energy behind it
 * is a hallucination and is thrown away, so a test that means "the user said
 * this" has to say it out loud.
 */
export function utter(
  harness: VoiceHarness,
  transcript: string,
  options: { level?: number; frames?: number } = {},
) {
  const fake = harness.fake;
  fake.receive({ type: "input_audio_buffer.speech_started" });
  hearMic(harness, options);
  fake.receive({ type: "input_audio_buffer.speech_stopped" });
  fake.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-1",
    transcript,
  });
}

/**
 * Every line ADE asked to have read out, as the text it handed over.
 *
 * Only the out-of-band ones: a response with no `response` object at all is the
 * model speaking for itself, which is most of a hybrid call and is never a
 * sentence ADE wrote.
 */
export function spoken(fake: ReturnType<typeof createFakeSocket>): string[] {
  return fake.sent
    .filter((message) => message.type === "response.create")
    .map((message) => (message.response as { instructions?: unknown } | undefined)?.instructions)
    .filter((value): value is string => typeof value === "string");
}

/**
 * The silent `system` items ADE put in the conversation, as their text.
 *
 * A note, not a line to read out: it is added to the history and nothing else
 * is sent for it, so nothing is spoken until something asks for a response.
 * The "still working" sentences and the note behind a confirmation are both
 * made of these.
 */
function systemNotes(fake: ReturnType<typeof createFakeSocket>): string[] {
  return fake.sent
    .filter((message) => {
      const item = message.item as { type?: unknown; role?: unknown } | undefined;
      return message.type === "conversation.item.create"
        && item?.type === "message"
        && item.role === "system";
    })
    .map((message) => {
      const content = (message.item as { content?: Array<{ text?: unknown }> }).content ?? [];
      return String(content[0]?.text ?? "");
    });
}

/** Just the "still working" ones. */
export function workingNudges(fake: ReturnType<typeof createFakeSocket>): string[] {
  return systemNotes(fake).filter((text) => text.includes("still running"));
}

/** Responses the model was asked to generate for itself, in the conversation. */
export function modelResponses(fake: ReturnType<typeof createFakeSocket>): number {
  return fake.sent
    .filter((message) => message.type === "response.create" && message.response === undefined)
    .length;
}

/**
 * The model asks the CTO, exactly as the wire delivers it: a finished response
 * whose output carries a `function_call` item.
 */
export function askCto(
  harness: VoiceHarness,
  request: string,
  options: { callId?: string; responseId?: string; mode?: "replace" | "queue" } = {},
) {
  harness.fake.receive({
    type: "response.done",
    response: {
      id: options.responseId ?? "resp_fn",
      status: "completed",
      output: [{
        type: "function_call",
        name: "ask_cto",
        call_id: options.callId ?? "call_1",
        arguments: JSON.stringify({ request, mode: options.mode ?? "queue" }),
      }],
    },
  });
}

/** One tool call with no arguments — `cancel_work` and the two approvals. */
export function callTool(
  harness: VoiceHarness,
  name: string,
  callId = "call_tool",
) {
  harness.fake.receive({
    type: "response.done",
    response: {
      id: `resp_${callId}`,
      status: "completed",
      output: [{ type: "function_call", name, call_id: callId, arguments: "{}" }],
    },
  });
}

/** Every function result this call handed back, parsed. */
export function functionOutputs(
  fake: ReturnType<typeof createFakeSocket>,
): Array<Record<string, unknown>> {
  return fake.sent
    .filter((message) => {
      const item = message.item as { type?: unknown } | undefined;
      return message.type === "conversation.item.create" && item?.type === "function_call_output";
    })
    .map((message) =>
      JSON.parse(String((message.item as { output?: unknown }).output)) as Record<string, unknown>);
}

/** The harness every voice suite drives a real call through. */
export type VoiceHarness = ReturnType<typeof createService>;
