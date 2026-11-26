/**
 * The messages the account's queue holds for an ADE Cloud chat, as the
 * chat's own sent bubbles and the working line under them.
 *
 * A send to a chat whose computer rests goes to the account's queue
 * (`useAdeCloudChatQueue`). The chat shows each waiting message as a sent
 * bubble (`cloudQueuedMessageEnvelope`) until its transcript has it, and the
 * working line says what the messages wait for (`cloudQueueWaitLine`). Account
 * level, by the chat's machine key: no pin, and nothing here wakes the computer.
 */

import { useCallback, useMemo, useRef } from "react";
import type { CloudChatQueuedMessage, CloudWakeOutcome } from "../../../../../account-directory/src/cloud/contract";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import { cloudQueuedMessageEnvelope } from "./CloudQueuedMessages";

const EMPTY_MESSAGES: CloudChatQueuedMessage[] = [];
const EMPTY_ENVELOPES: AgentChatEventEnvelope[] = [];
const EMPTY_IDS: ReadonlySet<string> = new Set();
/** A few sends' worth of bubble times; an older id only names a message long gone. */
const MAX_BUBBLE_TIMES = 50;

export function useCloudQueuedBubbles(args: {
  messages: CloudChatQueuedMessage[];
  /** The launch the send card follows: the card shows its messages, so they get no bubble. */
  followedLaunchId: string | null;
  /** The chat on screen, or null while the transcript and the selection disagree. */
  sessionId: string | null;
  /** The chat's committed transcript. */
  events: readonly AgentChatEventEnvelope[];
}): {
  /** The `clientSendId` of each user message in the transcript (empty while nothing is queued). */
  sentIds: ReadonlySet<string>;
  /** The messages that still wait, oldest first. One the transcript has already gives way to it. */
  open: CloudChatQueuedMessage[];
  envelopes: AgentChatEventEnvelope[];
  /**
   * A send went out with its own bubble at `timestamp`. If the queue takes it,
   * the queued bubble uses that time, so the row stays and plays no second entrance.
   */
  noteSendBubble: (clientSendId: string, timestamp: string) => void;
} {
  const { messages, followedLaunchId, sessionId, events } = args;
  const hasMessages = messages.length > 0;
  const sentIds = useMemo(() => {
    if (!hasMessages) return EMPTY_IDS;
    const ids = new Set<string>();
    for (const { event } of events) {
      if (event.type === "user_message" && event.clientSendId) ids.add(event.clientSendId);
    }
    return ids;
  }, [events, hasMessages]);
  const open = useMemo(() => {
    if (!hasMessages || !sessionId) return EMPTY_MESSAGES;
    const waiting = messages.filter((message) => (
      !(message.launchId && message.launchId === followedLaunchId) && !sentIds.has(message.messageId)
    ));
    return waiting.length ? waiting : EMPTY_MESSAGES;
  }, [followedLaunchId, hasMessages, messages, sentIds, sessionId]);
  const bubbleTimesRef = useRef(new Map<string, string>());
  const envelopes = useMemo(() => (
    sessionId && open.length
      ? open.map((message) => cloudQueuedMessageEnvelope(
        message,
        sessionId,
        bubbleTimesRef.current.get(message.messageId) ?? new Date(message.createdAt).toISOString(),
      ))
      : EMPTY_ENVELOPES
  ), [open, sessionId]);
  const noteSendBubble = useCallback((clientSendId: string, timestamp: string) => {
    const times = bubbleTimesRef.current;
    times.set(clientSendId, timestamp);
    for (const oldest of times.keys()) {
      if (times.size <= MAX_BUBBLE_TIMES) break;
      times.delete(oldest);
    }
  }, []);
  return { sentIds, open, envelopes, noteSendBubble };
}

/**
 * What the working line says while queued messages wait, and since when (the
 * oldest). Null while none waits, or while each one waits for a sign-in: that
 * needs the person, and its bubble says so. A null label is the line's own
 * "Waking the computer…".
 */
export function cloudQueueWaitLine(
  open: readonly CloudChatQueuedMessage[],
  state: {
    /** The lane's running move or size change, if any. */
    laneChange: "move" | "resize" | null;
    wake: CloudWakeOutcome["state"] | null | undefined;
    /** The computer wakes for a queued message (`useAdeCloudChatQueue().waking`). */
    waking: boolean;
    /** The chat's connection to its computer is up again. */
    connected: boolean;
    agentLabel: string;
  },
): { sinceMs: number; label: string | null } | null {
  const waiting = open.filter((message) => message.state !== "waiting_for_sign_in");
  if (waiting.length === 0) return null;
  const sinceMs = Math.min(...waiting.map((message) => message.createdAt));
  let label: string | null;
  if (state.laneChange === "move" || state.wake === "moving") label = "Moving to the new computer…";
  else if (state.laneChange === "resize") label = "Changing the computer's size…";
  else if (state.wake === "launching" || waiting.some((message) => message.launchId)) label = "Starting a new computer…";
  else if (state.connected || waiting.some((message) => message.state === "sending")) label = `Starting ${state.agentLabel}…`;
  else label = state.waking ? null : "Waiting for the computer…";
  return { sinceMs, label };
}
