/**
 * CTO voice call — the cross-surface contract.
 *
 * The call runs on OpenAI's Realtime API over a WebSocket, and it is a HYBRID.
 * The realtime model is the conversational front: it hears the user, it answers
 * small talk and anything already in the context block it was given, and it
 * speaks in real time. Anything that needs the project — code, files, git,
 * lanes, PRs, tests, a command, a change, any fact it was not handed — it asks
 * for by calling the `ask_cto` function, and that call runs a real turn on the
 * CTO's own thread with the user's chosen model, its memory and all its tools.
 *
 * The earlier design made the realtime model a pure mouth
 * (`turn_detection.create_response: false`, every sentence relayed from a CTO
 * turn). It was correct and it was three to five seconds slow for "hello",
 * which is not a conversation. The split moved rather than went away: the model
 * owns the talking, the CTO thread owns the work, and `ask_cto` is the seam.
 *
 * ADE — not the model — still owns permissions. A call holds the CTO in
 * confirm-first mode for its whole length, so every writing tool stops and asks
 * out loud, and that gate is a hold in code rather than a sentence in a prompt.
 */

import type { SceneStillRecord } from "../chatScene";

/**
 * The realtime model the call speaks with.
 *
 * `gpt-live-1` shipped here once, and there is no such model — as there was no
 * such endpoint, no such events and no such delegation. This is the documented
 * current realtime model.
 */
export const CTO_VOICE_MODEL = "gpt-realtime-2.1";

/**
 * The realtime WebSocket, without its model.
 *
 * The model rides as a query parameter so it stays ONE constant rather than
 * being spelled a second time inside a URL — the first version of this file
 * pointed at `/v1/live/sessions`, which answers 401 to every upgrade and, because
 * the failure happens at the handshake, never delivers OpenAI's explanation.
 */
export const CTO_VOICE_ENDPOINT = "wss://api.openai.com/v1/realtime";

/** The realtime endpoint for one model. */
export function ctoVoiceEndpointUrl(model: string = CTO_VOICE_MODEL): string {
  return `${CTO_VOICE_ENDPOINT}?model=${encodeURIComponent(model)}`;
}

/**
 * The model that turns the user's audio into readable text.
 *
 * Input transcription is not on by default. It is no longer what drives a CTO
 * turn — the realtime model decides that now, and it hears the audio itself —
 * but it is still what the call's captions, its saved transcript and the spoken
 * yes/no parser are all made of.
 */
export const CTO_VOICE_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/**
 * The language the transcriber is told to hear.
 *
 * Without it the model guesses per utterance, and a short or noisy one guesses
 * wrong: a real call transcribed a phantom "好" and the CTO answered it, then
 * the voice replied in Chinese. Naming the language removes the guess — an
 * English speaker's "OK" can no longer become a Korean sentence — and it also
 * makes the transcript faster and more accurate, because the model is no longer
 * spending the first words deciding what it is listening to.
 */
export const CTO_VOICE_TRANSCRIBE_LANGUAGE = "en";

/**
 * The hint the transcriber is given about what this call is about.
 *
 * Measured against the live API on 2026-09-16, six runs per configuration with
 * TTS-synthesised audio fed through the real session config: `language: "en"`
 * alone transcribed a spoken Serbian "Здраво" as `"Zdravo."` — romanised, so
 * the language IS read — but a Russian "Привет" came back as `"Привет."` in
 * Cyrillic in all three runs, and adding this prompt changed nothing in any of
 * the six. So neither field forces English, and both are kept: the language is
 * still the cheapest way to stop the per-utterance guess, and the prompt is
 * what tells the model the vocabulary of the call ("lanes", "PRs") rather than
 * of a podcast. What the wire cannot guarantee, the CTO turn's own "answer in
 * English" line does.
 */
export const CTO_VOICE_TRANSCRIBE_PROMPT =
  "English conversation about a software project called ADE, lanes, pull requests, tests.";

/** Billed per second; the pill shows the running total from this. */
export const CTO_VOICE_USD_PER_MINUTE = 0.05;

