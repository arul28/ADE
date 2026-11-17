/**
 * Saved chats (ADE Cloud): the copy of a chat the server holds, read while the
 * chat's computer is asleep, stopped, out of hours, or deleted. Machines other
 * than ADE Cloud computers never appear here.
 *
 * Reads only. A person's send still goes to the real machine, whose own path
 * wakes it; a saved copy never wakes anything.
 */

import { parseAgentChatTranscript } from "../../shared/chatTranscript";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatUpdateSessionArgs,
} from "../../shared/types/chat";
import { savedChatsMachineKey, type CloudSavedChatPage, type CloudSavedChatRow } from "../../shared/cloudSavedChats";
import { REMOTE_TARGET_NOT_FOUND_MESSAGE } from "../../shared/types/remoteRuntime";
import type { LaneSummary } from "../../shared/types/lanes";
import type { OpenProjectBinding } from "../../shared/types/core";
import type { TerminalSessionSummary } from "../../shared/types/sessions";
import type { AgentChatApi } from "../components/chat/agentChatApi";

/** Whether a store machine id is a saved chat's computer this window has no connection to. */
export function isSavedChatsMachineId(machineId: string): boolean {
  return savedChatsMachineKey(machineId) != null;
}

/** What a chat on a deleted cloud computer says when something is sent or asked of it. */
export const SAVED_CHAT_COMPUTER_GONE_MESSAGE = "This computer was deleted. Its chats are saved here, but it can't answer anymore.";

export type SavedChatLocation = {
  /** The machine the chat lives on now: a send goes there. */
  machineKey: string;
  /**
   * The machine whose saved copy is read: `machineKey`, except for a lane that
   * moved to a new computer, whose chats are read from the old computer's copy
   * until the new one saves its own (contract C3).
   */
  readMachineKey: string;
  chatId: string;
  /** Store machine id, to check whether the machine came back. */
  machineId: string;
  /** True when no connection target exists any more: nothing can be sent there. */
  computerGone: boolean;
  row: CloudSavedChatRow;
};

/**
 * Connections whose computer is an ADE Cloud computer that still exists: the
 * saved chats list holds chats under their keys. Filled by the same list read.
 * A connection target is a browser environment id on ADE Web, so this is how a
 * list knows such a connection is a cloud computer the moment its rows dim,
 * before its saved copies are read in.
 */
let cloudConnectionKeys: ReadonlyMap<string, string> = new Map();

/** Each cloud computer's connection target id, with that computer's account key. */
export function replaceCloudConnectionTargets(targets: Iterable<readonly [targetId: string, machineKey: string]>): void {
  cloudConnectionKeys = new Map(targets);
  for (const listener of cloudConnectionListeners) listener();
}

const cloudConnectionListeners = new Set<() => void>();

/** Calls the listener after each change of the cloud connections list. */
export function subscribeCloudConnectionTargets(listener: () => void): () => void {
  cloudConnectionListeners.add(listener);
  return () => cloudConnectionListeners.delete(listener);
}

export function isCloudConnectionTarget(machineId: string): boolean {
  return cloudConnectionKeys.has(machineId);
}

/**
 * The account key of the cloud computer behind a connection, or null. A
 * connection's own fields may not carry it (ADE Web's target has none, and
 * its host name is the box's OS name), so a wake reads it here.
 */
export function cloudConnectionMachineKey(machineId: string): string | null {
  return cloudConnectionKeys.get(machineId) ?? null;
}

/** `pinKey\0sessionId` → the saved copy, filled by the sidebar's list read. */
const locations = new Map<string, SavedChatLocation>();
const locationKey = (pinKey: string, sessionId: string) => `${pinKey}\0${sessionId}`;

export function replaceSavedChatLocations(next: Array<{ pinKey: string; location: SavedChatLocation }>): void {
  locations.clear();
  for (const { pinKey, location } of next) locations.set(locationKey(pinKey, location.chatId), location);
}

/** The saved copy for this chat on this pin, while its machine isn't connected. */
export function savedChatLocation(
  pin: OpenProjectBinding | null | undefined,
  sessionId: string,
  machineOnline: (machineId: string) => boolean,
): SavedChatLocation | null {
  if (!pin) return null;
  const location = locations.get(locationKey(pin.key, sessionId));
  if (!location) return null;
  return location.computerGone || !machineOnline(location.machineId) ? location : null;
}

