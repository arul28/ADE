// ---------------------------------------------------------------------------
// Codex voice sessions — one realtime voice conversation per chat.
//
// Voice always runs on the Codex app server's realtime API (`thread/realtime/*`,
// protocol v3, WebRTC) with the user's ChatGPT sign-in. The renderer owns the
// WebRTC connection, so audio never passes through ADE; the app server answers
// the renderer's offer with a `thread/realtime/sdp` notification.
//
// Two transports, chosen once when a session starts:
// - native: a Codex chat hosts voice on its own thread. Codex runs each
//   hand-off as a turn on that thread; the chat service asks `adoptTurn` about
//   a turn it did not start, so the thread shows it with the spoken request as
//   its user message.
// - host: any other chat gets a private Codex app-server (codexVoiceHost).
//   Hand-offs are client-managed: the spoken request goes into the real chat as
//   a message, the chat's progress is relayed as context, and its final answer
//   is spoken back.
//
// Voice narrates. Both transports set `clientManagedHandoffs`, so Codex never
// speaks an agent's output on its own: ADE streams the followed turn's prose
// into speech as it is written (code stripped out), says the milestones worth
// hearing, and holds the floor only until the user takes it. A `quiet` update
// preference opts out of all of it and speaks the answer once, as voice used to.
//
// The service keeps live captions for the renderer's voice bar (read through
// `getState`) and writes one summary line to the chat when a session ends.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type {
  AgentChatCodexRealtimeCaption,
  AgentChatCodexRealtimeStartArgs,
  AgentChatCodexRealtimeStartResult,
  AgentChatCodexRealtimeState,
  AgentChatCodexRealtimeStateArgs,
  AgentChatCodexRealtimeStopArgs,
  AgentChatEvent,
  AgentChatEventMetadata,
  AgentChatProvider,
  AgentChatSendArgs,
  AgentChatSteerArgs,
} from "../../../shared/types";
import {
  buildCodexVoiceStyleInstructions,
  codexPlanIncludesVoice,
  formatCodexVoiceDuration,
  normalizeCodexVoicePreferences,
  type CodexVoicePreferences,
  type CodexVoiceUpdateLevel,
} from "../../../shared/codexVoice";
import { activeTurnDispatchModes } from "../../../shared/types/chat";
import { providerDisplayLabel } from "../../../shared/pendingInputLabels";
import type { Logger } from "../logging/logger";
import { captureFeatureUsedAnalytics, type FeatureAnalytics } from "../analytics/featureProductAnalytics";
import { startCodexVoiceHost, type CodexVoiceHost } from "./codexVoiceHost";

const ANSWER_TIMEOUT_MS = 20_000;
const CAPTION_LIMIT = 4;
const ENDED_RETENTION_MS = 60_000;
/** A hand-off starts its turn within a second or two; older requests never got one. */
const REQUEST_CLAIM_MS = 15_000;
const STATUS_INTERVAL_MS = 8_000;
const SPOKEN_ANSWER_CHARS = 2_000;
/** The renderer reads state every 300 ms; this long without a read means its window is gone. */
const ORPHAN_AFTER_MS = 15_000;
const ORPHAN_CHECK_MS = 5_000;
const HISTORY_ENTRIES = 12;
const HISTORY_ENTRY_CHARS = 1_500;
/**
 * Narration. Voice is metered by the minute, not by the word, so the throttle
 * below is set by what is pleasant to listen to: a narrator that talks
 * continuously is worse than one that stays quiet.
 */
/** Milestones are said at most this far apart, however many the agent produces. */
const NARRATION_MIN_GAP_MS = 12_000;
/**
 * Silence longer than this invites a progress line. Left to itself the realtime
 * model fills a quiet stretch with "still on it"; handing it what the agent is
 * actually doing is what turns that pause into something worth hearing.
 */