/** PCM16 mono. The rate the realtime session is configured with, both directions. */
export const CTO_VOICE_SAMPLE_RATE = 24_000;

/**
 * How often the window holding the microphone drains the runtime's output audio.
 *
 * Audio cannot ride the runtime event buffer — that buffer is a bounded,
 * replayable log of real events, and ten chunks a second of PCM would evict
 * every orchestrator and runtime event in it within seconds. So the owner polls
 * instead, at the same 100 ms cadence it batches microphone frames on.
 */
export const CTO_VOICE_AUDIO_POLL_INTERVAL_MS = 100;

/**
 * How long a live call survives with no word from the window that owns it.
 *
 * The owner touches the runtime ten times a second for the whole call, so
 * silence this long means that window is gone. Without a deadline the socket,
 * the billing and the CTO's confirm-first hold would outlive it inside a
 * process the user cannot see. Generous next to the poll interval, because a
 * busy machine must not hang up a call that is merely slow.
 */
export const CTO_VOICE_OWNER_IDLE_TIMEOUT_MS = 15_000;

/**
 * Microphone frames held while the Live socket is still opening.
 *
 * The HUD opens the microphone the instant Talk is pressed, so frames start
 * arriving well before OpenAI has answered the handshake — and `ws` throws on
 * any send before `open`. About four seconds at the renderer's ~12 frames a
 * second, which covers a slow handshake and still bounds a socket that never
 * opens at all.
 */
export const CTO_VOICE_PREOPEN_AUDIO_LIMIT = 50;

/**
 * Output audio chunks the runtime will hold for an owner that is not draining.
 *
 * About twenty seconds at the rate the realtime session emits them. Past that the oldest
 * are dropped rather than the process growing without bound; the drop count
 * travels with the drain so the desktop can say the audio broke up rather than
 * silently playing a stale tail.
 */
export const CTO_VOICE_OUTPUT_AUDIO_QUEUE_LIMIT = 200;

/* ── The transcript gate ───────────────────────────────────────────────────
 *
 * A transcription event is NOT evidence that the user spoke — but it is the
 * only record of what the user said, and those two facts pull in opposite
 * directions. The gate is therefore scoped to the ONE decision where a phantom
 * sentence can do damage: releasing a tool that is parked inside `canUseTool`.
 *
 * Under the hybrid the realtime model hears the audio itself and answers
 * regardless of anything judged here, so a rejected caption never stopped a
 * hallucination from being answered out loud — it only deleted the user's own
 * words from the HUD and from the call record. On the call of 2026-09-16 three
 * REAL sentences ("Who are you?", "Okay, what's going on?", "Okay, close
 * yourself now.") measured a peak of 0.005 against 0.3–0.86 for their
 * neighbours and were thrown away, and the owner watched the CTO answer
 * questions the screen said had never been asked.
 *
 * So captions and the exchange count are now unconditional: every non-empty
 * transcript is recorded. The numbers below judge ONE path — the transcript
 * parser, which reads a spoken "yes" out of the transcriber's text and releases
 * a blocked tool with it. That yes only counts when ADE's own microphone meter
 * agrees somebody spoke, and every number here is deliberately generous,
 * because the cost of refusing a real "yes" is one tap and the cost of
 * accepting a phantom one is whatever the tool was about to do.
 *
 * There is a SECOND path and it is not gated by any of this: the realtime model
 * hears the audio itself and can call `approve_pending_action`. Nothing
 * below is evidence about that path — the model is listening to the same sound
 * a person would, not to a transcript, and a meter on this side has no vote on
 * what it heard. What both paths share is the one rule that cannot be spoken
 * past: a `CTO_VOICE_DESTRUCTIVE_TOOLS` action — see `ctoVoiceDestructive` —
 * always needs a tap, whoever heard the yes.
 *
 * Whisper-family transcribers hallucinate words out of near-silence: a real
 * call on 2026-09-16 produced six CTO turns in thirty-eight seconds from three
 * spoken sentences, the other three being "Haha.", "OK,OK,好好好." and "아니."
 * invented from room noise — which is why a spoken approval is never taken on
 * the transcriber's word alone.
 */

