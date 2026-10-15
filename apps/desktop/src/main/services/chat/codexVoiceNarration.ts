// ---------------------------------------------------------------------------
// What the voice says, and when.
//
// `codexVoiceSession.ts` owns the call: transports, hand-off routing, turn
// adoption, and the end of the session. This owns the other half — turning what
// the agent writes into sentences worth saying, deciding when the voice has
// something worth interrupting for, and getting out of the way the moment the
// user speaks.
//
// Two rules live here and nowhere else. The user always wins. And the voice
// never talks faster than it has something worth saying.
//
// It speaks through a sink the session supplies, so the session keeps every
// question about whether the call is still live, and this keeps every question
// about whether it is worth talking.
// ---------------------------------------------------------------------------

import type { AgentChatEvent } from "../../../shared/types";
import type { CodexVoiceUpdateLevel } from "../../../shared/codexVoice";
import type { Logger } from "../logging/logger";

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
/** How often the silent progress relay is refreshed while the agent works. */
const STATUS_INTERVAL_MS = 8_000;
/** The longest answer read out in one go when nothing was streamed. */
const SPOKEN_ANSWER_CHARS = 2_000;
/** A fence that never closes cannot grow past this before its contents are dropped. */
const FENCE_LIMIT_CHARS = 4_000;
/** Opening or closing line of a markdown code fence. */
const FENCE_LINE = /^\s*(?:```|~~~)/;
/** Commands worth hearing about as they start, rather than when they finish. */
const LONG_COMMAND = /\b(?:test|tests|build|lint|typecheck|type-check|compile|e2e|install|migrate|deploy)\b/i;
/** How long the voice gets to say goodbye before the call actually closes. */
const END_GRACE_MS = 3_500;
/**
 * Asking to hang up. Deliberately explicit: "is this going to end the call?"
 * must not hang up on the user, so a bare farewell counts only when it is the
 * whole utterance and short.
 */
/**
 * The object has to be *this* call. A bare noun is not enough: in a terminal a
 * user says "stop the session" about a tmux session and "stop the call to the
 * API" about a function call, and hanging up on either is the mistake this
 * guards against. "call to/for" is excluded for the same reason.
 */
const END_REQUEST_PHRASE = /\b(?:end|stop|close|finish|leave)\b[^.?!]{0,24}(?:(?:this|the|our|my|your)\s+(?:voice\s+)?(?:call|conversation)|\bvoice\s+session)\b(?!\s+(?:to|for)\b)/i;
/** "Hang up" names the act on its own; it needs no object to be unambiguous. */
const END_REQUEST_HANGUP = /\bhang\s*up\b/i;
const END_REQUEST_FAREWELL = /^(?:(?:ok(?:ay)?|alright|all right)[,\s]+)?(?:bye|bye[ -]?bye|goodbye|good[ -]?bye|see (?:ya|you)|that'?s (?:all|it)|we'?re done|i'?m done|nothing else)(?:[,\s]+(?:for now|for today|thanks|thank you|then))?[.!,\s]*$/i;
/** "Don't end the call", "no need to hang up" — the same words, the opposite meaning. */
const END_REQUEST_VETO = /\b(?:don'?t|doesn'?t|won'?t|wouldn'?t|not|never|no)\b[^.]{0,14}\b(?:end|stop|hang|close|finish|leave)\b/i;
/** A question is a request only when it is actually asking for one. */
const END_REQUEST_ASK = /^(?:please\s+)?(?:can|could|would|will|go ahead|just)\b/i;

/** The phrase that starts a sentence and holds its ending, while it is written. */
const SENTENCE_END = /[\s\S]*[.!?…]["')\]]?(?=\s|$)/;

/**
 * The chat turn the voice is following. Its prose is streamed into speech as it
 * is written, in both transports, so the voice talks about the work while it
 * happens instead of reading the finished answer once.
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

/**
 * What the narrator needs from the session. Every one of these is a question
 * about the call rather than about the words, which is why they are the
 * session's to answer.
 */
type VoiceNarrationSink = {
  /**
   * Hands the voice one line to phrase and say now. False when the call is not
   * live — the session's decision, not the narrator's.
   */
  speak: (text: string) => boolean;
  /** Context the voice can use if asked. Never said on its own. */
  tell: (text: string) => void;
  /** End the call, once the goodbye has been given its moment. */
  end: () => void;
  /** Whether there is still a call to say anything on. */
  isLive: () => boolean;
};

export type VoiceNarrator = {
  /** Follow a new turn. `said` is per turn, so a milestone can repeat in the next one. */
  beginTurn: (waitForNextTurn: boolean) => void;
  endTurn: () => void;
  isFollowing: () => boolean;
  /** The chat's own events. Called for every one, in both transports. */
  observeChatEvent: (event: AgentChatEvent) => void;
  /** The user said this. Takes the floor, and honours or calls off an ending. */
  noteUserSpoke: (text: string) => void;
  /** The model's own audio. Counts as speaking, so the silence clock is honest. */
  noteModelSpoke: () => void;
  /** How the user's own words asked for the call to be over, or null. */
  endRequestOf: (text: string) => "explicit" | "farewell" | null;
  /**
   * The user asked, out loud, for the call to be over. How they asked decides
   * whether a later segment may call it off.
   */
  requestEnd: (kind?: "explicit" | "farewell") => void;
  /** True while the call is ending because the user asked for it to. */
  endedByVoice: () => boolean;
  /** A result, said now or as soon as the user stops. Never dropped. */
  say: (text: string) => void;
  /** The session is finishing. Nothing here may speak afterwards. */
  clearTimers: () => void;
};

/** Prose the voice should not read aloud. Fenced code is removed before this runs. */
function stripMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, "$1$2")
    .replace(/^\s*#{1,6}\s*/g, "")
    .replace(/^\s*[-*+]\s+/g, "")
    .replace(/^\s*>\s?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How much of the buffered prose reads as a sentence now; `force` takes all of it. */
function takeSentences(carry: string, force: boolean): { spoken: string; rest: string } {
  if (force) return { spoken: carry, rest: "" };
  const match = SENTENCE_END.exec(carry);
  if (match) return { spoken: match[0], rest: carry.slice(match[0].length) };
  // No sentence ending yet. A long unpunctuated line (a heading, a bullet) is
  // the one case where waiting for one would mean never speaking at all.
  return carry.trim().length >= SPEECH_MIN_CHARS ? { spoken: carry, rest: "" } : { spoken: "", rest: carry };
}

/** A short, speakable description of what the agent is doing, or null. */
function describeProgress(event: AgentChatEvent): string | null {
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
}

/** The first line of a command, short enough to say out loud. */
function summarizeCommand(command: string): string {
  const first = command.trim().split("\n")[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

export function createVoiceNarration(options: {
  updates: CodexVoiceUpdateLevel;
  logger: Logger;
  sessionId: string;
  sink: VoiceNarrationSink;
}): VoiceNarrator {
  const { logger, sessionId, sink } = options;

  let turn: VoiceTurnStream | null = null;
  /** When the voice last spoke — its own speech or the model's — for the silence clock. */
  let lastSpokeAt = 0;
  /** When the user's words were last transcribed, for barge-in. */
  let lastUserAt = 0;
  /** When the silent progress relay was last refreshed. */
  let lastStatusAt = 0;
  /** Milestones already said for the current turn, so none is said twice. */
  const said = new Set<string>();
  /** One line held back because the user was talking; said as soon as they stop. */
  let deferred: string | null = null;
  let deferTimer: NodeJS.Timeout | null = null;
  /** The user asked for the call to be over, and the goodbye is playing out. */
  let endRequested = false;
  /**
   * How they asked. It decides what may call the end off: a farewell is one
   * only while nothing follows it, but "end the call" is what the user meant,
   * and a trailing "okay" does not retract it.
   */
  let endKind: "explicit" | "farewell" = "explicit";
  let endTimer: NodeJS.Timeout | null = null;

  const newTurnStream = (waitForNextTurn: boolean): VoiceTurnStream => ({
    text: "",
    pending: "",
    carry: "",
    inFence: false,
    spoke: false,
    waitForNextTurn,
    flushTimer: null,
  });

  // ---------------------------------------------------------------------------
  // Saying things.
  // ---------------------------------------------------------------------------

  /** The user has the floor: their words cancel whatever the voice was about to say. */
  const userHoldsFloor = (): boolean => Date.now() - lastUserAt < BARGE_IN_HOLD_MS;

  /** Only `quiet` opts out of narration; it is what voice did before a narrator existed. */
  const narrationEnabled = (): boolean => options.updates !== "quiet";

  /** Hands the voice one line to phrase and say now. False when it stayed quiet. */
  const speakNow = (text: string): boolean => {
    const line = text.trim();
    // Nothing new is narrated once the call is on its way out; the goodbye is
    // the model's own and must not be talked over.
    if (!line || endRequested || userHoldsFloor()) return false;
    if (!sink.speak(line)) return false;
    lastSpokeAt = Date.now();
    return true;
  };

  /** Holds a line for the moment the user stops talking, and says it then. */
  const deferSpeech = (text: string): void => {
    deferred = text;
    if (deferTimer) return;
    deferTimer = setTimeout(() => {
      deferTimer = null;
      const line = deferred;
      if (!line) return;
      if (userHoldsFloor()) {
        deferSpeech(line);
        return;
      }
      deferred = null;
      speakNow(line);
    }, BARGE_IN_HOLD_MS);
    deferTimer.unref?.();
  };

  /**
   * A result, which is never dropped for the sake of barge-in: it waits for the
   * user instead. Losing "the tests failed" because they were talking would be
   * a worse failure than the interruption it avoided.
   */
  const speakResult = (text: string): void => {
    if (speakNow(text)) return;
    // Only a live call can defer: holding a line for a session that has not
    // started yet would say it, late, the moment it does.
    if (sink.isLive() && !endRequested) deferSpeech(text);
  };

  /** A milestone worth hearing: said once, never in a burst, never over the user. */
  const narrate = (key: string, text: string): void => {
    if (!narrationEnabled() || said.has(key)) return;
    if (Date.now() - lastSpokeAt < NARRATION_MIN_GAP_MS) return;
    said.add(key);
    speakNow(text);
  };

  // ---------------------------------------------------------------------------
  // The turn stream.
  // ---------------------------------------------------------------------------

  const beginTurn = (waitForNextTurn: boolean): void => {
    if (turn?.flushTimer) clearTimeout(turn.flushTimer);
    said.clear();
    turn = newTurnStream(waitForNextTurn);
  };

  const endTurn = (): void => {
    if (turn?.flushTimer) clearTimeout(turn.flushTimer);
    turn = null;
  };

  /**
   * Moves finished prose out of the raw stream. A fenced block is dropped whole,
   * opening fence to closing one: an agent writes far more code than prose, and
   * reading it aloud is the fastest way to make voice feel worse than silence.
   * Outside a fence, text is taken a sentence at a time, so an answer with no
   * line breaks in it still starts speaking while it is being written.
   */
  const drainStream = (stream: VoiceTurnStream): void => {
    let index = 0;
    while (index < stream.pending.length) {
      const newline = stream.pending.indexOf("\n", index);
      const wholeLine = newline >= 0;
      const line = wholeLine ? stream.pending.slice(index, newline) : stream.pending.slice(index);
      if (FENCE_LINE.test(line)) {
        stream.inFence = !stream.inFence;
      } else if (stream.inFence) {
        // Code. Dropped along with the rest of the block.
      } else if (wholeLine) {
        stream.carry += `${line} `;
      } else {
        const match = SENTENCE_END.exec(line);
        if (!match) break; // Still being written; wait for the sentence to end.
        stream.carry += `${match[0]} `;
        stream.pending = stream.pending.slice(index + match[0].length);
        return;
      }
      index = wholeLine ? newline + 1 : stream.pending.length;
    }
    stream.pending = stream.pending.slice(index);
    // A fence that never closes is a stream that was cut off mid-code. It is
    // still code, so it is dropped rather than saved up forever.
    if (stream.inFence && stream.pending.length > FENCE_LIMIT_CHARS) stream.pending = "";
  };

  /** Says as much of the buffered prose as reads as a sentence. */
  const flushStream = (force: boolean): void => {
    if (!turn) return;
    if (force && turn.pending) {
      if (!turn.inFence) turn.carry += `${turn.pending} `;
      turn.pending = "";
    }
    const { spoken, rest } = takeSentences(turn.carry, force);
    turn.carry = rest;
    const line = stripMarkdown(spoken);
    if (!line || !narrationEnabled()) return;
    // Dropped, not queued: narration of a step that already finished is worse
    // than saying nothing about it.
    if (speakNow(line)) turn.spoke = true;
  };

  /** Says what is buffered once the stream pauses, so prose without endings is not stuck. */
  const scheduleFlush = (): void => {
    if (!turn || turn.flushTimer) return;
    turn.flushTimer = setTimeout(() => {
      if (turn) turn.flushTimer = null;
      flushStream(false);
    }, SPEECH_FLUSH_MS);
    turn.flushTimer.unref?.();
  };

  /** The agent's prose, spoken as it is written. */
  const addStreamText = (delta: string): void => {
    if (!turn) return;
    turn.text += delta;
    if (!narrationEnabled() || !delta) return;
    turn.pending += delta;
    drainStream(turn);
    flushStream(false);
    if (turn.carry.trim() || turn.pending.trim()) scheduleFlush();
  };

  /**
   * An answer with its code removed, for a turn that was never streamed. It
   * runs that answer through the streaming drain rather than walking the fences
   * a second time, so what counts as code is decided in exactly one place.
   */
  const speakableText = (text: string): string => {
    const stream = newTurnStream(false);
    stream.pending = text;
    drainStream(stream);
    if (stream.pending && !stream.inFence) stream.carry += `${stream.pending} `;
    return stripMarkdown(stream.carry);
  };

  // ---------------------------------------------------------------------------
  // Ending the call.
  // ---------------------------------------------------------------------------

  /** How the user's own words asked for the call to be over, or null. */
  const matchEndRequest = (text: string): "explicit" | "farewell" | null => {
    const line = text.trim();
    if (!line) return null;
    // Hanging up on the user is the one mistake here that cannot be undone, so
    // the two ways to say these words without meaning them both back out first:
    // a negation ("don't end the call") and a question that is not a request
    // ("does this end the call?").
    if (END_REQUEST_VETO.test(line)) return null;
    if (line.endsWith("?") && !END_REQUEST_ASK.test(line)) return null;
    if (END_REQUEST_HANGUP.test(line) || END_REQUEST_PHRASE.test(line)) return "explicit";
    return line.split(/\s+/).length <= 6 && END_REQUEST_FAREWELL.test(line) ? "farewell" : null;
  };

  /**
   * The user asked, out loud, to hang up. The voice gets a moment to say
   * goodbye — the call stays open for `END_GRACE_MS` so that farewell is heard —
   * and the session then ends the way the End button ends it.
   */
  const requestEnd = (kind: "explicit" | "farewell" = "explicit"): void => {
    if (endRequested) {
      // Asking twice, the second time plainly, outranks an earlier "bye": the
      // stronger request is the one the user meant.
      if (kind === "explicit") endKind = "explicit";
      return;
    }
    endRequested = true;
    endKind = kind;
    logger.info("agent_chat.codex_realtime_end_requested", { sessionId, kind });
    endTimer = setTimeout(() => sink.end(), END_GRACE_MS);
    endTimer.unref?.();
  };

  /** They kept talking, so the call is not over after all. */
  const cancelEnd = (): void => {
    if (!endRequested) return;
    endRequested = false;
    endKind = "explicit";
    if (endTimer) clearTimeout(endTimer);
    endTimer = null;
    logger.info("agent_chat.codex_realtime_end_cancelled", { sessionId });
  };

  /**
   * The user said something. Their words take the floor, and if they asked for
   * the call to be over it starts winding down — otherwise an end already asked
   * for is called off, because a transcriber splits one utterance into several
   * segments and "That's it" is a farewell only if nothing follows it.
   */
  const noteUserSpoke = (text: string): void => {
    lastUserAt = Date.now();
    const kind = matchEndRequest(text);
    if (kind) {
      requestEnd(kind);
      return;
    }
    if (endKind === "farewell") cancelEnd();
  };

  // ---------------------------------------------------------------------------
  // The chat's own events.
  // ---------------------------------------------------------------------------

  /**
   * Relays the chat's own events into the voice session. Called for every chat
   * event, in both transports: a Codex chat is narrated by ADE exactly the way
   * any other chat is, so voice behaves the same whichever agent is behind it.
   */
  const observeChatEvent = (event: AgentChatEvent): void => {
    if (event.type === "subagent_started" || event.type === "subagent_result") {
      const name = event.label?.trim()
        || (event.type === "subagent_started" ? event.description?.trim() : undefined)
        || "The subagent";
      if (event.type === "subagent_started") {
        sink.tell(
          `[ADE] Subagent "${name}" started. It keeps running after the agent's turn ends; it is not done until ADE says it finished.`,
        );
        return;
      }
      const outcome = event.status === "completed" ? "finished" : event.status === "failed" ? "failed" : "was stopped";
      speakResult(`${name} ${outcome}.`);
      const summary = (event.finalSummary ?? event.summary ?? "").trim();
      if (summary) {
        sink.tell(`[ADE] Subagent "${name}" ${outcome}. Its report (shown in the chat): ${summary.slice(0, 1_500)}`);
      }
      return;
    }
    // Everything below follows the turn the voice handed off.
    if (!turn) return;
    if (event.type === "status" && event.turnStatus === "started") {
      // A turn starting while this request is still queued is the turn it was
      // queued behind, so this one began: follow it from the top.
      if (turn.waitForNextTurn) beginTurn(false);
      return;
    }
    if (turn.waitForNextTurn) return;
    if (event.type === "text") {
      addStreamText(event.text);
      return;
    }
    // An announced plan is the clearest signal of where the work is going, so
    // it is the one milestone worth interrupting for. A plan arrives in pieces,
    // and `narrate` says each key once per turn, so only the first lands.
    if (event.type === "plan") {
      const explanation = (event.explanation ?? "").trim();
      if (explanation && event.steps.length > 1) narrate("plan", explanation);
      return;
    }
    const progress = describeProgress(event);
    if (progress) {
      const now = Date.now();
      if (now - lastStatusAt >= STATUS_INTERVAL_MS) {
        lastStatusAt = now;
        sink.tell(`[STATUS] The agent is ${progress}.`);
        // A long quiet stretch is where the realtime model starts padding. Say
        // what is actually happening instead — but only once the voice has been
        // silent long enough that the user is listening to nothing.
        if (narrationEnabled() && now - lastSpokeAt >= NARRATION_IDLE_MS) {
          narrate(`progress:${progress}`, `It's ${progress}.`);
        }
      }
      // A long command is the one tool event worth hearing as it starts; the
      // rest are noise, which is what makes a narrator tiring.
      if (options.updates === "chatty" && event.type === "command" && event.status === "running" && LONG_COMMAND.test(event.command)) {
        const command = summarizeCommand(event.command);
        if (command) narrate("command", `It's running ${command} now — that one takes a bit.`);
      }
      return;
    }
    if (event.type === "error") {
      endTurn();
      const message = event.message.trim();
      speakResult(`The agent hit an error${message ? `: ${message.slice(0, 200)}` : "."}`);
      return;
    }
    if (event.type === "done") {
      // Whatever is still buffered is the tail of the answer; saying it here is
      // what replaces reading the whole thing out at once.
      flushStream(true);
      const spoke = turn.spoke;
      const answer = speakableText(turn.text);
      endTurn();
      if (spoke) return;
      // Nothing was streamed — the user had the floor, or the preference is
      // `quiet` — so the answer is spoken whole, as voice always did.
      speakResult(
        answer
          ? answer.length > SPOKEN_ANSWER_CHARS ? `${answer.slice(0, SPOKEN_ANSWER_CHARS)}…` : answer
          : "The agent finished without a written answer.",
      );
    }
  };

  return {
    beginTurn,
    endTurn,
    isFollowing: () => turn !== null,
    observeChatEvent,
    noteUserSpoke,
    noteModelSpoke: () => { lastSpokeAt = Date.now(); },
    endRequestOf: matchEndRequest,
    requestEnd,
    endedByVoice: () => endRequested,
    say: speakResult,
    clearTimers: () => {
      if (turn?.flushTimer) clearTimeout(turn.flushTimer);
      if (deferTimer) clearTimeout(deferTimer);
      if (endTimer) clearTimeout(endTimer);
      deferred = null;
    },
  };
}