const NARRATION_IDLE_MS = 20_000;
/** Prose held for a sentence ending waits at most this long before being said anyway. */
const SPEECH_FLUSH_MS = 2_500;
/** Shorter than this, a fragment joins the next sentence instead of being said alone. */
const SPEECH_MIN_CHARS = 24;
/** The user always wins: speech stops for this long after their last transcribed words. */
const BARGE_IN_HOLD_MS = 1_800;
/** A fence that never closes cannot grow past this before its contents are dropped. */
const FENCE_LIMIT_CHARS = 4_000;
/** Opening or closing line of a markdown code fence. */
const FENCE_LINE = /^\s*(?:```|~~~)/;
/** Commands worth hearing about as they start, rather than when they finish. */
const LONG_COMMAND = /\b(?:test|tests|build|lint|typecheck|type-check|compile|e2e|install|migrate|deploy)\b/i;
/**
 * Asking to hang up. Deliberately explicit: "is this going to end the call?"
 * must not hang up on the user, so a bare farewell counts only when it is the
 * whole utterance and short.
 */
const END_REQUEST_PHRASE = /\b(?:end|stop|close|finish|leave)\b[^.?!]{0,24}\b(?:call|conversation|voice|session)\b/i;
/** "Hang up" names the act on its own; it needs no object to be unambiguous. */
const END_REQUEST_HANGUP = /\bhang\s*up\b/i;
const END_REQUEST_FAREWELL = /^(?:(?:ok(?:ay)?|alright|all right)[,\s]+)?(?:bye|bye[ -]?bye|goodbye|good[ -]?bye|see (?:ya|you)|that'?s (?:all|it)|we'?re done|i'?m done|nothing else)(?:[,\s]+(?:for now|for today|thanks|thank you|then))?[.!,\s]*$/i;
/** "Don't end the call", "no need to hang up" — the same words, the opposite meaning. */
const END_REQUEST_VETO = /\b(?:don'?t|doesn'?t|won'?t|wouldn'?t|not|never|no)\b[^.]{0,14}\b(?:end|stop|hang|close|finish|leave)\b/i;
/** A question is a request only when it is actually asking for one. */
const END_REQUEST_ASK = /^(?:please\s+)?(?:can|could|would|will|go ahead|just)\b/i;
/** How long the voice gets to say goodbye before the call actually closes. */
const END_GRACE_MS = 3_500;
/** The agent gets this frame so "you" and "this" read right; the thread shows only the spoken words. */
const VOICE_REQUEST_FRAME = "[The user said this aloud in an ADE voice conversation with this chat. Answer as you would a typed message; a voice assistant reads your reply to them, so lead with the answer.]";

/** The Codex runtime surface voice needs from a native Codex chat. */
export type CodexVoiceRuntime = {
  request: <T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<T>;
  activeTurnId: string | null;
  awaitingTurnStart: boolean;
  accountPlanType?: string | null;
};

/** The chat surface voice needs; the chat service's managed session satisfies it. */
export type CodexVoiceChat = {
  session: { id: string; provider: AgentChatProvider; model: string };
  runtime: unknown;
  laneWorktreePath: string;
  recentConversationEntries: Array<{ role: "user" | "assistant"; text: string; displayText?: string }>;
};

export type CodexVoiceSessionDeps<TChat extends CodexVoiceChat, TRuntime extends CodexVoiceRuntime> = {
  logger: Logger;
  analytics?: FeatureAnalytics | null;
  requestTimeoutMs: number;
  ensureChat: (sessionId: string) => TChat;
  emitChatEvent: (chat: TChat, event: AgentChatEvent) => void;
  sendMessage: (args: AgentChatSendArgs) => Promise<unknown>;
  steer: (args: AgentChatSteerArgs) => Promise<unknown>;
  /** True while the chat has a turn that a new message would join or queue behind. */
  chatIsRunning: (chat: TChat) => boolean;
  /** The chat's Codex runtime when it is a native Codex chat, started if needed. */
  ensureCodexRuntime: (chat: TChat) => Promise<TRuntime>;
  ensureCodexThread: (chat: TChat, runtime: TRuntime) => Promise<string>;
  resolveCodexExecutable: (chat: TChat) => { executable: string; env: NodeJS.ProcessEnv };
  chatSummary: (sessionId: string) => { title?: string | null; laneName?: string | null } | null;
};

/** Where one voice session runs. Chosen once at start. */
type Transport<TRuntime> = {
  kind: "native" | "host";
  threadId: string;
  request: (method: string, params: unknown) => Promise<unknown>;
  /** The native runtime, for turn adoption and the working flag. */
  runtime: TRuntime | null;
  /**
   * Ends the realtime call. `userInitiated` is false when OpenAI or Codex
   * already ended it; `immediate` (shutdown) does not wait for the stop reply.
   */
  release: (userInitiated: boolean, immediate?: boolean) => void;
};

/**
 * The chat turn the voice is following. Its prose is streamed into speech as it
 * is written, in both modes, so the voice talks about the work while it happens
 * instead of reading the finished answer once.
 */
type VoiceTurnStream = {
  /** Everything the turn has written, so its end can tell what was already said. */
  text: string;
  /** Raw stream waiting for a line or a sentence ending. */
  pending: string;
  /** Prose that has ended but is not yet worth a sentence of its own. */
  carry: string;
  /** Inside a fenced code block. Code is dropped, never spoken. */
  inFence: boolean;
  /** Whether this turn has been spoken from at all. */
  spoke: boolean;
  /** host: a queued request is answered by the turn after the running one. */
  waitForNextTurn: boolean;
  flushTimer: NodeJS.Timeout | null;
};

type VoiceSession<TRuntime> = {
  token: string;
  mode: "native" | "host";
  /** How much the user asked to hear; `quiet` is what voice did before a narrator existed. */
  updates: CodexVoiceUpdateLevel;
  /** Null while the session is still starting. */
  transport: Transport<TRuntime> | null;
  startedAt: number;
  live: boolean;
  finished: boolean;
  answer: { resolve: (sdp: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null;
  captions: AgentChatCodexRealtimeCaption[];
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  handoffs: number;
  realtimeSessionId: string | null;
  /** native: spoken requests waiting for the turn they start (or shown in the running one). */
  voiceRequests: Array<{ text: string; shownInTurnId: string | null; at: number }>;
  /** The turn the voice is following, or null when the voice is not following one. */
  turn: VoiceTurnStream | null;
  lastStatusAt: number;
  /** When the voice last spoke, for the milestone gap. */
  lastSpokeAt: number;
  /** When the user's words were last transcribed, for barge-in. */
  lastUserAt: number;
  /** Milestones already said for the current turn, so none is said twice. */
  said: Set<string>;
  /** One line held back because the user was talking; said as soon as they stop. */
  deferred: string | null;
  deferTimer: NodeJS.Timeout | null;
  /** The user asked, out loud, for the call to be over. */
  endRequested: boolean;
  /**
   * Set just before this session's `thread/realtime/start` goes out. On a Codex
   * chat the thread is shared, so an earlier call's late `closed` or `error`
   * must not end a session that has not started its own call yet.
   */
  startSent: boolean;
  lastReadAt: number;
  orphanTimer: NodeJS.Timeout | null;
  /**
   * Codex sends transcript items (`item/*`) in native mode but only the flat
   * `transcript/delta` / `transcript/done` pair with client-managed hand-offs.
   */
  flatCaptionSeq: number;
};

export function createCodexVoiceSessions<
  TChat extends CodexVoiceChat,
  TRuntime extends CodexVoiceRuntime,