/**
 * Peak microphone amplitude (0..1) a segment must reach to count as speech.
 *
 * The renderer computes the peak absolute sample of each ~85 ms frame and hands
 * it to `pushAudio`, off a capture chain with `autoGainControl` and
 * `noiseSuppression` on. With AGC in the path even a quiet, close-mic sentence
 * peaks well above 0.2, while suppressed room noise sits under 0.02 — so 0.05
 * (about -26 dBFS) sits well below real speech and comfortably above the floor
 * these hallucinations came out of. Low on purpose: this number is allowed to
 * let noise through, it is not allowed to drop a sentence — and it is only ever
 * asked about a transcript that would approve something.
 */
export const CTO_VOICE_MIN_SPEECH_PEAK_LEVEL = 0.05;

/**
 * How far back the microphone meter remembers.
 *
 * The meter is reset by every transcript, not by a VAD segment (see
 * `handleUserTranscript`), and the first transcript of a call can land fifteen
 * seconds after the microphone opened. Without a window, every frame since the call started was
 * evidence for that first transcript — so three noisy frames scattered across
 * those fifteen seconds cleared a 240 ms minimum between them, which is how a
 * phantom "好" passed a gate that was running. Three seconds is longer than any
 * single sentence a call has to accept, and far shorter than the run-up to one.
 */
export const CTO_VOICE_MIC_WINDOW_MS = 3_000;

/**
 * Microphone peak (0..1) that interrupts the CTO's voice from the renderer.
 *
 * The renderer plays the CTO's audio, so it knows a barge-in a whole round trip
 * before the server's VAD does: server `speech_started` has to reach the call
 * service, become an `interrupted` state, cross the runtime event bus and the
 * desktop router, and only then does the renderer flush. Audio already pulled
 * into the playback graph keeps talking over the user for all of it.
 *
 * Deliberately four times {@link CTO_VOICE_MIN_SPEECH_PEAK_LEVEL} rather than
 * equal to it. That number is a permissive floor for "was there speech in this
 * segment at all", judged after the fact; this one fires instantly on two
 * frames, so the CTO's own voice leaking back through the echo canceller must
 * not be able to reach it — a self-interrupting call would cut every answer
 * short in a noisy room. 0.2 is under a close-mic sentence with AGC on and well
 * over suppressed echo.
 *
 * The server-side path stays the source of truth: this only silences the
 * speaker, and it is the runtime that cancels the response and aborts the turn.
 */
export const CTO_VOICE_LOCAL_BARGE_IN_LEVEL = 0.2;

/**
 * How many CONSECUTIVE frames must reach that level before the speaker is cut.
 *
 * A single transient is a door, a chair, or a knuckle on the desk — and cutting
 * the CTO off mid-word for one of those is worse than a beat of the user's
 * voice overlapping the answer. Two frames is ~20 ms at the renderer's capture
 * size: far too short to be heard as a delay, and long enough that a click
 * cannot reach it.
 */
export const CTO_VOICE_LOCAL_BARGE_IN_FRAMES = 2;

/**
 * How long a local barge-in keeps discarding output before it gives up.
 *
 * The latch is normally lifted by a phase change, which is the main process
 * saying the turn moved on. Two loud non-speech frames mid-`speaking` set it
 * with no server VAD event behind them, and nothing then changes the phase — so
 * without a deadline the rest of that answer, and the one after it, are silently
 * dropped. A second and a half is longer than the queue the flush was meant to
 * kill and shorter than a sentence.
 */
export const CTO_VOICE_LOCAL_BARGE_IN_RELEASE_MS = 1_500;

/**
 * How much CONTIGUOUS voiced audio a segment needs before it can carry a
 * sentence.
 *
 * Contiguous is the load-bearing word. This was once a sum of every frame above
 * the peak threshold, and a sum cannot tell a spoken word from three unrelated
 * clicks in three different seconds — the frames only have to add up. It is now
 * the longest unbroken run of above-threshold frames inside
 * {@link CTO_VOICE_MIC_WINDOW_MS}, which is what a word actually looks like:
 * energy that stays up. Measured from the frames' own byte lengths rather than a
 * clock, so a long pause bracketed by two clicks cannot qualify.
 *
 * 240 ms is under the length of a spoken "yes" (~350 ms) and far over a keyboard
 * click or a chair creak, which is the distinction being drawn — the shortest
 * real utterance a call must accept is a one-word answer to a confirmation.
 */
