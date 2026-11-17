/**
 * The message queue of an existing ADE Cloud chat, in the window.
 *
 * A send to a chat whose cloud computer is asleep goes to the account's queue
 * (`window.ade.cloud.sendChatMessage`). The send returns at once: the server
 * keeps the message and wakes the computer, which sends it when it is up.
 * Until then the chat shows the message as queued, with "Waking your ADE
 * Cloud computer…". The live chat replaces it by its send id once the
 * computer has sent it.
 *
 * A message the server could not send (`failed`: the send failed, or the
 * new computer for the chat never came up) stays in `failed` with the
 * server's sentence (`error`) until the person puts the text back or
 * dismisses it. The server cannot take back a failed message, so that
 * choice is kept in this browser (`dismissAdeCloudFailedMessage`).
 *
 * Reads ride existing triggers only (a send, the chat opening, the window
 * getting focus). Nothing here polls.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { CLOUD_CHAT_MESSAGE_MAX_CHARS, type CloudChatQueuedMessage, type CloudWakeOutcome } from "../../../../account-directory/src/cloud/contract";
import { newClientSendId, queuedMessageOpen } from "../../shared/adeCloud/chatQueue";
import type { CloudChatSendAnswer } from "../../shared/adeCloudMachine";
import type { AgentChatSendArgs } from "../../shared/types/chat";
import type { OpenProjectBinding } from "../../shared/types/core";
import { clearQueuedChatPicks, peekQueuedChatPicks, savedChatLocation, savedChatLocationForSession, type SavedChatLocation } from "./cloudSavedChats";

export type AdeCloudChatQueueState = {
  /** Messages the chat shows as its own rows: queued, sending, or waiting for a sign-in. Oldest first. */
  messages: CloudChatQueuedMessage[];
  /**
   * Messages the server could not send (`state: "failed"`), with its sentence
   * in `error`, until the person puts the text back or dismisses them. Oldest first.
   */
  failed: CloudChatQueuedMessage[];
  /** What the last send did to the computer; null before any send from this window. */
  wake: CloudWakeOutcome | null;
  /** The last read of the queue failed: the rows may be out of date. */
  readFailed: boolean;
};

const EMPTY: AdeCloudChatQueueState = { messages: [], failed: [], wake: null, readFailed: false };

/** Failed messages the person put back or dismissed, by id. Per browser; the server prunes failed rows after 7 days. */
const DISMISSED_STORAGE_KEY = "ade.cloudQueue.dismissedFailed.v1";
const MAX_DISMISSED = 500;
let dismissedCache: Set<string> | null = null;

function dismissedIds(): Set<string> {
  if (dismissedCache) return dismissedCache;
  dismissedCache = new Set();
  try {
    const stored = JSON.parse(window.localStorage.getItem(DISMISSED_STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(stored)) for (const id of stored) if (typeof id === "string") dismissedCache.add(id);
  } catch {
    // No storage (a private window, blocked site data): the choice lasts for this page only.
  }
  return dismissedCache;
}

function rememberDismissed(messageId: string): void {
  const ids = dismissedIds();
  ids.add(messageId);
  while (ids.size > MAX_DISMISSED) ids.delete(ids.values().next().value as string);
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // As above: kept in memory only.
  }
}

const states = new Map<string, AdeCloudChatQueueState>();
const listeners = new Set<() => void>();
/** Send ids the live chat already shows: their queued rows go away for good. */
const delivered = new Set<string>();

const keyOf = (machineKey: string, chatId: string) => `${machineKey.toLowerCase()}\0${chatId}`;

function publish(key: string, next: AdeCloudChatQueueState): void {
  states.set(key, next);
  for (const listener of listeners) listener();
}

function openRows(messages: CloudChatQueuedMessage[]): CloudChatQueuedMessage[] {
  return messages
    .filter((message) => queuedMessageOpen(message) && !delivered.has(message.messageId))
    .sort((a, b) => a.seq - b.seq);
}

function failedRows(messages: CloudChatQueuedMessage[]): CloudChatQueuedMessage[] {
  const dismissed = dismissedIds();
  return messages
    .filter((message) => message.state === "failed" && !delivered.has(message.messageId) && !dismissed.has(message.messageId))
    .sort((a, b) => a.seq - b.seq);
}