>(deps: CodexVoiceSessionDeps<TChat, TRuntime>) {
  const { logger } = deps;
  const sessions = new Map<string, VoiceSession<TRuntime>>();
  // How a recent session ended, so its renderer can show why after the state is gone.
  const ended = new Map<string, { error: string | null; at: number }>();

  /** OpenAI errors arrive as a JSON body inside the message; keep only its sentence. */
  const humanizeError = (raw: string): string => {
    const text = raw.trim();
    const start = text.indexOf("{");
    if (start >= 0) {
      try {
        const parsed = JSON.parse(text.slice(start)) as { error?: { message?: unknown }; message?: unknown };
        const message = parsed.error?.message ?? parsed.message;
        if (typeof message === "string" && message.trim()) return message.trim();
      } catch {
        // Not JSON; fall through to the raw text.
      }
    }
    return text || "Codex voice failed.";
  };

  const summarizeParams = (params: Record<string, unknown>): Record<string, unknown> => {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "threadId") continue;
      if (key === "sdp" && typeof value === "string") {
        summary.sdpBytes = value.length;
      } else if (key === "audio") {
        summary.audio = "[omitted]";
      } else {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        summary[key] = text && text.length > 400 ? `${text.slice(0, 400)}…` : value;
      }
    }
    return summary;
  };

  /**
   * Ends a session exactly once. Its resources are always released; only the
   * chat's current session is removed from the map and gets a summary line.
   */
  const finish = (
    chat: TChat,
    session: VoiceSession<TRuntime>,
    error: string | null,
    userInitiated: boolean,
    immediate = false,
  ): void => {
    if (session.finished) return;
    session.finished = true;
    if (session.orphanTimer) clearInterval(session.orphanTimer);
    if (session.turn?.flushTimer) clearTimeout(session.turn.flushTimer);
    if (session.deferTimer) clearTimeout(session.deferTimer);
    session.deferred = null;
    if (session.answer) {
      clearTimeout(session.answer.timer);
      session.answer.reject(new Error(error ?? "Voice was stopped."));
      session.answer = null;
    }
    session.transport?.release(userInitiated, immediate);
    if (sessions.get(chat.session.id) !== session) return;
    sessions.delete(chat.session.id);
    const now = Date.now();
    for (const [sessionId, entry] of ended) {
      if (now - entry.at > ENDED_RETENTION_MS) ended.delete(sessionId);
    }
    ended.set(chat.session.id, { error, at: now });
    logger.info("agent_chat.codex_realtime_finished", {
      sessionId: chat.session.id,
      mode: session.mode,
      threadId: session.transport?.threadId ?? null,
      durationMs: now - session.startedAt,
      lines: session.transcript.length,
      handoffs: session.handoffs,
      error,
    });
    // A session that never went live failed to start; the renderer shows why.
    if (!session.live) return;
    if (!session.transcript.length && !error) return;
    const requests = session.transcript.filter((line) => line.role === "user").length;
    const parts = [`Voice conversation · ${formatCodexVoiceDuration(now - session.startedAt)}`];
    if (requests) parts.push(`${requests} ${requests === 1 ? "request" : "requests"}`);
    if (session.handoffs) parts.push(`${session.handoffs} handed to the agent`);
    deps.emitChatEvent(chat, {
      type: "system_notice",
      noticeKind: error ? "warning" : "info",
      status: "voice_session",
      // `message` stays the one-line summary every other surface reads; the
      // chat draws its own card from the structured copy, so it never has to
      // parse the duration and counts back out of this sentence.
      message: error ? `${parts.join(" · ")} · ended: ${error}` : parts.join(" · "),
      detail: {
        voiceSession: {
          durationMs: now - session.startedAt,
          requests,
          handoffs: session.handoffs,
          endedByVoice: session.endRequested,
          error,
          transcript: session.transcript.map((line) => ({ role: line.role, text: line.text })),
        },
      },
    });
  };

  const upsertCaption = (
    session: VoiceSession<TRuntime>,
    id: string,
    patch: { role?: "user" | "assistant"; delta?: string; text?: string; final?: boolean },
  ): void => {
    let caption = session.captions.find((entry) => entry.id === id);
    if (!caption) {
      if (!patch.role) return;
      caption = { id, role: patch.role, text: "", final: false };
      session.captions.push(caption);
      if (session.captions.length > CAPTION_LIMIT) {
        session.captions.splice(0, session.captions.length - CAPTION_LIMIT);
      }
    }
    if (patch.delta) caption.text += patch.delta;
    if (typeof patch.text === "string") caption.text = patch.text;
    if (patch.final) caption.final = true;
  };

  const voiceInputMetadata = (session: VoiceSession<TRuntime>): AgentChatEventMetadata => ({
    voiceInput: { realtimeSessionId: session.realtimeSessionId ?? session.transport?.threadId ?? session.token },
  });

  const emitSpokenUserMessage = (chat: TChat, session: VoiceSession<TRuntime>, text: string, turnId: string): void => {
    deps.emitChatEvent(chat, { type: "user_message", text, turnId, metadata: voiceInputMetadata(session) });
  };

  // ---------------------------------------------------------------------------
  // Saying things. The voice model phrases whatever it is handed, so all this
  // decides is when it speaks and what it is told. Two rules live here in one
  // place, and they are what keep a narrator pleasant rather than maddening:
  // the user always wins, and the voice never talks faster than it has
  // something worth saying.
  // ---------------------------------------------------------------------------

  /** Prose the voice should not read aloud. Fenced code is removed before this runs. */
  const stripMarkdown = (text: string): string => text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, "$1$2")
    .replace(/^\s*#{1,6}\s*/g, "")
    .replace(/^\s*[-*+]\s+/g, "")
    .replace(/^\s*>\s?/g, "")
    .replace(/\s+/g, " ")
    .trim();

  /** How much of the buffered prose reads as a sentence now; `force` takes all of it. */
  const takeSentences = (carry: string, force: boolean): { spoken: string; rest: string } => {
    if (force) return { spoken: carry, rest: "" };
    const match = /[\s\S]*[.!?…]["')\]]?(?=\s|$)/.exec(carry);
    if (match) return { spoken: match[0], rest: carry.slice(match[0].length) };
    // No sentence ending yet. A long unpunctuated line (a heading, a bullet) is
    // the one case where waiting for one would mean never speaking at all.
    return carry.trim().length >= SPEECH_MIN_CHARS ? { spoken: carry, rest: "" } : { spoken: "", rest: carry };
  };

  /** The user has the floor: their words cancel whatever the voice was about to say. */
  const userHoldsFloor = (session: VoiceSession<TRuntime>): boolean =>
    Date.now() - session.lastUserAt < BARGE_IN_HOLD_MS;

  /** Hands the voice one line to phrase and say now. False when it stayed quiet. */
  const speakNow = (chat: TChat, session: VoiceSession<TRuntime>, text: string): boolean => {
    const line = text.trim();
    // Nothing new is narrated once the call is on its way out; the goodbye is
    // the model's own and must not be talked over.
    if (!line || !session.live || !session.transport || session.endRequested || userHoldsFloor(session)) return false;
    session.lastSpokeAt = Date.now();
    void session.transport.request("thread/realtime/appendSpeech", {
      threadId: session.transport.threadId,
      text: line,
    }).catch((error: unknown) => {
      logger.warn("agent_chat.codex_realtime_speak_failed", {
        sessionId: chat.session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  };

  /** Holds a line for the moment the user stops talking, and says it then. */
  const deferSpeech = (chat: TChat, session: VoiceSession<TRuntime>, text: string): void => {
    session.deferred = text;
    if (session.deferTimer) return;
    session.deferTimer = setTimeout(() => {
      session.deferTimer = null;
      const line = session.deferred;
      if (session.finished || !line) return;
      if (userHoldsFloor(session)) {
        deferSpeech(chat, session, line);
        return;
      }
      session.deferred = null;
      speakNow(chat, session, line);
    }, BARGE_IN_HOLD_MS);
    session.deferTimer.unref?.();
  };

  /**
   * A result, which is never dropped for the sake of barge-in: it waits for the
   * user instead. Losing "the tests failed" because they were talking would be
   * a worse failure than the interruption it avoided.
   */
  const speakResult = (chat: TChat, session: VoiceSession<TRuntime>, text: string): void => {
    if (speakNow(chat, session, text)) return;
    if (session.live) deferSpeech(chat, session, text);
  };

  /** Context for the voice to use if the user asks. It is never said on its own. */
  const tellContext = (chat: TChat, session: VoiceSession<TRuntime>, text: string): void => {
    if (!session.live || !session.transport) return;
    void session.transport.request("thread/realtime/appendText", {
      threadId: session.transport.threadId,
      text,
      role: "developer",
    }).catch((error: unknown) => {
      logger.warn("agent_chat.codex_realtime_tell_failed", {
        sessionId: chat.session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /** Only `quiet` opts out of narration; it is what voice did before a narrator existed. */
  const narrationEnabled = (session: VoiceSession<TRuntime>): boolean => session.updates !== "quiet";

  /** A milestone worth hearing: said once, never in a burst, never over the user. */
  const narrate = (chat: TChat, session: VoiceSession<TRuntime>, key: string, text: string): void => {
    if (!narrationEnabled(session) || session.said.has(key)) return;
    if (Date.now() - session.lastSpokeAt < NARRATION_MIN_GAP_MS) return;
    session.said.add(key);
    speakNow(chat, session, text);
  };

  const newTurnStream = (waitForNextTurn: boolean): VoiceTurnStream => ({
    text: "",
    pending: "",
    carry: "",
    inFence: false,
    spoke: false,
    waitForNextTurn,
    flushTimer: null,
  });

  /** Follows a new turn. `said` is per turn so a milestone can be repeated in the next one. */
  const beginTurn = (session: VoiceSession<TRuntime>, waitForNextTurn: boolean): void => {
    if (session.turn?.flushTimer) clearTimeout(session.turn.flushTimer);
    session.said.clear();
    session.turn = newTurnStream(waitForNextTurn);
  };

  const endTurn = (session: VoiceSession<TRuntime>): void => {
    if (session.turn?.flushTimer) clearTimeout(session.turn.flushTimer);
    session.turn = null;
  };

  /**
   * Moves finished prose out of the raw stream. A fenced block is dropped whole,
   * opening fence to closing one: an agent writes far more code than prose, and
   * reading it aloud is the fastest way to make voice feel worse than silence.
   * Outside a fence, text is taken a sentence at a time, so an answer with no
   * line breaks in it still starts speaking while it is being written.
   */
  const drainStream = (turn: VoiceTurnStream): void => {
    let index = 0;
    while (index < turn.pending.length) {
      const newline = turn.pending.indexOf("\n", index);
      const wholeLine = newline >= 0;
      const line = wholeLine ? turn.pending.slice(index, newline) : turn.pending.slice(index);
      if (FENCE_LINE.test(line)) {
        turn.inFence = !turn.inFence;
      } else if (turn.inFence) {
        // Code. Dropped along with the rest of the block.
      } else if (wholeLine) {
        turn.carry += `${line} `;
      } else {
        const match = /[\s\S]*[.!?…]["')\]]?(?=\s|$)/.exec(line);
        if (!match) break; // Still being written; wait for the sentence to end.
        turn.carry += `${match[0]} `;
        turn.pending = turn.pending.slice(index + match[0].length);
        return;
      }
      index = wholeLine ? newline + 1 : turn.pending.length;
    }
    turn.pending = turn.pending.slice(index);
    // A fence that never closes is a stream that was cut off mid-code. It is
    // still code, so it is dropped rather than saved up forever.
    if (turn.inFence && turn.pending.length > FENCE_LIMIT_CHARS) turn.pending = "";
  };

  /** Says as much of the buffered prose as reads as a sentence. */
  const flushStream = (chat: TChat, session: VoiceSession<TRuntime>, force: boolean): void => {
    const turn = session.turn;
    if (!turn) return;
    if (force && turn.pending) {
      if (!turn.inFence) turn.carry += `${turn.pending} `;
      turn.pending = "";
    }
    const { spoken, rest } = takeSentences(turn.carry, force);
    turn.carry = rest;
    const line = stripMarkdown(spoken);
    if (!line || !narrationEnabled(session)) return;
    // Dropped, not queued: narration of a step that already finished is worse
    // than saying nothing about it.
    if (speakNow(chat, session, line)) turn.spoke = true;
  };

  /** Says what is buffered once the stream pauses, so prose without endings is not stuck. */
  const scheduleFlush = (chat: TChat, session: VoiceSession<TRuntime>): void => {
    const turn = session.turn;
    if (!turn || turn.flushTimer) return;
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = null;
      flushStream(chat, session, false);
    }, SPEECH_FLUSH_MS);
    turn.flushTimer.unref?.();
  };

  /** The agent's prose, spoken as it is written. */
  const addStreamText = (chat: TChat, session: VoiceSession<TRuntime>, delta: string): void => {
    const turn = session.turn;
    if (!turn) return;
    turn.text += delta;
    if (!narrationEnabled(session) || !delta) return;
    turn.pending += delta;
    drainStream(turn);
    flushStream(chat, session, false);
    if (turn.carry.trim() || turn.pending.trim()) scheduleFlush(chat, session);
  };

  /** An answer with its code removed, for a turn that was never streamed. */
  const speakableText = (text: string): string => {
    const kept: string[] = [];
    let inFence = false;
    for (const line of text.split("\n")) {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (!inFence) kept.push(line);
    }
    return stripMarkdown(kept.join(" "));
  };

  /** The first line of a command, short enough to say out loud. */
  const summarizeCommand = (command: string): string => {
    const first = command.trim().split("\n")[0]?.trim() ?? "";
    return first.length > 60 ? `${first.slice(0, 60)}…` : first;
  };

  /** A short, speakable description of what the agent is doing, or null. */
  const describeProgress = (event: AgentChatEvent): string | null => {
    switch (event.type) {
      case "command": {
        const command = event.command.trim().split("\n")[0] ?? "";
        return command ? `running a command: ${command.slice(0, 80)}` : "running a command";
      }
      case "tool_call":
        return event.tool.trim() ? `using ${event.tool.trim()}` : "using a tool";
      case "file_change":
        return "editing files";
      case "web_search":
        return "searching the web";
      default:
        return null;
    }
  };

  /**
   * host mode. Sends the spoken request into the chat the same way typing
   * does: a new turn when the chat is idle, into the running turn when the
   * provider can take it, otherwise queued behind it.
   */
  const routeRequest = async (chat: TChat, session: VoiceSession<TRuntime>, text: string): Promise<void> => {
    const sessionId = chat.session.id;
    const metadata = voiceInputMetadata(session);
    const framed = `${VOICE_REQUEST_FRAME}\n\n${text}`;
    const running = deps.chatIsRunning(chat);
    const inline = running && activeTurnDispatchModes(chat.session.provider).includes("inline");
    // A queued request is answered by the turn after the running one, so the
    // running turn's end must not be spoken as its answer.
    beginTurn(session, running && !inline);
    try {
      if (inline) {
        await deps.steer({ sessionId, text: framed, displayText: text, metadata, dispatchMode: "inline" });
      } else {
        await deps.sendMessage({ sessionId, text: framed, displayText: text, metadata });
      }
      session.handoffs += 1;
      logger.info("agent_chat.codex_realtime_routed", {
        sessionId,
        provider: chat.session.provider,
        running,
        inline,
        chars: text.length,
      });
    } catch (error) {
      endTurn(session);
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("agent_chat.codex_realtime_route_failed", { sessionId, error: message });
      speakResult(chat, session, `That did not reach the chat: ${message}`);
    }
  };

  /**
   * Relays the chat's own events into its live voice session. Called for every
   * chat event, in both modes: a Codex chat is narrated by ADE exactly the way
   * any other chat is, so voice behaves the same whichever agent is behind it.
   */
  const observeChatEvent = (chat: TChat, event: AgentChatEvent): void => {
    const session = sessions.get(chat.session.id);
    if (!session?.live) return;
    if (event.type === "subagent_started" || event.type === "subagent_result") {
      const name = event.label?.trim()
        || (event.type === "subagent_started" ? event.description?.trim() : undefined)
        || "The subagent";
      if (event.type === "subagent_started") {
        tellContext(
          chat,
          session,
          `[ADE] Subagent "${name}" started. It keeps running after the agent's turn ends; it is not done until ADE says it finished.`,
        );
        return;
      }
      const outcome = event.status === "completed" ? "finished" : event.status === "failed" ? "failed" : "was stopped";
      speakResult(chat, session, `${name} ${outcome}.`);
      const summary = (event.finalSummary ?? event.summary ?? "").trim();
      if (summary) {
        tellContext(chat, session, `[ADE] Subagent "${name}" ${outcome}. Its report (shown in the chat): ${summary.slice(0, 1_500)}`);
      }
      return;
    }
    // Everything below follows the turn the voice handed off.
    const turn = session.turn;
    if (!turn) return;
    if (event.type === "status" && event.turnStatus === "started") {
      // A turn starting while this request is still queued is the turn it was
      // queued behind, so this one began: follow it from the top.
      if (turn.waitForNextTurn) beginTurn(session, false);
      return;
    }
    if (turn.waitForNextTurn) return;
    if (event.type === "text") {
      addStreamText(chat, session, event.text);
      return;
    }
    // An announced plan is the clearest signal of where the work is going, so
    // it is the one milestone worth interrupting for. A plan arrives in pieces,
    // and `narrate` says each key once per turn, so only the first lands.
    if (event.type === "plan") {
      const explanation = (event.explanation ?? "").trim();
      if (explanation && event.steps.length > 1) narrate(chat, session, "plan", explanation);
      return;
    }
    const progress = describeProgress(event);
    if (progress) {
      const now = Date.now();
      if (now - session.lastStatusAt >= STATUS_INTERVAL_MS) {
        session.lastStatusAt = now;
        tellContext(chat, session, `[STATUS] The agent is ${progress}.`);
        // A long quiet stretch is where the realtime model starts padding. Say
        // what is actually happening instead — but only once the voice has been
        // silent long enough that the user is listening to nothing.
        if (narrationEnabled(session) && now - session.lastSpokeAt >= NARRATION_IDLE_MS) {
          narrate(chat, session, `progress:${progress}`, `It's ${progress}.`);
        }
      }
      // A long command is the one tool event worth hearing as it starts; the
      // rest are noise, which is what makes a narrator tiring.
      if (session.updates === "chatty" && event.type === "command" && event.status === "running" && LONG_COMMAND.test(event.command)) {
        const command = summarizeCommand(event.command);
        if (command) narrate(chat, session, "command", `It's running ${command} now — that one takes a bit.`);
      }
      return;
    }
    if (event.type === "error") {
      endTurn(session);
      const message = event.message.trim();
      speakResult(chat, session, `The agent hit an error${message ? `: ${message.slice(0, 200)}` : "."}`);
      return;
    }
    if (event.type === "done") {
      // Whatever is still buffered is the tail of the answer; saying it here is
      // what replaces reading the whole thing out at once.
      flushStream(chat, session, true);
      const spoke = turn.spoke;
      const answer = speakableText(turn.text);
      endTurn(session);
      if (spoke) return;
      // Nothing was streamed — the user had the floor, or the preference is
      // `quiet` — so the answer is spoken whole, as voice always did.
      speakResult(
        chat,
        session,
        answer
          ? answer.length > SPOKEN_ANSWER_CHARS ? `${answer.slice(0, SPOKEN_ANSWER_CHARS)}…` : answer
          : "The agent finished without a written answer.",
      );
    }
  };

  /**
   * native mode. A Codex turn the chat service did not start: while voice is
   * live on this chat it is a voice hand-off, so adopt it and show the spoken
   * request as its user message. Returns false when no voice session explains it.
   */
  const adoptTurn = (chat: TChat, runtime: TRuntime, turnId: string): boolean => {
    const session = sessions.get(chat.session.id);
    if (!session || session.transport?.kind !== "native" || session.transport.runtime !== runtime) return false;
    // A turn nobody routed — Codex's own follow-up to a hand-off — is still the
    // voice's to narrate, so follow it when no hand-off already did.
    if (!session.turn) beginTurn(session, false);
    const now = Date.now();
    const request = session.voiceRequests.find(
      (entry) => entry.shownInTurnId === null && now - entry.at <= REQUEST_CLAIM_MS,
    );
    if (request) {
      request.shownInTurnId = turnId;
      emitSpokenUserMessage(chat, session, request.text, turnId);
    }
    logger.info("agent_chat.codex_realtime_turn_adopted", {
      sessionId: chat.session.id,
      turnId,
      hadRequestText: Boolean(request),
    });
    return true;
  };

  const handleHandoff = (chat: TChat, session: VoiceSession<TRuntime>, text: string): void => {
    // Asking to hang up is not work for the agent. The voice hands it over like
    // any other request, and routing it produced a chat turn explaining that
    // the agent could not end a call it was never able to end. The call ends
    // instead, whichever of the two notices arrives first.
    if (asksToEnd(text)) {
      requestEnd(chat, session);
      return;
    }
    if (session.mode === "host") {
      void routeRequest(chat, session, text);
      return;
    }
    // Codex runs the hand-off as a turn on the chat's own thread. ADE follows
    // it exactly as it follows a routed turn on any other provider.
    session.handoffs += 1;
    beginTurn(session, false);
    const runtime = session.transport?.runtime ?? null;
    const runningTurnId = runtime?.activeTurnId ?? null;
    if (runningTurnId && chat.runtime === runtime) {
      // Codex steers the running turn with it; show it there now.
      emitSpokenUserMessage(chat, session, text, runningTurnId);
      session.voiceRequests.push({ text, shownInTurnId: runningTurnId, at: Date.now() });
    } else {
      session.voiceRequests.push({ text, shownInTurnId: null, at: Date.now() });
    }
    if (session.voiceRequests.length > 16) session.voiceRequests.splice(0, session.voiceRequests.length - 16);
  };

  /** A `thread/realtime/*` notification from whichever app server carries the chat's voice. */
  const handleNotification = (chat: TChat, method: string, params: Record<string, unknown>): void => {
    const sessionId = chat.session.id;
    const session = sessions.get(sessionId);
    if (
      method !== "thread/realtime/outputAudio/delta"
      && method !== "thread/realtime/transcript/delta"
      && method !== "thread/realtime/item/transcript/delta"
    ) {
      logger.info("agent_chat.codex_realtime_event", {
        sessionId,
        method,
        active: Boolean(session),
        ...summarizeParams(params),
      });
    }
    if (!session) return;
    // Before this session sends its own start, call-level events belong to an
    // earlier call on the same thread.
    if (!session.startSent && (
      method === "thread/realtime/sdp"
      || method === "thread/realtime/error"
      || method === "thread/realtime/closed"
    )) return;
    const item = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : null;
    switch (method) {
      case "thread/realtime/sdp": {
        const sdp = typeof params.sdp === "string" ? params.sdp : "";
        if (session.answer && sdp) {
          clearTimeout(session.answer.timer);
          session.answer.resolve(sdp);
          session.answer = null;
        }
        return;
      }
      case "thread/realtime/error":
        finish(chat, session, humanizeError(typeof params.message === "string" ? params.message : ""), false);
        return;
      case "thread/realtime/closed": {
        const reason = typeof params.reason === "string" ? params.reason : "";
        finish(chat, session, reason && reason !== "requested" ? `closed (${reason})` : null, false);
        return;
      }
      case "thread/realtime/started":
        if (typeof params.realtimeSessionId === "string") session.realtimeSessionId = params.realtimeSessionId;
        return;
      case "thread/realtime/outputAudio/delta":
        // The model is talking. That counts as speaking, so the silence the
        // progress narration waits for is real silence and never the model's
        // own words being talked over.
        session.lastSpokeAt = Date.now();
        return;
      case "thread/realtime/item/started": {
        if (session.mode === "host") return;
        if (item?.type !== "transcriptSegment" || typeof item.id !== "string") return;
        // The user's own words are the barge-in signal: from here the voice
        // stays quiet until they have finished.
        if (item.role === "user") session.lastUserAt = Date.now();
        upsertCaption(session, item.id, {
          role: item.role === "user" ? "user" : "assistant",
          text: typeof item.text === "string" ? item.text : "",
        });
        return;
      }
      case "thread/realtime/item/transcript/delta": {
        if (session.mode === "host") return;
        const itemId = typeof params.itemId === "string" ? params.itemId : "";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (itemId && delta) upsertCaption(session, itemId, { delta });
        return;
      }
      case "thread/realtime/item/completed": {
        if (session.mode === "host") return;
        if (item?.type !== "transcriptSegment" || typeof item.id !== "string") return;
        const role = item.role === "user" ? "user" : "assistant";
        const text = typeof item.text === "string" ? item.text.trim() : "";
        upsertCaption(session, item.id, { role, text, final: true });
        if (text) session.transcript.push({ role, text });
        if (role === "user" && asksToEnd(text)) requestEnd(chat, session);
        return;
      }
      // With client-managed hand-offs Codex sends only this flat pair; native
      // sessions use the items above, so each mode reads exactly one source.
      case "thread/realtime/transcript/delta": {
        if (session.mode !== "host") return;
        const role = params.role === "user" ? "user" : "assistant";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!delta) return;
        if (role === "user") session.lastUserAt = Date.now();
        const id = `flat-${role}-${session.flatCaptionSeq}`;
        const open = session.captions.some((caption) => caption.id === id && !caption.final);
        upsertCaption(session, id, open ? { delta } : { role, delta });
        return;
      }
      case "thread/realtime/transcript/done": {
        if (session.mode !== "host") return;
        const role = params.role === "user" ? "user" : "assistant";
        const text = typeof params.text === "string" ? params.text.trim() : "";
        const id = `flat-${role}-${session.flatCaptionSeq}`;
        session.flatCaptionSeq += 1;
        if (!text) return;
        upsertCaption(session, id, { role, text, final: true });
        session.transcript.push({ role, text });
        if (role === "user" && asksToEnd(text)) requestEnd(chat, session);
        return;
      }
      case "thread/realtime/itemAdded": {
        const raw = params.item;
        const added = typeof raw === "string"
          ? (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })()
          : item;
        if (added?.type !== "handoff_request") return;
        // Counted where the request actually reaches a chat: a hand-off the
        // route refuses was never handed to the agent, and the summary line
        // must not claim it was.
        const text = typeof added.input_transcript === "string" ? added.input_transcript.trim() : "";
        if (text) handleHandoff(chat, session, text);
        return;
      }
      default:
        return;
    }
  };

  /**
   * What the voice model knows before the first word. Codex's own startup
   * context covers the workspace and recent threads; this adds what only ADE
   * knows, the user's voice style, and the chat's latest messages.
   */
  const buildInitialItems = (
    chat: TChat,
    preferences: CodexVoicePreferences,
  ): Array<{ role: "user" | "developer" | "assistant"; text: string }> => {
    const summary = deps.chatSummary(chat.session.id);
    const provider = chat.session.provider;
    const context = [
      `You are the voice of the ${providerDisplayLabel(provider, String(provider))} agent in an ADE chat. ADE is the user's desktop app for running coding agents in lanes (git worktrees).`,
      `Chat: ${summary?.title?.trim() || "Untitled"}`,
      `Lane: ${summary?.laneName ?? "unknown"}`,
      `Worktree: ${chat.laneWorktreePath}`,
      `Model doing the work: ${chat.session.model}`,
      "The messages that follow are this chat's most recent turns. For anything about the code, files, lane, or tasks, pass the request to the agent instead of answering from memory.",
      "Do not read file paths, IDs, code, or long output aloud unless asked; the chat shows them. Never read code aloud.",
      "You are the narrator of this chat, not a log reader. You are told what the agent is doing while it works: say the parts worth hearing, in your own words — what it is doing, what it found, where it seems to be going.",
      "Work in progress has not concluded. While the agent is still going, say what it looks like it is doing or leaning toward, never what it has decided. State a result flatly only when the agent's own finished message says it.",
      "The user can cut in at any time. When they speak, stop and answer them; whatever you were about to say about the work can wait.",
      "Everything you hand to the agent appears in the chat as the user's message, followed by the agent's work. Only say work is done when the agent's result says so.",
      "A subagent the agent starts keeps running after the agent's turn ends. Say it is running; say it finished only when a message from ADE reports that. Never make up a subagent's result.",
      "Questions about you (the voice) are yours to answer, not the agent's. Your settings (personality, voice, progress updates, what you call the user, language) are in ADE under Settings, Chat, Voice conversations. The waveform button in the prompt box starts and ends a conversation.",
      "So is the call itself: the user's controls are yours, not the agent's. When they ask to end the call, say a short goodbye — never hand it to the agent, which has no control over it. The call then closes on its own.",
      buildCodexVoiceStyleInstructions(preferences),
    ].join("\n");
    const history = chat.recentConversationEntries
      .slice(-HISTORY_ENTRIES)
      .map((entry) => {
        const text = (entry.displayText ?? entry.text).trim();
        return {
          role: entry.role,
          text: text.length > HISTORY_ENTRY_CHARS ? `${text.slice(0, HISTORY_ENTRY_CHARS)}…` : text,
        };
      })
      .filter((entry) => entry.text.length > 0);
    return [{ role: "developer", text: context }, ...history];
  };

  const nativeTransport = async (chat: TChat): Promise<Transport<TRuntime>> => {
    const runtime = await deps.ensureCodexRuntime(chat);
    if (!codexPlanIncludesVoice(runtime.accountPlanType ?? null)) {
      throw new Error(`Your ChatGPT plan (${runtime.accountPlanType}) does not include Codex voice.`);
    }
    const threadId = await deps.ensureCodexThread(chat, runtime);
    const request = (method: string, params: unknown) =>
      runtime.request(method, params, { timeoutMs: deps.requestTimeoutMs });
    return {
      kind: "native",
      threadId,
      runtime,
      request,
      // The chat's runtime keeps running; only the call ends. When OpenAI or
      // Codex ended it already, there is nothing to stop.
      release: (userInitiated) => {
        if (!userInitiated) return;
        void request("thread/realtime/stop", { threadId }).catch((error: unknown) => {
          logger.warn("agent_chat.codex_realtime_stop_failed", {
            sessionId: chat.session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    };
  };

  const hostTransport = async (chat: TChat, session: VoiceSession<TRuntime>): Promise<Transport<TRuntime>> => {
    const { executable, env } = deps.resolveCodexExecutable(chat);
    if (!executable) throw new Error("Voice needs Codex installed. Install Codex and sign in with ChatGPT.");
    const host: CodexVoiceHost = await startCodexVoiceHost({
      executable,
      env,
      cwd: chat.laneWorktreePath,
      logger,
      sessionId: chat.session.id,
      onNotification: ({ method, params }) => {
        if (sessions.get(chat.session.id) !== session) return;
        if (method.startsWith("thread/realtime/")) handleNotification(chat, method, params);
      },
      onExit: (reason) => finish(chat, session, reason, false),
    });
    return {
      kind: "host",
      threadId: host.threadId,
      runtime: null,
      request: (method, params) => host.request(method, params),
      // The host is private to this session: stop the call, then the process.
      // At shutdown the process may exit before the reply, so close at once.
      release: (_userInitiated, immediate) => {
        const stopping = host.request("thread/realtime/stop", { threadId: host.threadId }).catch(() => {});
        if (immediate) host.close();
        else void stopping.finally(() => host.close());
      },
    };
  };

  const stop = async ({ sessionId, token }: AgentChatCodexRealtimeStopArgs): Promise<void> => {
    const chat = deps.ensureChat(sessionId.trim());
    const session = sessions.get(chat.session.id);
    if (!session || (token && session.token !== token)) return;
    logger.info("agent_chat.codex_realtime_stop", {
      sessionId: chat.session.id,
      mode: session.mode,
      durationMs: Date.now() - session.startedAt,
    });
    finish(chat, session, null, true);
  };

  const start = async ({
    sessionId,
    sdp,
    preferences: rawPreferences,
  }: AgentChatCodexRealtimeStartArgs): Promise<AgentChatCodexRealtimeStartResult> => {
    // Pass the offer through byte for byte: SDP lines end in CRLF, and a trimmed
    // offer loses the last one, which OpenAI's parser rejects as "EOF".
    const offer = typeof sdp === "string" ? sdp : "";
    if (!offer.trim()) throw new Error("Voice needs a WebRTC offer.");
    const preferences = normalizeCodexVoicePreferences(rawPreferences);
    const chat = deps.ensureChat(sessionId.trim());
    const previous = sessions.get(chat.session.id);
    if (previous) finish(chat, previous, null, true);
    const session: VoiceSession<TRuntime> = {
      token: randomUUID(),
      mode: chat.session.provider === "codex" ? "native" : "host",
      transport: null,
      startedAt: Date.now(),
      live: false,
      finished: false,
      answer: null,
      captions: [],
      transcript: [],
      handoffs: 0,
      realtimeSessionId: null,
      voiceRequests: [],
      turn: null,
      lastStatusAt: 0,
      lastSpokeAt: 0,
      lastUserAt: 0,
      said: new Set(),
      deferred: null,
      deferTimer: null,
      endRequested: false,
      updates: preferences.updates,
      startSent: false,
      lastReadAt: 0,
      orphanTimer: null,
      flatCaptionSeq: 0,
    };
    // Registered before any await, so a stop or a second start can end it.
    sessions.set(chat.session.id, session);
    ended.delete(chat.session.id);
    const stopped = () => new Error("Voice was stopped.");
    try {
      const transport = session.mode === "native"
        ? await nativeTransport(chat)
        : await hostTransport(chat, session);
      if (session.finished) {
        transport.release(true);
        throw stopped();
      }
      session.transport = transport;
      const answer = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          finish(chat, session, "Codex did not answer the voice offer in time.", true);
        }, ANSWER_TIMEOUT_MS);
        session.answer = { resolve, reject, timer };
      });
      // Rejections are delivered through `await answer` below; this keeps an
      // early one (a stop, an error, or a failed start request) from going unhandled.
      answer.catch(() => {});
      const initialItems = buildInitialItems(chat, preferences);
      logger.info("agent_chat.codex_realtime_start", {
        sessionId: chat.session.id,
        mode: session.mode,
        threadId: transport.threadId,
        offerBytes: offer.length,
        voice: preferences.voice,
        personality: preferences.personality,
        initialItems: initialItems.length,
        initialChars: initialItems.reduce((total, item) => total + item.text.length, 0),
      });
      // Based on the Codex TUI's voice start. WebRTC defaults to realtime v1,
      // which OpenAI's call endpoint now rejects (it wants the v3 "quicksilver
      // v2" protocol). Unlike the TUI, ADE keeps Codex's startup context and
      // seeds its own.
      //
      // `clientManagedHandoffs` is set in both modes. It stops Codex forwarding
      // its own responses straight into the voice; ADE decides what the voice
      // says and when, which is the only way a Codex chat can be narrated the
      // same way every other provider is. A Codex chat still runs each hand-off
      // as a turn on its own thread — that is the chat, not the forwarding.
      session.startSent = true;
      await transport.request("thread/realtime/start", {
        threadId: transport.threadId,
        outputModality: "audio",
        includeStartupContext: true,
        initialItems,
        delegationAckFiller: true,
        backendReasoningStatus: session.mode === "native",
        clientManagedHandoffs: true,
        voice: preferences.voice,
        version: "v3",
        transport: { type: "webrtc", sdp: offer },
      });
      const answerSdp = await answer;
      session.live = true;
      session.lastReadAt = Date.now();
      // Anchor the silence clock here rather than at zero, so the first
      // progress line waits a real pause instead of firing on the greeting.
      session.lastSpokeAt = Date.now();
      session.orphanTimer = setInterval(() => {
        if (Date.now() - session.lastReadAt > ORPHAN_AFTER_MS) {
          logger.info("agent_chat.codex_realtime_orphaned", { sessionId: chat.session.id });
          finish(chat, session, "The voice window went away.", true);
        }
      }, ORPHAN_CHECK_MS);
      session.orphanTimer.unref?.();
      logger.info("agent_chat.codex_realtime_answered", {
        sessionId: chat.session.id,
        threadId: transport.threadId,
        answerBytes: answerSdp.length,
        latencyMs: Date.now() - session.startedAt,
      });
      captureFeatureUsedAnalytics({
        analytics: deps.analytics,
        surface: "desktop",
        feature: "chat",
        action: "voice_conversation_started",
        outcome: "completed",
        provider: chat.session.provider,
        sessionId: chat.session.id,
      });
      return { threadId: transport.threadId, sdp: answerSdp, token: session.token };
    } catch (error) {
      const message = humanizeError(error instanceof Error ? error.message : String(error));
      // A start that fails releases whatever it opened, including a call the
      // app server already accepted.
      finish(chat, session, message, true);
      logger.warn("agent_chat.codex_realtime_start_failed", { sessionId: chat.session.id, error: message });
      throw new Error(message);
    }
  };

  /** True when the user's own words asked for the call to be over. */
  const asksToEnd = (text: string): boolean => {
    const line = text.trim();
    if (!line) return false;
    // Hanging up on the user is the one mistake here that cannot be undone, so
    // the two ways to say these words without meaning them both back out first:
    // a negation ("don't end the call") and a question that is not a request
    // ("does this end the call?").
    if (END_REQUEST_VETO.test(line)) return false;
    if (line.endsWith("?") && !END_REQUEST_ASK.test(line)) return false;
    if (END_REQUEST_HANGUP.test(line) || END_REQUEST_PHRASE.test(line)) return true;
    return line.split(/\s+/).length <= 6 && END_REQUEST_FAREWELL.test(line);
  };

  /**
   * The user asked, out loud, to hang up. The voice gets a moment to say
   * goodbye — the call stays open for `END_GRACE_MS` so that farewell is heard —
   * and the session then ends the way the End button ends it.
   */
  const requestEnd = (chat: TChat, session: VoiceSession<TRuntime>): void => {
    if (session.endRequested || session.finished) return;
    session.endRequested = true;
    logger.info("agent_chat.codex_realtime_end_requested", { sessionId: chat.session.id });
    const timer = setTimeout(() => finish(chat, session, null, true), END_GRACE_MS);
    timer.unref?.();
  };

  /** Read-only: what the renderer's voice bar shows. */
  const getState = ({ sessionId, token }: AgentChatCodexRealtimeStateArgs): AgentChatCodexRealtimeState => {
    const chat = deps.ensureChat(sessionId.trim());
    const session = sessions.get(chat.session.id);
    if (!session || session.token !== token) {
      const entry = ended.get(chat.session.id);
      return { status: "ended", working: false, captions: [], handoffs: 0, error: entry?.error ?? null };
    }
    session.lastReadAt = Date.now();
    const runtime = session.transport?.runtime ?? null;
    const working = session.mode === "native"
      ? Boolean(runtime?.activeTurnId || runtime?.awaitingTurnStart)
      : deps.chatIsRunning(chat) || Boolean(session.turn);
    return {
      status: "live",
      working,
      captions: session.captions.map((caption) => ({ ...caption })),
      handoffs: session.handoffs,
      error: null,
    };
  };

  /** The chat is closing, or its Codex runtime is gone: end its voice session. */
  const endForChat = (chat: TChat, reason: string): void => {
    const session = sessions.get(chat.session.id);
    if (session) finish(chat, session, reason, true);
  };

  /** A Codex runtime exited. A native session riding on it lost its call. */
  const onRuntimeExit = (chat: TChat, runtime: TRuntime): void => {
    const session = sessions.get(chat.session.id);
    if (session?.transport?.runtime === runtime) finish(chat, session, "Codex stopped during the voice session.", false);
  };

  /** Shutdown: end every session and close every host. */
  const endAll = (lookupChat: (sessionId: string) => TChat | undefined): void => {
    for (const [sessionId, session] of [...sessions]) {
      const chat = lookupChat(sessionId);
      if (chat) finish(chat, session, "ADE is shutting down.", true, true);
      else session.transport?.release(true, true);
    }
  };

  return {
    start,
    stop,
    getState,
    handleNotification,
    adoptTurn,
    observeChatEvent,
    endForChat,
    onRuntimeExit,
    endAll,
  };
}
