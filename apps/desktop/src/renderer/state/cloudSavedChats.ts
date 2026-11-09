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
import type { CloudSavedChatPage, CloudSavedChatRow } from "../../shared/cloudSavedChats";
import type { LaneSummary } from "../../shared/types/lanes";
import type { OpenProjectBinding } from "../../shared/types/core";
import type { TerminalSessionSummary } from "../../shared/types/sessions";
import type { AgentChatApi } from "../components/chat/agentChatApi";

/** A machine id for a saved computer that no longer has a connection target (deleted). */
export const SAVED_CHATS_MACHINE_PREFIX = "cloud-saved:";

export function isSavedChatsMachineId(machineId: string): boolean {
  return machineId.startsWith(SAVED_CHATS_MACHINE_PREFIX);
}

export type SavedChatLocation = {
  machineKey: string;
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
  } as TerminalSessionSummary;
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
  } as unknown as LaneSummary;
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
  } as unknown as AgentChatSessionSummary;
}

type SavedChatsBridge = NonNullable<NonNullable<Window["ade"]["cloud"]>["savedChats"]>;

/**
 * The chat API, with reads answered from the saved copy while the chat's
 * machine isn't connected. Everything else, sends included, goes through
 * untouched; a send to a computer that no longer exists says so plainly.
 */
export function withSavedChatReads(
  api: AgentChatApi,
  bridge: SavedChatsBridge | null | undefined,
  machineOnline: (machineId: string) => boolean,
  onSavedChatDeleted?: (machineKey: string, chatId: string) => void,
): AgentChatApi {
  if (!bridge) return api;
  const locate = (sessionId: string, pin?: OpenProjectBinding | null) => savedChatLocation(pin, sessionId, machineOnline);
  const target = api;
  // The target is a copy: the real API is a frozen contextBridge object, and a
  // Proxy may not answer differently for a non-configurable property of its target.
  return new Proxy({ ...api }, {
    get(_copy, prop) {
      const value = Reflect.get(api, prop);
      // Not a method, or one this API doesn't have: nothing to answer from a saved copy.
      if (typeof value !== "function") return value;
      if (prop === "getEventHistory") {
        return async (args: Parameters<AgentChatApi["getEventHistory"]>[0], pin?: OpenProjectBinding | null) => {
          const location = locate(args.sessionId, pin);
          if (!location) return target.getEventHistory(args, pin);
          const page = await bridge.read({ machineKey: location.machineKey, chatId: location.chatId }).catch(() => null);
          if (!page) return { sessionId: args.sessionId, events: [], truncated: false, sessionFound: true, hasOlderHistory: false, unavailable: true } satisfies AgentChatEventHistorySnapshot;
          return savedChatSnapshot(page, args.sessionId);
        };
      }
      if (prop === "getEventHistoryPage") {
        return async (args: Parameters<AgentChatApi["getEventHistoryPage"]>[0], pin?: OpenProjectBinding | null) => {
          const location = locate(args.sessionId, pin);
          if (!location) return target.getEventHistoryPage(args, pin);
          const page = await bridge.read({ machineKey: location.machineKey, chatId: location.chatId, before: args.beforeOffset }).catch(() => null);
          if (!page) return { sessionId: args.sessionId, events: [], startOffset: args.beforeOffset, hasMore: false, sessionFound: true, unavailable: true } satisfies AgentChatEventHistoryPage;
          return savedChatHistoryPage(page, args.sessionId);
        };
      }
      if (prop === "getSummary") {
        return async (args: Parameters<AgentChatApi["getSummary"]>[0], pin?: OpenProjectBinding | null) => {
          const location = locate(args.sessionId, pin);
          return location ? savedChatSummary(location) : target.getSummary(args, pin);
        };
      }
      if (prop === "send") {
        return async (args: Parameters<AgentChatApi["send"]>[0], pin?: OpenProjectBinding | null) => {
          const location = locate(args.sessionId, pin);
          if (location?.computerGone) throw new Error("This computer was deleted. Its chats are saved here, but it can't answer anymore.");
          return target.send(args, pin);
        };
      }
      if (prop === "delete") {
        return async (args: Parameters<AgentChatApi["delete"]>[0], pin?: OpenProjectBinding | null) => {
          const location = locate(args.sessionId, pin);
          if (location?.computerGone) {
            await bridge.delete({ machineKey: location.machineKey, chatId: location.chatId });
            onSavedChatDeleted?.(location.machineKey, location.chatId);
            return null;
          }
          return target.delete(args, pin);
        };
      }
      return value.bind(api);
    },
  });
}