/** Reads the chat's open messages from the account. An older server (null) leaves the rows as they are. */
export async function refreshAdeCloudChatQueue(machineKey: string, chatId: string): Promise<void> {
  const read = window.ade?.adeCloud?.chatMessages;
  if (!read) return;
  const key = keyOf(machineKey, chatId);
  const current = states.get(key) ?? EMPTY;
  try {
    const messages = await read({ machineKey, chatId });
    if (!messages) return;
    publish(key, { ...(states.get(key) ?? current), messages: openRows(messages), failed: failedRows(messages), readFailed: false });
  } catch (error) {
    console.warn("[cloud] the chat queue read failed", error instanceof Error ? error.message : String(error));
    publish(key, { ...(states.get(key) ?? current), readFailed: true });
  }
}

/**
 * The live chat shows the message with this send id: drop its queued row.
 * The chat pane calls it when a user message with that `clientSendId`
 * arrives in the live stream.
 */
export function markAdeCloudQueuedMessageDelivered(clientSendId: string): void {
  if (!clientSendId || delivered.has(clientSendId)) return;
  delivered.add(clientSendId);
  if (delivered.size > 500) delivered.delete(delivered.values().next().value as string);
  for (const [key, state] of states) {
    if (state.messages.some((message) => message.messageId === clientSendId)) {
      publish(key, { ...state, messages: state.messages.filter((message) => message.messageId !== clientSendId) });
    }
  }
}

/** True when the account's queue holds the message with this send id as an open row (a send went to the queue, not to a computer). */
export function adeCloudQueueHoldsMessage(messageId: string): boolean {
  if (!messageId) return false;
  for (const state of states.values()) {
    if (state.messages.some((message) => message.messageId === messageId)) return true;
  }
  return false;
}

/**
 * A send the queue took (`state: "sent"`): the row shows it at once, then
 * reads the server's copy once.
 */
