import type { AgentChatEventEnvelope } from "../../../shared/types";
import { logRendererDebugEvent } from "../../lib/debugLog";

/**
 * The window's half of the per-turn send timing. The brain logs
 * `agent_chat.send_timing` and main logs `chat.send_timing.main`; this logs
 * `renderer.chat_send_timing` through main's log, one line per send, with ids
 * and numbers only. Every mark is ms after the person pressed Enter, and
 * `enterAtMs` matches the brain line's `clientSubmittedAtMs`.
 */
type RendererSendMark =
  | "bubbleSet"
  | "bubblePainted"
  | "createCalled"
  | "sessionCreated"
  | "sendCalled"
  | "sendResolved"
  | "userEventReceived"
  | "firstTextReceived"
  | "firstTextPainted";

type OpenSend = {
  startedAt: number;
  enterAtMs: number;
  sessionId: string | null;
  marks: Partial<Record<RendererSendMark, number>>;
  firstTextCommitToRendererMs?: number | null;
};

export type ChatSendTimingHandle = {
  /** Wall-clock ms of the Enter press, for the send args (`clientSubmittedAtMs`). */
  readonly enterAtMs: number;
  mark: (name: RendererSendMark) => void;
  /** Marks `bubblePainted` once the frame that draws the bubble has gone to the screen. */
  markBubblePaintedAfterFrame: () => void;
  /** The chat this send goes to; known at once, or after a draft creates it. */
  attach: (sessionId: string) => void;
};

const MAX_OPEN_SENDS = 16;
const openBySession = new Map<string, OpenSend>();

function elapsed(send: OpenSend): number {
  return Math.round((performance.now() - send.startedAt) * 10) / 10;
}

/** Runs after the next frame is drawn: the frame callback, then the task after the paint. */
function afterNextPaint(callback: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(callback, 0);
    return;
  }
  requestAnimationFrame(() => setTimeout(callback, 0));
}

function finish(send: OpenSend): void {
  if (send.sessionId && openBySession.get(send.sessionId) === send) openBySession.delete(send.sessionId);
  logRendererDebugEvent("chat_send_timing", {
    sessionId: send.sessionId,
    enterAtMs: send.enterAtMs,
    firstTextCommitToRendererMs: send.firstTextCommitToRendererMs ?? null,
    ...send.marks,
  });
}

/**
 * Starts timing a send at the Enter press: now, or `enterAtMs` (wall clock)
 * for a send that a draft launch makes after the press.
 */
export function beginChatSendTiming(enterAtMs?: number): ChatSendTimingHandle {
  const startedAt = enterAtMs != null ? enterAtMs - performance.timeOrigin : performance.now();
  const send: OpenSend = {
    startedAt,
    enterAtMs: enterAtMs != null ? Math.round(enterAtMs) : Math.round(performance.timeOrigin + startedAt),
    sessionId: null,
    marks: {},
  };
  const mark = (name: RendererSendMark) => {
    if (send.marks[name] === undefined) send.marks[name] = elapsed(send);
  };
  return {
    enterAtMs: send.enterAtMs,
    mark,
    markBubblePaintedAfterFrame: () => {
      if (send.marks.bubbleSet !== undefined) return;
      mark("bubbleSet");
      afterNextPaint(() => mark("bubblePainted"));
    },
    attach: (sessionId) => {
      if (send.sessionId) return;
      send.sessionId = sessionId;
      const previous = openBySession.get(sessionId);
      if (previous) finish(previous);
      if (openBySession.size >= MAX_OPEN_SENDS) {
        const oldest = openBySession.keys().next().value;
        if (oldest !== undefined) openBySession.delete(oldest);
      }
      openBySession.set(sessionId, send);
    },
  };
}

/**
 * Called for each live chat event the pane takes in. Cheap when no send of
 * that chat is being timed: one map read.
 */
export function noteChatSendTimingEvent(envelope: AgentChatEventEnvelope): void {
  if (openBySession.size === 0) return;
  const send = openBySession.get(envelope.sessionId);
  if (!send) return;
  const type = envelope.event.type;
  if (type === "user_message") {
    if (send.marks.userEventReceived === undefined) send.marks.userEventReceived = elapsed(send);
    return;
  }
  if (type === "done") {
    finish(send);
    return;
  }
  if (type !== "text" || send.marks.firstTextReceived !== undefined) return;
  send.marks.firstTextReceived = elapsed(send);
  const committedAtMs = Date.parse(envelope.timestamp);
  send.firstTextCommitToRendererMs = Number.isFinite(committedAtMs) ? Date.now() - committedAtMs : null;
  // The send is done; a later send to this chat starts its own timing.
  openBySession.delete(envelope.sessionId);
  afterNextPaint(() => {
    send.marks.firstTextPainted = elapsed(send);
    finish(send);
  });
}