/**
 * The saved copy of a chat by its id alone, whatever pin asked. For a read
 * whose pin names a connection this window no longer has ("Remote target was
 * not found"): the chat is the same on any machine that saved it.
 */
export function savedChatLocationForSession(sessionId: string): SavedChatLocation | null {
  for (const location of locations.values()) {
    if (location.chatId === sessionId) return location;
  }
  return null;
}

/** The main process's refusal for a pin whose connection this window no longer has. */
function goneConnection(error: unknown): boolean {
  const message = REMOTE_TARGET_NOT_FOUND_MESSAGE.replace(/\.$/, "");
  return (error instanceof Error ? error.message : String(error)).includes(message);
}

/** Whether the chat's computer was deleted (its chats live on as saved copies). */
export function savedChatComputerGone(pin: OpenProjectBinding | null | undefined, sessionId: string): boolean {
  return savedChatLocation(pin, sessionId, () => false)?.computerGone === true;
}

/** The synthetic row for a chat on a computer not currently connected. */
export function savedChatSession(row: CloudSavedChatRow): TerminalSessionSummary {
  const activity = row.lastActivityAt ?? new Date(row.updatedAt).toISOString();
  return {
    id: row.chatId,
    laneId: row.laneId ?? "unknown",
    laneName: row.laneName ?? "Saved chats",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: (row.toolType ?? "claude-chat") as TerminalSessionSummary["toolType"],
    title: row.title ?? "Saved chat",
    status: "completed",
    startedAt: activity,
    endedAt: activity,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: activity,
    summary: null,
    resumeCommand: null,
    runtimeState: "idle",
    cloudSavedCopy: true,
    // A chat another chat started nests under it in Work, as it does live.
    ...(row.parentChatId && row.parentChatId !== row.chatId ? { orchestrationParentSessionId: row.parentChatId } : {}),
    ...(row.spawnKind === "subagent" || row.spawnKind === "peer" ? { spawnKind: row.spawnKind } : {}),
  };
}

/** The lane row for a lane only known from saved chats. */
export function savedChatLane(row: CloudSavedChatRow): LaneSummary {
  return {
    id: row.laneId ?? "unknown",
    name: row.laneName ?? "Saved chats",
    laneType: "worktree",
    baseRef: "",
    branchRef: "",
    worktreePath: "",
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: row.lastActivityAt ?? new Date(row.updatedAt).toISOString(),
  };
}

function eventsFromPage(page: CloudSavedChatPage, sessionId: string): AgentChatEventEnvelope[] {
  // Parts come newest first; a transcript reads oldest first.
  const text = [...page.parts].reverse().map((part) => part.text).join("");
  return parseAgentChatTranscript(text).filter((event) => event.sessionId === sessionId);
}

/** A saved chat's newest page, as the live history read answers it. */
export function savedChatSnapshot(page: CloudSavedChatPage, sessionId: string): AgentChatEventHistorySnapshot {
  // No `maxEvents` window: a part can't be paged into, so the whole page shows.
  return {
    sessionId,
    events: eventsFromPage(page, sessionId),
    truncated: page.hasMore,
    sessionFound: true,
    hasOlderHistory: page.hasMore,
    tailStartOffset: page.hasMore ? (page.nextBefore ?? 0) : 0,
  };
}

/** An older page: `beforeOffset` is the part sequence to read before. */
export function savedChatHistoryPage(page: CloudSavedChatPage, sessionId: string): AgentChatEventHistoryPage {
  return {
    sessionId,
    events: eventsFromPage(page, sessionId),
    startOffset: page.nextBefore ?? 0,
    hasMore: page.hasMore,
    sessionFound: true,
  };
}

export function savedChatSummary(location: SavedChatLocation): AgentChatSessionSummary {
  const row = location.row;
  return {
    sessionId: location.chatId,
    laneId: row.laneId ?? "unknown",
    provider: row.provider ?? "claude",
    model: row.model ?? "",
    title: row.title,
    status: "idle",
    startedAt: row.lastActivityAt ?? "",
    lastActivityAt: row.lastActivityAt ?? "",
    endedAt: null,
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
  };
}

/** The settings a person picked for a resting ADE Cloud chat; each key only when picked. */
export type QueuedChatPicks = Pick<AgentChatUpdateSessionArgs, "modelId" | "presetId" | "reasoningEffort" | "fastMode" | "fastTier">;