export function noteAdeCloudQueuedSend(
  address: { machineKey: string; chatId: string },
  answer: Extract<CloudChatSendAnswer, { state: "sent" }>,
  message: { text: string; provider?: string | null; modelId?: string | null },
): void {
  const key = keyOf(address.machineKey, address.chatId);
  const current = states.get(key) ?? EMPTY;
  const now = Date.now();
  const optimistic: CloudChatQueuedMessage = {
    messageId: answer.messageId,
    machineKey: address.machineKey,
    chatId: address.chatId,
    seq: (current.messages.at(-1)?.seq ?? 0) + 1,
    state: "queued",
    text: message.text,
    attachments: [],
    provider: message.provider ?? null,
    modelId: message.modelId ?? null,
    signIn: null,
    error: null,
    launchId: answer.wake.launchId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const others = current.messages.filter((entry) => entry.messageId !== answer.messageId);
  publish(key, {
    messages: [...others, optimistic],
    failed: current.failed.filter((entry) => entry.messageId !== answer.messageId),
    wake: { state: answer.wake.state, launchId: answer.wake.launchId ?? null },
    readFailed: false,
  });
  void refreshAdeCloudChatQueue(address.machineKey, address.chatId);
}

/** Takes a queued message back. Throws the server's sentence when the computer already has it. */
export async function cancelAdeCloudQueuedMessage(machineKey: string, chatId: string, messageId: string): Promise<void> {
  const cancel = window.ade?.adeCloud?.cancelChatMessage;
  if (!cancel) throw new Error("This version of ADE can't take a queued message back.");
  const answer = await cancel({ machineKey, chatId, messageId });
  if (!answer.ok) throw new Error(answer.message);
  const key = keyOf(machineKey, chatId);
  const current = states.get(key) ?? EMPTY;
  publish(key, { ...current, messages: current.messages.filter((message) => message.messageId !== messageId) });
}

/**
 * The person put a failed message's text back in the composer, or dismissed
 * it: its row goes away in this browser for good.
 */
export function dismissAdeCloudFailedMessage(machineKey: string, chatId: string, messageId: string): void {
  rememberDismissed(messageId);
  const key = keyOf(machineKey, chatId);
  const current = states.get(key);
  if (current) publish(key, { ...current, failed: current.failed.filter((message) => message.messageId !== messageId) });
}

/** Whether the person put back or dismissed this failed message in this browser (a CLI copy's send box filters by it). */
export function adeCloudFailedMessageDismissed(messageId: string): boolean {
  return dismissedIds().has(messageId);
}

/** What `withSavedChatReads` does with a send to a chat whose cloud computer is asleep. */
export type SavedChatQueueSend = (location: SavedChatLocation, args: AgentChatSendArgs) => Promise<"sent" | "unsupported">;

/**
 * Sends through the account's queue. `unsupported` (an older server or
 * computer, files with the message, a message longer than the queue takes,
 * no queue in this ADE): the caller wakes the computer and sends, as before.
 * A refusal throws the server's sentence.
 */
export const sendThroughAdeCloudQueue: SavedChatQueueSend = async (location, args) => {
  const send = window.ade?.cloud?.sendChatMessage;
  if (!send) return "unsupported";
  // Files go with a direct send: the queue takes text only from here.
  if ((args.attachments?.length ?? 0) > 0 || (args.contextAttachments?.length ?? 0) > 0) return "unsupported";
  const text = args.text;
  if (!text.trim()) return "unsupported";
  // Longer than the queue takes: the direct send carries it.
  if (text.length > CLOUD_CHAT_MESSAGE_MAX_CHARS) return "unsupported";
  const messageId = args.clientSendId && /^[A-Za-z0-9_-]{1,64}$/.test(args.clientSendId) ? args.clientSendId : newClientSendId();
  const provider = location.row.provider ?? null;
  // Settings picked since the last send (`updateSession` kept them): the
  // computer applies them before the message. They stay for a direct send
  // until the queue took this one.
  // A model goes only when the person picked one: the computer applies a sent
  // model as a pick, and a gone computer's launch falls back to the saved model.
  const { modelId: pickedModel, ...settings } = peekQueuedChatPicks(location.chatId) ?? {};
  const answer = await send({
    machineKey: location.machineKey,
    chatId: location.chatId,
    messageId,
    text,
    provider,
    ...(pickedModel ? { modelId: pickedModel } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  });
  if (answer.state === "unsupported") return "unsupported";
  if (answer.state === "refused") throw new Error(answer.message);
  clearQueuedChatPicks(location.chatId);
  noteAdeCloudQueuedSend({ machineKey: location.machineKey, chatId: location.chatId }, answer, { text, provider, modelId: pickedModel ?? location.row.model ?? null });
  return "sent";
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The queue of one chat, for its pane. The address is the chat's saved copy
 * (its computer's machine key); a chat with no saved copy has no queue.
 * Reads the queue when the chat opens and when the window gets focus.
 */
export function useAdeCloudChatQueue(args: { pin: OpenProjectBinding | null | undefined; sessionId: string | null | undefined }): AdeCloudChatQueueState & {
  address: { machineKey: string; chatId: string } | null;
  /** The computer is waking for a queued message. */
  waking: boolean;
  refresh: () => void;
  cancel: (messageId: string) => Promise<void>;
  /** Drops a failed row (after the person put its text back, or dismissed it). */
  dismiss: (messageId: string) => void;
} {
  const { pin, sessionId } = args;
  const location = sessionId ? savedChatLocation(pin, sessionId, () => false) ?? savedChatLocationForSession(sessionId) : null;
  const machineKey = location?.machineKey ?? null;
  const chatId = location?.chatId ?? null;
  const key = machineKey && chatId ? keyOf(machineKey, chatId) : null;
  const state = useSyncExternalStore(subscribe, () => (key ? states.get(key) ?? EMPTY : EMPTY), () => EMPTY);
  const refresh = useCallback(() => {
    if (machineKey && chatId) void refreshAdeCloudChatQueue(machineKey, chatId);
  }, [chatId, machineKey]);
  useEffect(() => {
    if (!machineKey || !chatId) return;
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [chatId, machineKey, refresh]);
  const cancel = useCallback(async (messageId: string) => {
    if (!machineKey || !chatId) return;
    await cancelAdeCloudQueuedMessage(machineKey, chatId, messageId);
  }, [chatId, machineKey]);
  const dismiss = useCallback((messageId: string) => {
    if (machineKey && chatId) dismissAdeCloudFailedMessage(machineKey, chatId, messageId);
  }, [chatId, machineKey]);
  const waking = state.messages.some((message) => message.state === "queued") && state.wake?.state !== "launching";
  return { ...state, address: machineKey && chatId ? { machineKey, chatId } : null, waking, refresh, cancel, dismiss };
}
