import type { AgentChatFileRef, ChatLaunchSnapshot, OpenProjectBinding } from "../../../../shared/types";
import {
  appendOptimisticQueuedMessage,
  applyChatLaunchSnapshot,
  chatLaunchStore,
  forgetChatLaunchLocalRecord,
  getChatLaunchEntry,
  getChatLaunchLocalRecord,
  markChatLaunchStartFailed,
  removeChatLaunch,
  removeOptimisticQueuedMessage,
  resetChatLaunchStartFailure,
} from "../../../state/chatLaunchStore";
import { isUnsupportedAdeActionError, parseCodedErrorMessage } from "../../../../shared/codedError";
import { toQueuedMessage } from "../../../../shared/chatLaunch";
import { extractError } from "../../../lib/format";
import {
  announceChatLaunchClosed,
  type ChatLaunchClosedNotice,
  type ChatLaunchDraftRestoreRequest,
} from "./chatLaunchDraftRestore";

/**
 * Every button a launch surface offers (thread card, slide-out, sidebar) goes
 * through here, so each action behaves identically wherever it is pressed and
 * always targets the machine that owns the launch.
 */

function pinFor(launchId: string): OpenProjectBinding | null {
  return getChatLaunchEntry(launchId)?.binding ?? getChatLaunchLocalRecord(launchId)?.pin ?? null;
}

function applyResult(launchId: string, snapshot: ChatLaunchSnapshot | null | undefined): void {
  if (!snapshot || snapshot.launchId !== launchId) return;
  applyChatLaunchSnapshot(pinFor(launchId), snapshot);
}

/** Codes a runtime (or the web client's command layer) uses for "I don't serve that action". */
const UNSUPPORTED_ACTION_CODES = new Set(["unsupported_action", "unknown_action"]);

/**
 * True when a runtime rejected `chat.startLaunch` because it predates it (an
 * older paired machine). The launching composer then runs its own legacy
 * create-lane chain for that one launch instead of showing a failed card.
 *
 * Only "the action does not exist" counts: a brain's coded
 * `action_not_callable` / `action_not_exposed` (behind the runtime RPC
 * wrapper), a JSON-RPC `Unknown ADE action`, or the web client finding no
 * command descriptor. Any other rejection is a real failure of a launch the
 * host does support, and shows on the card.
 */
export function isChatLaunchUnsupportedError(error: unknown): boolean {
  if (isUnsupportedAdeActionError(error)) return true;
  const parsed = parseCodedErrorMessage(error);
  if (parsed.code && UNSUPPORTED_ACTION_CODES.has(parsed.code)) return true;
  return /^Unknown ADE action\b/i.test(parsed.message)
    || /\bis unavailable on the connected ADE host\b/i.test(parsed.message);
}

export type StartChatLaunchOutcome = "started" | "failed" | "unsupported";

/**
 * Send (or re-send) this window's `start` for a launch it registered. Never
 * awaited by the launching composer: the UI has already moved on. With
 * `onUnsupported`, a runtime that does not know the action drops the launch
 * (card and sidebar row) and hands it back to the caller instead of failing.
 */
export function startChatLaunch(
  launchId: string,
  options: { onUnsupported?: (() => void) | null } = {},
): Promise<StartChatLaunchOutcome> {
  const record = getChatLaunchLocalRecord(launchId);
  if (!record) return Promise.resolve("failed");
  const api = window.ade?.chatLaunch;
  const fail = (error: unknown): StartChatLaunchOutcome => {
    if (options.onUnsupported && (!api || isChatLaunchUnsupportedError(error))) {
      const snapshot = getChatLaunchEntry(launchId)?.snapshot ?? null;
      removeChatLaunch(launchId);
      forgetChatLaunchLocalRecord(launchId);
      if (snapshot) announceChatLaunchClosed(closedNoticeFor(snapshot));
      options.onUnsupported();
      return "unsupported";
    }
    markChatLaunchStartFailed(launchId, extractError(error));
    return "failed";
  };
  if (!api) return Promise.resolve(fail(new Error("New-lane launches are not available in this window.")));
  let request: Promise<ChatLaunchSnapshot>;
  try {
    request = record.pin ? api.start(record.args, record.pin) : api.start(record.args);
  } catch (error) {
    return Promise.resolve(fail(error));
  }
  return Promise.resolve(request).then(
    (snapshot): StartChatLaunchOutcome => {
      applyResult(launchId, snapshot);
      return "started";
    },
    fail,
  );
}

export async function retryChatLaunch(launchId: string): Promise<void> {
  const entry = getChatLaunchEntry(launchId);
  if (!entry) return;
  if (entry.startError != null && !entry.hostSeen) {
    resetChatLaunchStartFailure(launchId);
    await startChatLaunch(launchId);
    return;
  }
  applyResult(launchId, await window.ade.chatLaunch.retry({ launchId }, pinFor(launchId)));
}

/** Start the agent now; also "Start anyway" after an environment failure. */
export async function startChatLaunchNow(launchId: string): Promise<void> {
  applyResult(launchId, await window.ade.chatLaunch.startNow({ launchId }, pinFor(launchId)));
}

