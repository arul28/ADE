/**
 * Saved chats (ADE Cloud): the copy of a chat the server holds, read while the
 * chat's computer is asleep, stopped, out of hours, or deleted. Machines other
 * than ADE Cloud computers never appear here.
 *
 * Reads only. A person's send still goes to the real machine, whose own path
 * wakes it; a saved copy never wakes anything.
 */

import { parseAgentChatTranscript } from "../../shared/chatTranscript";
import type { AgentChatEventEnvelope, AgentChatEventHistoryPage, AgentChatEventHistorySnapshot, AgentChatSessionSummary } from "../../shared/types/chat";
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
function savedChatLocationForSession(sessionId: string): SavedChatLocation | null {
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
};

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
  const savedReads: Pick<AgentChatApi, "getEventHistory" | "getEventHistoryPage" | "getSummary" | "send" | "delete"> = {
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
      if (!location || !reach || !isSavedChatsMachineId(location.machineId)) return api.send(args, pin);
      const reachedPin = await reach.pinFor(location);
      if (!reachedPin) return api.send(args, pin);
      const result = await api.send(args, reachedPin);
      reach.reached(location);
      return result;
    },
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
