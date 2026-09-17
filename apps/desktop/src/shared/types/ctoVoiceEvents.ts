/**
 * What the call service reads off each session event it has an opinion about,
 * by `type`.
 *
 * Every field is optional and most are checked at runtime anyway, because this
 * is a wire: a surface that omits `transcript` or names a response without an
 * `id` is not a bug in the socket, it is a different spelling of the same
 * event. What the map buys is the OTHER half — a handler whose parameter names
 * the event it was registered under, so a field read in the wrong handler is a
 * typecheck failure rather than `undefined` at 3 a.m.
 */

export type CtoVoiceResponseShape = {
  id?: unknown;
  status?: unknown;
  output?: unknown;
};

export type CtoVoiceSettledEvent = { response?: CtoVoiceResponseShape };
export type CtoVoiceTranscriptEvent = { transcript?: unknown };
export type CtoVoiceAudioDeltaEvent = { delta?: unknown };

export type CtoVoiceServerEvent = {
  "session.created": unknown;
  "session.updated": unknown;
  "conversation.created": unknown;
  "input_audio_buffer.speech_started": unknown;
  "input_audio_buffer.speech_stopped": unknown;
  "conversation.item.input_audio_transcription.delta": CtoVoiceAudioDeltaEvent;
  "conversation.item.input_audio_transcription.completed": CtoVoiceTranscriptEvent;
  "conversation.item.input_audio_transcription.failed": { error?: { message?: unknown } };
  "response.output_audio.delta": CtoVoiceAudioDeltaEvent;
  "response.audio.delta": CtoVoiceAudioDeltaEvent;
  "response.created": { response?: CtoVoiceResponseShape };
  "response.output_audio_transcript.delta": unknown;
  "response.audio_transcript.delta": unknown;
  "response.output_audio_transcript.done": CtoVoiceTranscriptEvent;
  "response.audio_transcript.done": CtoVoiceTranscriptEvent;
  "response.done": CtoVoiceSettledEvent;
  "response.failed": CtoVoiceSettledEvent;
  "response.cancelled": CtoVoiceSettledEvent;
  "response.function_call_arguments.done": {
    call_id?: unknown;
    response_id?: unknown;
    name?: unknown;
    arguments?: unknown;
  };
  error: {
    error?: { message?: unknown; code?: unknown; type?: unknown };
    message?: unknown;
    code?: unknown;
    type?: unknown;
  };
};