function closedNoticeFor(snapshot: ChatLaunchSnapshot): ChatLaunchClosedNotice {
  return { launchId: snapshot.launchId, sessionId: snapshot.sessionId, kind: snapshot.kind };
}

function restoreRequestFor(launchId: string, snapshot: ChatLaunchSnapshot): ChatLaunchDraftRestoreRequest {
  return {
    launchId,
    kind: snapshot.kind,
    draftSnapshot: getChatLaunchLocalRecord(launchId)?.draftSnapshot ?? null,
    prompt: {
      text: snapshot.prompt.text,
      attachments: snapshot.prompt.attachments,
    },
  };
}

/**
 * Cancel (while running) or Delete (after a failure): the host removes the
 * lane it made — worktree, local and remote branch — and the chat. The tab
 * closes, Work shows the draft again, and the prompt goes back into it.
 */
export async function cancelChatLaunch(launchId: string, options: { restorePrompt?: boolean } = {}): Promise<void> {
  const entry = getChatLaunchEntry(launchId);
  if (!entry) return;
  const snapshot = entry.snapshot;
  const restorePrompt = options.restorePrompt ?? true;
  if (!entry.hostSeen && entry.startError != null) {
    // The host never accepted it. Cancel anyway in case a timed-out start did
    // land, but never let that block removing the card.
    void window.ade?.chatLaunch?.cancel({ launchId }, entry.binding).catch(() => undefined);
    removeChatLaunch(launchId);
  } else {
    applyResult(launchId, await window.ade.chatLaunch.cancel({ launchId }, entry.binding));
  }
  announceChatLaunchClosed(closedNoticeFor(snapshot), restorePrompt ? restoreRequestFor(launchId, snapshot) : null);
  forgetChatLaunchLocalRecord(launchId);
}

/* ── Queued messages ──────────────────────────────────────────────────────
   A message typed into a launching chat. The host cannot take it before it
   has accepted the launch (`queueMessage` answers "Launch not found"), so
   until the entry is host-seen it waits here — its bubble already in the
   thread — and goes out right after `start` lands. Every message of a launch
   goes through one chain, so they reach the host in the order they were
   typed whether or not they had to wait. */

const LAUNCH_GONE_MESSAGE = "This launch was cancelled before the message could be sent.";
const LAUNCH_NOT_FOUND_MESSAGE = "Launch not found.";

/** Tail of each launch's send chain. */
const queueChains = new Map<string, Promise<unknown>>();

/** Resolves once the host has accepted the launch; rejects if the launch goes away first. */
function whenHostAccepted(launchId: string): Promise<void> {
  const settled = (): boolean | null => {
    const entry = chatLaunchStore.getState().entries[launchId];
    if (!entry || entry.snapshot.phase === "cancelled") return false;
    return entry.hostSeen ? true : null;
  };
  const now = settled();
  if (now === true) return Promise.resolve();
  if (now === false) return Promise.reject(new Error(LAUNCH_GONE_MESSAGE));
  return new Promise((resolve, reject) => {
    const unsubscribe = chatLaunchStore.subscribe(() => {
      const next = settled();
      if (next == null) return;
      unsubscribe();
      if (next) resolve();
      else reject(new Error(LAUNCH_GONE_MESSAGE));
    });
  });
}

/**
 * A message typed while the lane is still being set up (or while earlier
 * queued messages still wait for delivery); the host sends them in order once
 * the agent runs. Resolves when the host has the message. On rejection the
 * bubble is gone and the caller puts the text back in the composer.
 */
export function queueChatLaunchMessage(
  launchId: string,
  message: { text: string; displayText?: string | null; attachments?: AgentChatFileRef[] },
): Promise<void> {
  const optimisticId = `local:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const queued = toQueuedMessage(message, { id: optimisticId, createdAt: new Date().toISOString() });
  appendOptimisticQueuedMessage(launchId, queued);
  const send = async () => {
    await whenHostAccepted(launchId);
    const { id: _id, createdAt: _createdAt, ...fields } = queued;
    const snapshot = await window.ade.chatLaunch.queueMessage({ launchId, ...fields }, pinFor(launchId));
    // An older host answers an unknown launch with null instead of throwing.
    if (!snapshot) throw new Error(LAUNCH_NOT_FOUND_MESSAGE);
    // The host's copy (its own id) replaces the stand-in.
    removeOptimisticQueuedMessage(launchId, optimisticId);
    applyResult(launchId, snapshot);
  };
  const previous = queueChains.get(launchId) ?? Promise.resolve();
  // An earlier message failing must not stop this one from being tried.
  const delivery = previous.catch(() => undefined).then(send);
  const tail = delivery.catch(() => undefined);
  queueChains.set(launchId, tail);
  void tail.then(() => {
    if (queueChains.get(launchId) === tail) queueChains.delete(launchId);
  });
  return delivery.catch((error: unknown) => {
    removeOptimisticQueuedMessage(launchId, optimisticId);
    throw error;
  });
}