/**
 * The settings a person picked for a resting ADE Cloud chat, by chat id,
 * until its next send. A queued send carries them to the computer, which
 * applies them before the message (`peekQueuedChatPicks`, then
 * `clearQueuedChatPicks`). A direct send applies them first
 * (`takeQueuedChatPicks`). So a pick never wakes the computer on its own.
 */
const queuedChatPicks = new Map<string, QueuedChatPicks>();

/** This chat's picks since its last send, or null. They stay until a send carries them. */
export function peekQueuedChatPicks(chatId: string): QueuedChatPicks | null {
  return queuedChatPicks.get(chatId) ?? null;
}

/** A send carried the picks: drop them. */
export function clearQueuedChatPicks(chatId: string): void {
  queuedChatPicks.delete(chatId);
}

/** This chat's picks, once (a direct send applies them); null when none. */
export function takeQueuedChatPicks(chatId: string): QueuedChatPicks | null {
  const picks = peekQueuedChatPicks(chatId);
  clearQueuedChatPicks(chatId);
  return picks;
}

/** A send's settings that the account's queue carries, and nothing a computer must store now. */
const QUEUE_CARRIED_UPDATE_KEYS = new Set(["sessionId", "modelId", "presetId", "reasoningEffort", "fastMode", "fastTier"]);

function updateCarriedByQueue(args: AgentChatUpdateSessionArgs): boolean {
  return Object.entries(args).every(([key, value]) => QUEUE_CARRIED_UPDATE_KEYS.has(key) || value === undefined);
}

/** Adds the picked keys of one update to the chat's picks. */
function notePicks(chatId: string, args: AgentChatUpdateSessionArgs): QueuedChatPicks {
  const next: QueuedChatPicks = { ...queuedChatPicks.get(chatId) };
  const modelId = typeof args.modelId === "string" ? args.modelId.trim() : "";
  if (modelId) next.modelId = modelId;
  if (args.presetId !== undefined) next.presetId = args.presetId;
  if (args.reasoningEffort !== undefined) next.reasoningEffort = args.reasoningEffort;
  if (args.fastMode !== undefined) next.fastMode = args.fastMode;
  if (args.fastTier !== undefined) next.fastTier = args.fastTier;
  if (Object.keys(next).length > 0) queuedChatPicks.set(chatId, next);
  return next;
}

/** The chat as its saved copy knows it, with the picks the next send carries. */
function savedChatSessionAfterPick(location: SavedChatLocation, picks: QueuedChatPicks): AgentChatSession {
  const summary = savedChatSummary(location);
  return {
    id: summary.sessionId,
    laneId: summary.laneId,
    provider: summary.provider,
    model: picks.modelId ?? summary.model,
    ...(picks.modelId ? { modelId: picks.modelId } : {}),
    ...(typeof picks.presetId === "string" ? { presetId: picks.presetId } : {}),
    ...(picks.reasoningEffort !== undefined ? { reasoningEffort: picks.reasoningEffort } : {}),
    ...(picks.fastMode !== undefined ? { fastMode: picks.fastMode } : {}),
    ...(picks.fastTier !== undefined ? { fastTier: picks.fastTier } : {}),
    status: "idle",
    createdAt: summary.startedAt,
    lastActivityAt: summary.lastActivityAt,
  };
}

/** The chat shows as unavailable; this says why. */
function logSavedChatReadFailure(error: unknown): null {
  console.warn("[cloud] saved chat read failed", error instanceof Error ? error.message : String(error));
  return null;
}

type SavedChatsBridge = NonNullable<NonNullable<Window["ade"]["cloud"]>["savedChats"]>;

/**
 * Reaches the computer of a saved chat that this window has no connection to
 * (contract C2): the pin to send with, or null to send with the pin as it is.
 * `reached` runs after a send that went through it, so the window can follow
 * the chat to its live machine.
 */
export type SavedChatReach = {
  pinFor: (location: SavedChatLocation) => Promise<OpenProjectBinding | null>;
  reached: (location: SavedChatLocation) => void;
  /**
   * Wakes the ADE Cloud computer behind a pin whose connection refused a call
   * before it was sent, and returns the pin to call with. Null when the pin is
   * not such a computer.
   */
  wakeForSend?: (pin: Extract<OpenProjectBinding, { kind: "remote" }>, sessionId: string) => Promise<OpenProjectBinding | null>;
  /**
   * Sends to a chat whose cloud computer is asleep through the account's
   * queue, which wakes it: the send returns at once (`sent`). `unsupported`
   * (an older server, files with the message): wake, then send, as before.
   */
  queueSend?: (location: SavedChatLocation, args: Parameters<AgentChatApi["send"]>[0]) => Promise<"sent" | "unsupported">;
};