export const CTO_VOICE_MIN_SPEECH_MS = 240;

/**
 * Accepted turns inside {@link CTO_VOICE_TURN_BURST_WINDOW_MS} before the gate
 * closes entirely.
 *
 * The backstop for whatever the energy gate does not catch: a call answering
 * faster than a human could possibly be asking. The CTO takes seconds to think
 * and seconds more to speak, so more than four accepted turns inside ten
 * seconds — one every 2.5 s — cannot be a conversation; it is a transcript
 * source running away. Recovery is silence: see the cooldown below.
 */
export const CTO_VOICE_TURN_BURST_LIMIT = 4;

/*
 * The valve counts every transcript and shuts the CONFIRMATION path, never the
 * caption path. A runaway transcript source must not be able to answer a
 * question ADE asked out loud; it is still allowed to fill the call record,
 * because a call record with too much in it is readable and one with the user's
 * own sentences missing is not.
 */

/** The window the burst limit is counted over. */
export const CTO_VOICE_TURN_BURST_WINDOW_MS = 10_000;

/**
 * Quiet needed to reopen the gate after a burst tripped it.
 *
 * "Until the next accepted transcript" cannot itself be the release condition —
 * while the gate is shut there are no accepted transcripts — so the release is a
 * stretch with no transcripts arriving at all. Eight seconds is long enough that
 * a runaway source has visibly stopped, and short enough that a user who paused
 * mid-call is not locked out of their own call.
 */
export const CTO_VOICE_TURN_BURST_COOLDOWN_MS = 8_000;

/**
 * Why a transcript was thrown away. One name per reason, and it goes in the log
 * beside the `scope` that threw it away — `caption` for an empty transcript,
 * `confirmation` for one that could not be trusted to approve anything.
 */
export type CtoVoiceTranscriptRejection =
  | "empty"
  | "no_speech_energy"
  | "too_short"
  | "echo"
  | "runaway";

/**
 * Does this transcript carry words at all?
 *
 * Trimmed to nothing, or to nothing but punctuation and ellipses, is what a
 * transcriber returns for silence it could not resist writing something about.
 * Unicode-aware on purpose: the hallucinations in the reference call were CJK,
 * so a check written against A-Z would have passed every one of them.
 */
export function ctoVoiceTranscriptHasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.trim());
}

/**
 * The line the CTO row shows while a call is up, and after it ends.
 *
 * Deterministic and written by the call itself, rather than the LLM-generated
 * status line a settled turn normally produces: that generation takes seconds,
 * so during a call it always described an exchange the user had already moved
 * past — the row read "hey there?" three questions later. An exchange is one
 * accepted user turn, so the count is a claim ADE can stand behind.
 */
export function ctoVoiceStatusLine(args: { exchanges: number; live: boolean }): string {
  const count = Math.max(0, Math.trunc(args.exchanges));
  const head = args.live ? "Voice call" : "Voice call ended";
  if (count < 1) return head;
  return `${head} · ${count} ${count === 1 ? "exchange" : "exchanges"}`;
}

export const CTO_VOICE_VOICES = [
  "marin", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "cedar",
] as const;
export type CtoVoiceName = (typeof CTO_VOICE_VOICES)[number];
export const CTO_VOICE_DEFAULT: CtoVoiceName = "marin";

/**
 * What the HUD is showing right now.
 *
 * `thinking` is distinct from `speaking` because it is the state the filler
 * exists for: the backend has been handed the request and the user must not
 * hear silence while it works.
 */
export type CtoVoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "confirming"
  | "ended"
  | "failed";

/** A phase a call is actually running in. Narrowed by `isVoiceCallLive`. */
export type LiveVoicePhase = Exclude<CtoVoicePhase, "idle" | "ended" | "failed">;

