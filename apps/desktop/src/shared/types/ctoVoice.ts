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
 * About twenty seconds at the rate GPT Live emits them. Past that the oldest
 * are dropped rather than the process growing without bound; the drop count
 * travels with the drain so the desktop can say the audio broke up rather than
 * silently playing a stale tail.
 */
export const CTO_VOICE_OUTPUT_AUDIO_QUEUE_LIMIT = 200;

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
 * What to say when the microphone will not open.
 *
 * Named per platform because the sentence is only useful if it points at the
 * pane the user has to open, and those are different places. Chosen from the
 * preload platform bridge rather than `navigator.platform`, which cannot tell
 * Windows on ARM from Windows on x64 and has no business deciding this either.
 *
 * It lives here rather than in the component because the same failure has to
 * read identically wherever it surfaces — the HUD's notice and the call's
 * terminal state are the same event.
 */
export function ctoVoiceMicrophoneUnavailableMessage(platform: string): string {
  return platform === "win32"
    ? "ADE could not open the microphone. Allow microphone access for ADE in Windows Settings, Privacy, Microphone."
    : "ADE could not open the microphone. Allow microphone access for ADE in System Settings, Privacy & Security, Microphone.";
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
 * The nine actions a call is driven by, as data.
 *
 * Here rather than beside the service that implements them because the policy
 * tables consume it: this module imports nothing, and `ctoVoiceRuntimeService`
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
  hasKey: () => Promise<boolean>;
  onState: (handler: (state: CtoVoiceStatePayload) => void) => () => void;
  onAudio: (handler: (base64: string) => void) => () => void;
};

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

/**
 * Shell commands whose blast radius is other people's work.
 *
 * The list above names ADE's OWN operations, and a real approval never mentions
 * one: a Claude bash approval arrives as `kind: "command"` with a sentence like
 * "Run command: git push --force origin main". These patterns are the half of
 * the gate that can read that.
 *
 * Deliberately conservative and deliberately over-broad: a false positive costs
 * the user one tap, a false negative costs them history. Anchored on a word
 * boundary so `git pushd` and a path containing "rm -rf" in prose do not match
 * by accident, and applied to the command text only.
 */
const CTO_VOICE_DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b[^\n]*\s(?:--force|-f)\b/i,
  /\bgit\s+push\b[^\n]*--force-with-lease\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+clean\b[^\n]*-[a-z]*[fd]/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+stash\s+(?:drop|clear|pop)\b/i,
  /\brm\s+-[a-z]*[rf]/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgh\s+release\s+(?:create|delete)\b/i,
  /\bgh\s+repo\s+delete\b/i,
  /\bnpm\s+publish\b/i,
];

/**
 * ADE action `domain.action` pairs an agent can reach through
 * `mcp__ade__run_ade_action`, whose effect is the same as the commands above.
 * The tool name alone says nothing here — the payload is where the verb is.
 */
const CTO_VOICE_DESTRUCTIVE_ACTION_VERBS =
  "delete|deleteTemplate|archive|archiveAndReclaim|merge|mergePr|forcePush|gitForcePush"
  + "|resetHard|discardChanges|clearLocalData|undoLastHeadChange|stashPop|checkoutBranch|publishRelease";

/** `lane.delete`, as written in prose or in an `ade actions run` invocation. */
const CTO_VOICE_DESTRUCTIVE_ACTION_PATTERN = new RegExp(
  `\\b(?:lane|pr|git|session|ade_project|project_secret|automations)\\.(?:${CTO_VOICE_DESTRUCTIVE_ACTION_VERBS})\\b`,
  "i",
);

/**
 * The same call as a tool payload: `{"domain":"lane","action":"delete"}`.
 *
 * Read off the `action` field alone, because the verb is what decides and the
 * domain is only there to keep the prose form honest. A payload is the shape an
 * agent's `mcp__ade__run_ade_action` carries, and it never reads as prose.
 */