/**
 * ADE Web's refusals before a command leaves: while a connection comes back,
 * and while it has no command list yet (it is dialing). Nothing was sent, so
 * one more call is safe.
 */
const RECONNECTING_REFUSAL = "Reconnecting to this computer. Try again when connected.";
const NOT_LISTED_REFUSAL = "UnsupportedRemoteCommandError";

function refusedBeforeSend(error: unknown): boolean {
  return error instanceof Error && (error.message === RECONNECTING_REFUSAL || error.name === NOT_LISTED_REFUSAL);
}

/**
 * The chat API, with reads answered from the saved copy while the chat's
 * machine isn't connected (or its connection is gone). A send to a computer
 * this window never connected to reaches it by its machine key (`reach`); a
 * send to a computer that no longer exists says so plainly. A chat whose lane
 * is kept without a computer never sends here: the chat pane gives that lane a
 * new computer and starts a new chat on it.
 */
export function withSavedChatReads(
  api: AgentChatApi,
  bridge: SavedChatsBridge | null | undefined,
  machineOnline: (machineId: string) => boolean,
  reach?: SavedChatReach | null,
): AgentChatApi {
  if (!bridge) return api;
  const locate = (sessionId: string, pin?: OpenProjectBinding | null) => savedChatLocation(pin, sessionId, machineOnline);
  /** A read through `live`, answered from the saved copy when its connection is gone. */
  const readOr = async <T>(sessionId: string, live: () => Promise<T>, saved: (location: SavedChatLocation) => Promise<T>): Promise<T> => {
    try {
      return await live();
    } catch (error) {
      const location = goneConnection(error) ? savedChatLocationForSession(sessionId) : null;
      if (!location) throw error;
      return saved(location);
    }
  };
  /**
   * A call to a chat on an ADE Cloud computer that went to sleep before the
   * chat said so: ADE Web refuses it before it leaves (the connection dials
   * again). Wake the computer through the account and call once more, so a
   * send wakes it also before the chat shows it asleep.
   */
  const wakeOnRefusal = async <P extends OpenProjectBinding | null | undefined, T>(
    pin: P,
    sessionId: string,
    run: (pin: P) => Promise<T>,
  ): Promise<T> => {
    try {
      return await run(pin);
    } catch (error) {
      if (!refusedBeforeSend(error) || !reach?.wakeForSend || pin?.kind !== "remote" || !isCloudConnectionTarget(pin.targetId)) throw error;
      const wokenPin = await reach.wakeForSend(pin, sessionId);
      if (!wokenPin) throw error;
      // The woken computer's pin: the same kind of value the caller passed.
      return run(wokenPin as P);
    }
  };
  const savedReads: Pick<AgentChatApi, "getEventHistory" | "getEventHistoryPage" | "getSummary" | "send" | "steer" | "updateSession" | "delete"> = {
    getEventHistory: async (args, pin) => {
      const saved = async (location: SavedChatLocation) => {
        const page = await bridge.read({ machineKey: location.readMachineKey, chatId: location.chatId }).catch(logSavedChatReadFailure);
        if (!page) return { sessionId: args.sessionId, events: [], truncated: false, sessionFound: true, hasOlderHistory: false, unavailable: true } satisfies AgentChatEventHistorySnapshot;
        return savedChatSnapshot(page, args.sessionId);
      };
      const location = locate(args.sessionId, pin);
      return location ? saved(location) : readOr(args.sessionId, () => api.getEventHistory(args, pin), saved);
    },
    getEventHistoryPage: async (args, pin) => {
      const saved = async (location: SavedChatLocation) => {
        const page = await bridge.read({ machineKey: location.readMachineKey, chatId: location.chatId, before: args.beforeOffset }).catch(logSavedChatReadFailure);
        if (!page) return { sessionId: args.sessionId, events: [], startOffset: args.beforeOffset, hasMore: false, sessionFound: true, unavailable: true } satisfies AgentChatEventHistoryPage;
        return savedChatHistoryPage(page, args.sessionId);
      };
      const location = locate(args.sessionId, pin);
      return location ? saved(location) : readOr(args.sessionId, () => api.getEventHistoryPage(args, pin), saved);
    },
    getSummary: async (args, pin) => {
      const location = locate(args.sessionId, pin);
      return location
        ? savedChatSummary(location)
        : readOr(args.sessionId, () => api.getSummary(args, pin), async (gone) => savedChatSummary(gone));
    },
    send: async (args, pin) => {
      const location = locate(args.sessionId, pin);
      if (location?.computerGone) throw new Error(SAVED_CHAT_COMPUTER_GONE_MESSAGE);
      // A computer this window never connected to (another desktop made it):
      // reach it by its machine key, which wakes it, then send there.
      // So is an ADE Cloud computer this window has a connection to that went
      // to sleep: a plain send through the connection only dials, which an
      // asleep computer does not answer.
      if (!location || !reach || !(isSavedChatsMachineId(location.machineId) || isCloudConnectionTarget(location.machineId))) {
        return wakeOnRefusal(pin, args.sessionId, (callPin) => api.send(args, callPin));
      }
      // The account's queue keeps the message and wakes the computer; the
      // send never waits for the computer to come up.
      if (reach.queueSend && await reach.queueSend(location, args) === "sent") return;
      // A direct send (files, an older server): the picks the queue would
      // have carried reach the chat first.
      const reachedPin = await reach.pinFor(location);
      const sendPin = reachedPin ?? pin;
      const picks = takeQueuedChatPicks(location.chatId);
      if (picks) await api.updateSession({ sessionId: args.sessionId, ...picks }, sendPin);
      if (!reachedPin) return api.send(args, pin);
      const result = await api.send(args, reachedPin);
      reach.reached(location);
      return result;
    },
    // The chat's settings go with a send (the model, the mode): the first call
    // of a send that a sleeping computer refuses. A saved chat on a computer
    // this window never connected to has no connection to refuse it: its
    // computer is reached by its machine key first, as a send does.
    updateSession: async (args, pin) => {
      const location = locate(args.sessionId, pin);
      if (location?.computerGone) throw new Error(SAVED_CHAT_COMPUTER_GONE_MESSAGE);
      // Settings that go with a send to a resting ADE Cloud chat (the model,
      // the effort, Fast, a preset): the next send carries them, so this call
      // never wakes the computer and the send never waits for it. Other
      // changes still reach the computer.
      if (location && reach?.queueSend && updateCarriedByQueue(args)
        && (isSavedChatsMachineId(location.machineId) || isCloudConnectionTarget(location.machineId))) {
        return savedChatSessionAfterPick(location, notePicks(location.chatId, args));
      }
      if (location && reach && isSavedChatsMachineId(location.machineId)) {
        const reachedPin = await reach.pinFor(location);
        if (reachedPin) return api.updateSession(args, reachedPin);
      }
      return wakeOnRefusal(pin, args.sessionId, (callPin) => api.updateSession(args, callPin));
    },
    // A message typed while a turn reads running. It names the turn it may
    // join, so after the wake it goes in once or is refused, never twice.
    steer: async (args, pin) => wakeOnRefusal(pin, args.sessionId, (callPin) => api.steer(args, callPin)),
    delete: async (args, pin) => {
      const location = locate(args.sessionId, pin);
      if (location?.computerGone) {
        await bridge.delete({ machineKey: location.readMachineKey, chatId: location.chatId });
        return null;
      }
      return api.delete(args, pin);
    },
  };
  // Not `{ ...api, ...savedReads }`: the web client's chat API is a Proxy with
  // no own keys (`webclient/adapter/federated.ts`), so a spread copied nothing
  // and every other method, `onEvent` first, was undefined there. The chat
  // pane crashed on mount in the web client (ADE-WEB-7). The target is an
  // empty object, not `api`: the desktop's API is frozen by the context
  // bridge, and a Proxy may not answer a frozen target's property with
  // another value.
  return new Proxy({} as AgentChatApi, {
    get: (_target, property) =>
      (Object.hasOwn(savedReads, property)
        ? savedReads[property as keyof typeof savedReads]
        : Reflect.get(api, property)),
    has: (_target, property) => Object.hasOwn(savedReads, property) || Reflect.has(api, property),
  });
}