/**
 * The two questions every surface asks about a call, answered once.
 *
 * They are NOT the same question. "Is a call running" decides whether a capture
 * is spoken about or filed, and whether Talk is disabled. "Should the HUD be on
 * screen" is a looser set, because a failed call still has something to say.
 *
 * Both exclude terminal phases by name rather than listing the live ones, so a
 * phase added later defaults to live instead of silently disappearing — and
 * `isVoiceCallLive` narrows, so a caller that needs the live set gets it from
 * the type system instead of restating the exclusions.
 */
export function isVoiceCallLive(
  phase: CtoVoicePhase | string | null | undefined,
): phase is LiveVoicePhase {
  return phase !== "idle" && phase !== "ended" && phase !== "failed" && Boolean(phase);
}

export function isVoiceCallVisible(phase: CtoVoicePhase | string | null | undefined): boolean {
  // Built on the predicate above rather than restating its exclusions, so a
  // terminal phase added later has one place to be added, not two.
  return isVoiceCallLive(phase) || phase === "failed";
}

export const CTO_VOICE_CAPTURE_EVENT = "ade:cto-voice:attach-capture";

/**
 * Why the microphone would not open, in the four ways it actually happens.
 *
 * One sentence per cause, because "allow ADE in System Settings" is worse than
 * useless when the OS has no entry for this binary to allow — which is the
 * ordinary case for a development build, and the one that sent a user to a
 * settings pane where ADE was already ticked.
 */
export type CtoVoiceMicrophoneBlockKind =
  /** The OS knows this app and the answer is no. */
  | "os-denied"
  /**
   * An unsigned development build. macOS gives `com.github.Electron` no TCC
   * identity, so `askForMediaAccess` returns false without ever prompting and
   * no amount of clicking in System Settings changes it: the entry the user
   * sees is the packaged app's, not this one's.
   */
  | "dev-build"
  /**
   * There is no microphone at all.
   *
   * A Mac Studio has no built-in one, so a perfectly granted permission and an
   * empty device list are the ordinary state of that machine — and "another app
   * may be holding the microphone" sent the owner looking for an app that did
   * not exist.
   */
  | "no-device"
  /** The OS said yes and `getUserMedia` still refused: something else has it. */
  | "in-use"
  /** A stream arrived with no usable track. Rare, and not the user's doing. */
  | "unavailable";

/** The title every microphone failure is shown under. */
export const CTO_VOICE_MICROPHONE_BLOCK_TITLE = "ADE cannot use the microphone";

/**
 * What to say when the microphone will not open.
 *
 * Named per platform because the sentence is only useful if it points at the
 * pane the user has to open, and those are different places. Chosen from the
 * preload platform bridge rather than `navigator.platform`, which cannot tell
 * Windows on ARM from Windows on x64 and has no business deciding this either.
 *
 * Two sentences, always: what happened, then what to do. The second one names
 * the OS out loud ("macOS System Settings › Sound › Input") because the owner
 * who read "System Settings, Sound" on a Mac asked what a Windows user is
 * meant to make of it — the wording has to be true for the machine it is on
 * and obviously ABOUT that machine, not a location the reader has to guess at.
 *
 * Linux gets a generic sentence: there is no one sound pane to name, and no
 * URL ADE can open, so it says what to look for rather than pointing at a
 * place that may not exist on that desktop.
 *
 * It lives here rather than in the component because the same failure has to
 * read identically wherever it surfaces — the sheet's guidance card, the
 * header notice and the call's terminal state are one event.
 */