const CTO_VOICE_DESTRUCTIVE_ACTION_PAYLOAD = new RegExp(
  `"action"\\s*:\\s*"(?:${CTO_VOICE_DESTRUCTIVE_ACTION_VERBS})"`,
  "i",
);

/**
 * Does this command text do something a spoken "yes" must not be able to do?
 *
 * Exported for the gate's own tests; callers should prefer
 * `describeVoiceApproval`, which decides from a whole approval event.
 */
export function isDestructiveVoiceCommand(text: string | null | undefined): boolean {
  const command = typeof text === "string" ? text : "";
  if (!command.trim().length) return false;
  if (CTO_VOICE_DESTRUCTIVE_ACTION_PATTERN.test(command)) return true;
  if (CTO_VOICE_DESTRUCTIVE_ACTION_PAYLOAD.test(command)) return true;
  return CTO_VOICE_DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * The approval shape every provider ends up emitting, as far as this gate cares.
 *
 * `detail` is always an OBJECT, never a string: `{ tool }` for Claude,
 * `{ command, cwd, reason }` for Codex, `{ droidSdk, request, hook }` for Droid,
 * `{ cursorSdk, request, hook, policy }` for Cursor, `{ acp, provider }` for the
 * ACP dialects.
 */
export type CtoVoiceApprovalEvent = {
  kind: string;
  description: string;
  detail?: unknown;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The tool an approval is about, and whether a voice may answer it.
 *
 * Two independent sources, because no provider carries both: the NAME comes out
 * of the structured detail (`detail.tool`, `detail.hook.toolName`,
 * `detail.request.tool`), and the VERDICT comes from the command text when the
 * approval is a command — which is the only place a force-push is visible at
 * all. Falls back to `kind` for the name, which is what the card shows when a
 * provider tells us nothing better.
 */
export function describeVoiceApproval(event: CtoVoiceApprovalEvent): {
  toolName: string;
  destructive: boolean;
} {
  const detail = readRecord(event.detail);
  const hook = readRecord(detail?.hook);
  const request = readRecord(detail?.request);
  const providerMeta = readRecord(request?.providerMetadata);
  const toolName = readString(detail?.tool)
    ?? readString(hook?.toolName)
    ?? readString(request?.tool)
    ?? readString(providerMeta?.tool)
    ?? event.kind;

  // Every place a provider puts the command, because each puts it somewhere
  // else. Claude has it only in the description ("Run command: …"); Codex has
  // it on `detail.command` and in provider metadata, and its description is
  // the model's `reason` whenever there is one — so reading the description
  // alone misses every Codex approval that explained itself.
  const commandText = [
    event.description,
    readString(detail?.command),
    readString(providerMeta?.command),
    readString(readRecord(detail?.input)?.command),
    readString(readRecord(hook?.toolInput)?.command),
    readString(readRecord(providerMeta?.input)?.command),
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");

  return {
    toolName,
    // Four ways in, any of which is enough: an ADE operation named outright, a
    // command whose shape is destructive, a tool we already refuse by name, or
    // an approval we cannot read at all.
    //
    // That last one is ACP (Qwen, Kimi, Copilot). Its card carries
    // `detail: { acp: true, provider }` and a description that is the tool's
    // TITLE — never the command — and its provider metadata holds only ids and
    // option kinds. There is nothing to judge by, and an ACP host only asks at
    // all when it needs permission to change something. An unreadable mutation
    // is exactly what this gate exists for, so it needs a tap: the cost is one
    // extra tap on those three providers, and the alternative is a misheard
    // "yes" approving something nobody could see.
    destructive: detail?.acp === true
      || isDestructiveVoiceTool(toolName)
      || isDestructiveVoiceCommand(commandText),
  };
}

/**
 * What a mid-call capture says when the user sent no note of their own.
 *
 * Shared so the renderer's capture host and the call service cannot drift into
 * two sentences for one gesture.
 */
export const CTO_VOICE_CAPTURE_DEFAULT_NOTE =
  "The user shared the window they are looking at. It is attached to the next backend request.";

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
