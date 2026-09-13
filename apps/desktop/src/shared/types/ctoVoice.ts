/**
 * CTO voice call — the cross-surface contract.
 *
 * The call runs on GPT Live (`gpt-live-1`) with client delegation: the voice
 * model owns the conversation, and ADE owns the reasoning. That split is the
 * reason the CTO's thinking can stay on the user's existing ChatGPT plan while
 * only the voice minutes bill to their own API key.
 *
 * It also means ADE — not the model — owns permissions and confirmations, so
 * every rule about what a call may do lives here in code rather than in a
 * prompt the model is free to reinterpret.
 */

export const CTO_VOICE_MODEL = "gpt-live-1";
export const CTO_VOICE_ENDPOINT = "wss://api.openai.com/v1/live/sessions";

/** Billed per second; the pill shows the running total from this. */
export const CTO_VOICE_USD_PER_MINUTE = 0.05;

/** PCM16 mono. The rate the Live session is configured with, both directions. */
export const CTO_VOICE_SAMPLE_RATE = 24_000;

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

export type CtoVoiceCaption = {
  role: "user" | "assistant";
  text: string;
  /** Milliseconds from the start of the call. */
  atMs: number;
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
   * The transcript utterance this question belongs to. A spoken yes only counts
   * when it answers THIS question, inside the window below — otherwise ambient
   * speech, a podcast, or the CTO's own audio could approve something.
   */
  utteranceId: string | null;
  expiresAtMs: number;
};

/** A spoken yes is only honoured inside this window after the CTO asked. */
export const CTO_VOICE_SPOKEN_CONFIRM_WINDOW_MS = 20_000;

/**
 * Tool names whose blast radius is other people's work. These always require a
 * tap, never a spoken yes, because a misheard word must not be able to destroy
 * history or publish something.
 */
export const CTO_VOICE_DESTRUCTIVE_TOOLS = [
  "gitPush",
  "gitForcePush",
  "gitUndoLastHeadChange",
  "gitCheckoutBranch",
  "gitStashPop",
  "deleteLane",
  "archiveLane",
  "mergePr",
  "publishRelease",
  "gitResetHard",
  "discardChanges",
] as const;

export function isDestructiveVoiceTool(toolName: string): boolean {
  return (CTO_VOICE_DESTRUCTIVE_TOOLS as readonly string[]).includes(toolName);
}

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
  pendingConfirmation: CtoVoiceConfirmation | null;
  /** Scene source the call most recently drew, if any. */
  sceneSource: string | null;
  error: string | null;
};

export const CTO_VOICE_INITIAL_STATE: CtoVoiceState = {
  callId: null,
  phase: "idle",
  elapsedMs: 0,
  muted: false,
  inputLevel: 0,
  interrupted: false,
  captions: [],
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
 * The conversation prompt, in OpenAI's documented shape for GPT Live: role and
 * tone, then the three policy blocks. Detailed procedure stays with the backend
 * (the CTO thread); the live model only needs to know how to talk and when to
 * hand off.
 */
export function buildCtoVoiceInstructions(args: {
  ctoName: string;
  projectName: string;
  backchannels: boolean;
}): string {
  const backchannel = args.backchannels
    ? "Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response."
    : "Backchannel policy: Do not use backchannels. Stay quiet while the user is speaking.";
  return [
    `You are ${args.ctoName}, the CTO of ${args.projectName}, speaking with the engineer who owns it.`,
    "Speak at an unhurried pace in full sentences. Explain the reasoning before the recommendation when the reasoning is what makes it make sense; skip it when the answer is obvious.",
    "Stay level. No exclamation marks, no 'great question', no congratulating the user for asking.",
    "If you do not know, say so and say what you are checking.",
    "",
    backchannel,
    "",
    "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
    "",
    "Delegation policy:",
    "Backend tools:",
    "- Project state: lanes, pull requests, CI checks, chats, git status, and the project's own memory.",
    "- Project actions: opening lanes, starting work, committing, opening pull requests.",
    "",
    "Delegate to the backend when:",
    "- The request needs live project state, or careful reasoning about this project.",
    "- The user asks you to do something in ADE.",
    "- A correction changes work already requested.",
    "",
    "Do not delegate to the backend when:",
    "- You can answer from the conversation or a result that is still current.",
    "- You need one short clarification to understand the request.",
    "",
    "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.",
    "Never say an action has happened before the backend confirms it.",
  ].join("\n");
}