export function ctoVoiceMicrophoneMessage(
  kind: CtoVoiceMicrophoneBlockKind,
  platform: string,
): string {
  const windows = platform === "win32";
  const mac = platform === "darwin";
  /** Where inputs are chosen, by name, on this OS. */
  const soundPane = windows
    ? "Windows Settings › System › Sound › Input"
    : mac
      ? "macOS System Settings › Sound › Input"
      : "your desktop's sound settings";
  /** Where app microphone permission is granted, by name, on this OS. */
  const privacyPane = windows
    ? "Windows Settings › Privacy & security › Microphone"
    : mac
      ? "macOS System Settings › Privacy & Security › Microphone"
      : "your desktop's microphone permissions";
  switch (kind) {
    case "dev-build":
      // Only macOS has this failure. Windows microphone policy is one global
      // switch that covers every desktop app including an unsigned Electron,
      // so "start it from a terminal" would be false advice there and the
      // permission sentence IS the fix; Linux has no TCC identity to lack.
      if (mac) {
        return "This is a development build, so macOS will not grant it the microphone."
          + ` Start ADE from Terminal, or allow "Electron" under ${privacyPane}.`;
      }
      return `ADE could not open the microphone. Allow microphone access for ADE under ${privacyPane}.`;
    case "no-device":
      return `No microphone is connected to this ${windows ? "PC" : mac ? "Mac" : "computer"}.`
        + ` Plug one in, or choose an input under ${soundPane}.`;
    case "in-use":
      // No pane worth naming: the fix is another app, not a setting.
      return "Another app is holding the microphone. Close it and try again.";
    case "unavailable":
      return "ADE could not open the microphone."
        + ` Check that one is connected and selected under ${soundPane}.`;
    case "os-denied":
    default:
      return `ADE could not open the microphone. Allow microphone access for ADE under ${privacyPane}.`;
  }
}

/**
 * The sentence the router matches to recognise its own microphone hang-up.
 *
 * Every kind, because the renderer sends whichever one applied and the router
 * must classify all of them to the one coarse analytics outcome.
 */
export function isCtoVoiceMicrophoneMessage(reason: string): boolean {
  const kinds: CtoVoiceMicrophoneBlockKind[] =
    ["os-denied", "dev-build", "no-device", "in-use", "unavailable"];
  return kinds.some((kind) =>
    reason === ctoVoiceMicrophoneMessage(kind, "darwin")
    || reason === ctoVoiceMicrophoneMessage(kind, "win32")
    // Linux too: its sentences are their own wording, and a hang-up carrying
    // one is the same event as the other two.
    || reason === ctoVoiceMicrophoneMessage(kind, "linux"));
}

/**
 * What every voice action answers with. No action throws across the bus: a
 * refusal is a value, carrying a machine code and one plain sentence.
 */
export type CtoVoiceActionResult = {
  ok: boolean;
  /** A stable machine code (`missing-key`, `not-call-owner`, …). */
  error?: string;
  /** One plain-language sentence a user can act on. */
  detail?: string;
};

/**
 * The ten actions a call is driven by, as data.
 *
 * Here rather than beside the service that implements them because the policy
 * tables consume it: this module imports nothing at runtime, and `ctoVoiceRuntimeService`
 * pulls in `ws`, the API key store and the chat service graph. An action list
 * is a contract, not an implementation detail, and the gate that reads it must
 * not have to load a WebSocket client to do so.
 */
export const CTO_VOICE_ACTIONS = [
  "getState",
  "hasKey",
  "start",
  "end",
  "setMuted",
  "pushAudio",
  "pullAudio",
  "resolveApproval",
  "sendCapture",
  "attachStill",
] as const;

export type CtoVoiceAction = (typeof CTO_VOICE_ACTIONS)[number];

/**
 * What the renderer may ask of a running call. Declared here rather than in a
 * component so the voice surface and the capture surface cannot drift into two
 * shapes of `attachImage`.
 */
export type CtoVoiceBridge = {
  start: () => Promise<CtoVoiceActionResult>;
  /**
   * Hang up, optionally saying why.
   *
   * A reason turns a silent teardown into a sentence on screen. The End button
   * passes none — a call the user chose to end has nothing to explain — but a
   * microphone that will not open does, and without it that failure ended the
   * call with no notice at all: the runtime had nothing to blame, because the
   * hang-up came from this side.
   */
  end: (reason?: string) => Promise<void>;
  pushAudio: (audio: string, level: number) => void;
  setMuted: (muted: boolean) => Promise<void>;
  approve: (id: string) => Promise<void>;
  deny: (id: string) => Promise<void>;
  attachImage: (args: { pngBase64: string; note: string }) => Promise<void>;
  /**
   * Hand the call the still of a scene it drew.
   *
   * The renderer is the only side that can take it — the scene runs in a frame
   * in this window — and the call is the only side that outlives the HUD. So
   * the picture crosses once, as a record of bytes already on disk, and the
   * call carries it into the transcript card the HUD unmount would otherwise
   * take with it.
   */
  attachStill: (args: { still: SceneStillRecord }) => Promise<void>;
  hasKey: () => Promise<boolean>;
  onState: (handler: (state: CtoVoiceStatePayload) => void) => () => void;
  onAudio: (handler: (base64: string) => void) => () => void;
};

export type CtoVoiceCaption = {
  role: "user" | "assistant";
  text: string;
  /** Milliseconds from the start of the call. */
  atMs: number;
  /**
   * The sentence was cut off, not finished.
   *
   * A barge-in truncates the response mid-word, and the transcript that arrives
   * for it is whatever had been said by then — "I'm the CTO" for a sentence
   * that was going somewhere else. Without this the call record and the HUD
   * both claim that half-sentence is all the CTO said, so the caption carries
   * the fact and the surfaces mark it.
   */
  interrupted?: boolean;
};

/**
 * A mutation the CTO wants to run. Reads never produce one of these — they run
 * and narrate. `destructive` decides whether a spoken yes is enough.
 */
export type CtoVoiceConfirmation = {
  id: string;
  /** One line, spoken and shown: "Open a PR for the sync lane?" */
  prompt: string;
  toolName: string;
  destructive: boolean;
  /**
   * The transcript utterance this question belongs to. A yes read out of a
   * TRANSCRIPT only counts when it answers THIS question, inside the window
   * below — otherwise ambient speech, a podcast, or the CTO's own audio could
   * approve something. The model's own approval tool carries no utterance and
   * is not bound this way; it heard the room rather than a transcript of it.
   */
  utteranceId: string | null;
  expiresAtMs: number;
  /**
   * The chat approval this answer releases.
   *
   * A voice confirmation is not a thing on its own — it is the spoken face of a
   * CTO turn parked inside `canUseTool`. Saying yes has to reach that waiter,
   * or the call sounds like it agreed and the turn sits blocked forever.
   */
  approvalItemId?: string | null;
};

/** A spoken yes is only honoured inside this window after the CTO asked. */
export const CTO_VOICE_SPOKEN_CONFIRM_WINDOW_MS = 20_000;


/**
 * What a mid-call capture says when the user sent no note of their own.
 *
 * Shared so the renderer's capture host and the call service cannot drift into
 * two sentences for one gesture.
 */
export const CTO_VOICE_CAPTURE_DEFAULT_NOTE =
  "The user shared the window they are looking at. It is attached to the next backend request.";

/**
 * What a call says when its turn did not produce an answer.
 *
 * A failed turn's error text is not an answer, and the call used to speak it —
 * the user heard the CTO say "Prompt is too long" in its own voice. These are
 * the three things a call may say instead, chosen by CAUSE rather than by
 * matching the error's words. An interrupted turn says nothing at all: the user
 * stopped it on purpose and does not need to be told what they just did.
 */
export const CTO_VOICE_SPOKEN_CONTEXT_OVERFLOW =
  "I can't think about that right now — this chat is over its limit. You can start a fresh CTO session from settings.";

export const CTO_VOICE_SPOKEN_TURN_FAILED =
  "Something went wrong on my side. Nothing was changed.";

/**
 * Why a call was refused before the socket was opened.
 *
 * The start sheet renders a refusal's `detail` verbatim, so this is the whole
 * sentence the user reads — and it names the way out, because the refusal is
 * only recoverable by starting a fresh thread.
 */
export const CTO_VOICE_CHAT_OVER_LIMIT_DETAIL =
  "This chat is over its context limit, so the CTO cannot answer yet. Start a fresh CTO session and try again.";

export type CtoVoiceState = {
  callId: string | null;
  phase: CtoVoicePhase;
  /** Wall-clock ms the call has been connected; drives the pill's timer. */
  elapsedMs: number;
  muted: boolean;
  /** 0..1 input level, for the meter. */
  inputLevel: number;
  /** True for the moment the user talks over the CTO. */
  interrupted: boolean;
  captions: CtoVoiceCaption[];
  /**
   * What the user is saying RIGHT NOW, as far as the transcriber has got.
   *
   * Accumulated from `conversation.item.input_audio_transcription.delta` and
   * cleared the moment the segment completes or fails. It exists because a
   * final transcript can land seconds after the words — and transcripts arrive
   * out of order relative to the segments they belong to — so a HUD that shows
   * only finals looks, to the person talking, like a call that did not hear
   * them. Null whenever nothing is part-heard, including on a surface where the
   * API delivers a transcript as one `.completed` with no deltas at all.
   */
  pendingUserText: string | null;
  pendingConfirmation: CtoVoiceConfirmation | null;
  /** Scene source the call most recently drew, if any. */
  sceneSource: string | null;
  error: string | null;
};

/**
 * The call state as one window receives it.
 *
 * `isCallOwner` is not part of `CtoVoiceState` because the service does not
 * know it and must not appear to: which window is holding the microphone is
 * decided by the main process, per window, at send time.
 *
 * Every window shows the pill, so a call stays visible wherever the user is
 * working. Only one may own the microphone and the speaker — ADE can have
 * several windows open and they all mount the HUD, so without this each of them
 * opened its own microphone and pushed a second PCM stream into one socket.
 */
export type CtoVoiceStatePayload = CtoVoiceState & { isCallOwner: boolean };

export const CTO_VOICE_INITIAL_STATE: CtoVoiceState = {
  callId: null,
  phase: "idle",
  elapsedMs: 0,
  muted: false,
  inputLevel: 0,
  interrupted: false,
  captions: [],
  pendingUserText: null,
  pendingConfirmation: null,
  sceneSource: null,
  error: null,
};

export function voiceCostUsd(elapsedMs: number): number {
  return (elapsedMs / 60_000) * CTO_VOICE_USD_PER_MINUTE;
}

export function formatVoiceElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatVoiceCost(elapsedMs: number): string {
  return `$${voiceCostUsd(elapsedMs).toFixed(2)}`;
}


/**
 * How long after the last queued audio the call waits before hanging up.
 *
 * A goodbye the user does not get to hear is worse than a call that lingers for
 * a beat, and the audio the model has already generated is not yet in anyone's
 * ears: the window that owns the speaker drains the output queue every
 * {@link CTO_VOICE_AUDIO_POLL_INTERVAL_MS}, then pushes it through a playback
 * graph of its own. This covers one missed poll and the graph's own latency.
 */
export const CTO_VOICE_END_CALL_AUDIO_TAIL_MS = 450;

/**
 * How long a request may run in silence before the call says something.
 *
 * Measured on the call of 2026-09-17: an `ask_cto` for "what's going on,
 * visualize it" ran 36 seconds — 7.8 of them before the CTO's first word — and
 * the user heard nothing at all after the acknowledgement. A call that goes
 * quiet for half a minute reads as a call that dropped, and the owner's words
 * for it were "long pauses while it's working".
 *
 * Seven seconds because that is roughly where a turn stops being a beat and
 * starts being a silence: the acknowledgement is usually still playing for the
 * first two or three, and a nudge on top of it would be the call talking over
 * itself.
 */
export const CTO_VOICE_WORKING_NUDGE_AFTER_MS = 7_000;

/**
 * The shortest gap between two of those sentences.
 *
 * Longer than the first wait on purpose. The first one answers "is this thing
 * still on"; the ones after it only have to keep the line warm, and a voice
 * that says something every seven seconds while it works is worse company than
 * one that says nothing.
 */
export const CTO_VOICE_WORKING_NUDGE_EVERY_MS = 12_000;

/**
 * How many of them one request may produce.
 *
 * Three covers about forty seconds of work, which is longer than the slowest
 * turn measured. Past that the model has nothing left to say that is not either
 * a repeat or a guess about a result it has not been given.
 */
export const CTO_VOICE_WORKING_NUDGE_MAX = 3;
