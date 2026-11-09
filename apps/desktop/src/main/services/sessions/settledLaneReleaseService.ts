import os from "node:os";
import { isSettleTupleSettled } from "../../../shared/sessionCanonicalState";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import type { DevServerRecord, TerminalSessionSummary } from "../../../shared/types";
import { stopChatDevServer } from "../devServers/devServerStop";
import { readAndroidAvd } from "../android/androidAvds";
import { androidAvdHome } from "../android/androidSdk";
import { AndroidEmulatorOwnersStore, machineAndroidEmulatorOwnersPath } from "../android/androidEmulatorOwners";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { getSessionLifecycleSettings } from "./sessionLifecycleSettings";

/**
 * Releases what a lane's chats were using once they have all settled: its
 * simulators, emulators, the dev servers those chats started, and any Mac
 * Desktop control they held. The screen itself is left to its idle close: a
 * stop would force-quit whatever the lane has open on it. Off unless the owner turns it on (`releaseLaneResourcesOnSettle`).
 *
 * The clock is the chats' own `settled_at` column, read on a slow sweep, not a
 * timer armed when something settles. That is the whole reason it survives a
 * brain restart, needs no settle hook in the seven call paths that write that
 * column, and notices a chat settled from a phone or another machine: all of
 * them end up in this brain's project database.
 */

export const SETTLED_LANE_RELEASE_DELAY_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const RELEASED_KEY = "session:settled-lane-release:v1";
/** When a sweep first saw a chat pinned settled: a pin writes no `settled_at` of its own. */
const PINNED_SINCE_KEY = "session:settled-lane-release:pinned-since:v1";
/** A failing step is tried again on later sweeps, this many passes in all. */
const MAX_RELEASE_PASSES = 5;

type ReleasedState = Record<string, string>;

/** What one step let go of, and whether something it should have stopped failed. */
export type SettledLaneReleaseStep = { released: string[]; incomplete?: boolean };

export type SettledLaneReleaseActions = {
  stopDevServers: (laneId: string, chatSessionIds: ReadonlySet<string>) => Promise<SettledLaneReleaseStep>;
  powerOffAppleDevices: (laneId: string, chatSessionIds: ReadonlySet<string>) => Promise<SettledLaneReleaseStep>;
  stopAndroidEmulators: (laneId: string, chatSessionIds: ReadonlySet<string>) => Promise<SettledLaneReleaseStep>;
  releaseMacDesktop: (chatSessionIds: ReadonlySet<string>) => Promise<SettledLaneReleaseStep>;
};

export type SettledLaneReleaseDeps = SettledLaneReleaseActions & {
  db: Pick<AdeDb, "getJson" | "setJson">;
  /** A bounded page for finding lanes to look at; rows are read fresh each sweep. */
  listSessions: () => readonly TerminalSessionSummary[];
  /** Every row of one lane, read before anything is stopped. */
  listLaneSessions: (laneId: string) => readonly TerminalSessionSummary[];
  /** A quiet line in one of the lane's chats. */
  notify: (args: { sessionId: string; message: string; detail?: string | null }) => void;
  logger?: Pick<Logger, "info" | "warn"> | null;
  now?: () => number;
  everyMs?: number;
};

/** Chats that have not ended or been archived; an ended chat holds nothing a release could free. */
function isLiveChat(session: TerminalSessionSummary): boolean {
  return isChatToolType(session.toolType) && !session.archivedAt && !session.endedAt;
}

function readStringRecord(db: Pick<AdeDb, "getJson">, key: string): Record<string, string> {
  const stored = db.getJson<Record<string, string>>(key);
  return stored && typeof stored === "object" ? { ...stored } : {};
}

export function createSettledLaneReleaseService(deps: SettledLaneReleaseDeps) {
  const now = deps.now ?? (() => Date.now());
  let sweeping = false;
  const passesByLane = new Map<string, number>();

  const liveLaneChats = (laneId: string) => deps.listLaneSessions(laneId).filter(isLiveChat);
  const laneStillSettled = (laneId: string) => {
    const chats = liveLaneChats(laneId);
    return chats.length > 0 && chats.every(isSettleTupleSettled);
  };

  /** "cancelled" when a chat woke part way; "incomplete" when a step should be tried again. */
  const releaseLane = async (
    laneId: string,
    chats: readonly TerminalSessionSummary[],
    lastChat: TerminalSessionSummary,
  ): Promise<"done" | "incomplete" | "cancelled"> => {
    const chatIds = new Set(chats.map((chat) => chat.id));
    const parts: string[] = [];
    let incomplete = false;
    let cancelled = false;
    const attempt = async (label: string, step: () => Promise<SettledLaneReleaseStep>): Promise<string[]> => {
      // Each step can take seconds: a chat that woke meanwhile keeps the rest.
      if (cancelled || !laneStillSettled(laneId)) {
        cancelled = true;
        return [];
      }
      try {
        const result = await step();
        if (result.incomplete) incomplete = true;
        return result.released;
      } catch (error) {
        incomplete = true;
        deps.logger?.warn("settled_lane_release.step_failed", {
          laneId,
          step: label,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    };
    const servers = await attempt("dev_servers", () => deps.stopDevServers(laneId, chatIds));
    if (servers.length) parts.push(servers.length === 1 ? `dev server on ${servers[0]}` : `dev servers on ${servers.join(", ")}`);
    const appleDevices = await attempt("apple_devices", () => deps.powerOffAppleDevices(laneId, chatIds));
    if (appleDevices.length) parts.push(`${appleDevices.join(", ")} simulator${appleDevices.length === 1 ? "" : "s"}`);
    const emulators = await attempt("android_emulators", () => deps.stopAndroidEmulators(laneId, chatIds));
    if (emulators.length) parts.push(`${emulators.join(", ")} emulator${emulators.length === 1 ? "" : "s"}`);
    const screens = await attempt("mac_desktop", () => deps.releaseMacDesktop(chatIds));
    if (screens.length) parts.push("Mac Desktop control");

    deps.logger?.info("settled_lane_release.done", { laneId, chats: chats.length, released: parts.length, incomplete, cancelled });
    if (parts.length > 0) {
      try {
        deps.notify({
          sessionId: lastChat.id,
          message: `Lane settled: released ${parts.join(", ")}.`,
          detail: "Turn this off in Settings › Lanes.",
        });
      } catch (error) {
        deps.logger?.warn("settled_lane_release.notify_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return cancelled ? "cancelled" : incomplete ? "incomplete" : "done";
  };

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    if (!getSessionLifecycleSettings(deps.db).releaseLaneResourcesOnSettle) return;
    sweeping = true;
    try {
      const byLane = new Map<string, TerminalSessionSummary[]>();
      for (const session of deps.listSessions()) {
        if (!isLiveChat(session) || !session.laneId) continue;
        const list = byLane.get(session.laneId);
        if (list) list.push(session);
        else byLane.set(session.laneId, [session]);
      }
      const state = readStringRecord(deps.db, RELEASED_KEY);
      const storedPins = readStringRecord(deps.db, PINNED_SINCE_KEY);
      const pinnedSince: Record<string, string> = {};
      const settledTime = (chat: TerminalSessionSummary): string => {
        if (chat.settledAt) return chat.settledAt;
        pinnedSince[chat.id] = storedPins[chat.id] ?? new Date(now()).toISOString();
        return pinnedSince[chat.id]!;
      };
      let stateChanged = false;
      const seenLanes = new Set(byLane.keys());
      // A lane with no chats left is not news; forget it so its next chat starts clean.
      for (const laneId of Object.keys(state)) {
        if (!seenLanes.has(laneId)) {
          delete state[laneId];
          stateChanged = true;
        }
      }
      for (const [laneId, chats] of byLane) {
        if (!chats.every(isSettleTupleSettled)) {
          // A chat woke up: the wait starts over, and the next settle counts again.
          passesByLane.delete(laneId);
          if (state[laneId] !== undefined) {
            delete state[laneId];
            stateChanged = true;
          }
          continue;
        }
        const times = chats.map(settledTime);
        const lastSettledAt = times.reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest));
        const lastMs = Date.parse(lastSettledAt);
        if (!Number.isFinite(lastMs) || now() - lastMs < SETTLED_LANE_RELEASE_DELAY_MS) continue;
        if (state[laneId] === lastSettledAt) continue;
        // The page above is bounded; the whole lane decides.
        const laneChats = liveLaneChats(laneId);
        if (!laneChats.every(isSettleTupleSettled)) continue;
        const lastChat = chats[times.indexOf(lastSettledAt)]!;
        const outcome = await releaseLane(laneId, laneChats, lastChat);
        if (outcome === "cancelled") continue;
        const passes = (passesByLane.get(laneId) ?? 0) + 1;
        if (outcome === "incomplete" && passes < MAX_RELEASE_PASSES) {
          passesByLane.set(laneId, passes);
          continue;
        }
        passesByLane.delete(laneId);
        state[laneId] = lastSettledAt;
        stateChanged = true;
      }
      if (stateChanged) deps.db.setJson(RELEASED_KEY, state);
      if (Object.keys(pinnedSince).length !== Object.keys(storedPins).length
        || Object.keys(pinnedSince).some((id) => storedPins[id] !== pinnedSince[id])) {
        deps.db.setJson(PINNED_SINCE_KEY, pinnedSince);
      }
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => {
    void sweep().catch((error) => {
      deps.logger?.warn("settled_lane_release.sweep_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, deps.everyMs ?? SWEEP_EVERY_MS);
  timer.unref?.();

  return {
    sweep,
    dispose: () => clearInterval(timer),
  };
}

export type SettledLaneReleaseService = ReturnType<typeof createSettledLaneReleaseService>;

/** Host services a brain has; each is absent where the platform has none. */
export type SettledLaneReleaseHosts = {
  devServers: { list: () => readonly DevServerRecord[] };
  /** Ports a chat started may not be in the memory-only registry yet after a restart. */
  scanDevServers?: (() => Promise<unknown>) | null;
  iosSimulatorService?: {
    powerOffChatStartedDevices: (args: { laneId: string; chatSessionIds: ReadonlySet<string> }) => Promise<{
      poweredOff: Array<{ udid: string; name: string | null }>;
      incomplete?: boolean;
    }>;
  } | null;
  androidEmulatorService?: {
    powerOffEmulators: (args: { laneId: string; avdNames: ReadonlySet<string> }) => Promise<{
      poweredOff: Array<{ avdName: string }>;
      errors?: readonly unknown[];
    }>;
  } | null;
  macDesktopService?: {
    releaseIfOwnedBy: (chatSessionId: string) => Promise<{ released: boolean }>;
  } | null;
  logger?: Logger | null;
};

/**
 * Each step reaches only what one of the lane's chats started: the chat a dev
 * server's process names, the chat an agent's boot recorded on a simulator, the
 * chat on an emulator's owner record, the chat holding Mac Desktop control. A
 * Keep-running pin and a device in use are checked by the power-off paths.
 */
export function createSettledLaneReleaseActions(hosts: SettledLaneReleaseHosts): SettledLaneReleaseActions {
  return {
    stopDevServers: async (laneId, chatSessionIds) => {
      await hosts.scanDevServers?.();
      const released: string[] = [];
      let incomplete = false;
      for (const record of hosts.devServers.list()) {
        const sessionId = record.source.sessionId;
        if (record.source.laneId !== laneId || !sessionId || !chatSessionIds.has(sessionId)) continue;
        const result = await stopChatDevServer({ chatSessionId: sessionId, port: record.port, record, logger: hosts.logger ?? null });
        if (result.ok) released.push(`:${record.port}`);
        else if (result.reason === "failed") incomplete = true;
      }
      return { released, incomplete };
    },
    powerOffAppleDevices: async (laneId, chatSessionIds) => {
      if (!hosts.iosSimulatorService) return { released: [] };
      const result = await hosts.iosSimulatorService.powerOffChatStartedDevices({ laneId, chatSessionIds });
      return { released: result.poweredOff.map((device) => device.name ?? device.udid), incomplete: result.incomplete };
    },
    stopAndroidEmulators: async (laneId, chatSessionIds) => {
      if (!hosts.androidEmulatorService) return { released: [] };
      const avdNames = new Set(
        new AndroidEmulatorOwnersStore(machineAndroidEmulatorOwnersPath()).read().emulators
          .filter((record) => record.laneId === laneId && record.chatSessionId != null && chatSessionIds.has(record.chatSessionId))
          .map((record) => record.avdName.toLowerCase()),
      );
      if (avdNames.size === 0) return { released: [] };
      const result = await hosts.androidEmulatorService.powerOffEmulators({ laneId, avdNames });
      const avdHome = androidAvdHome(process.env, os.homedir());
      return {
        released: result.poweredOff.map((device) => readAndroidAvd(avdHome, device.avdName)?.displayName ?? device.avdName),
        incomplete: Boolean(result.errors?.length),
      };
    },
    releaseMacDesktop: async (chatSessionIds) => {
      if (!hosts.macDesktopService) return { released: [] };
      const released: string[] = [];
      for (const chatSessionId of chatSessionIds) {
        const result = await hosts.macDesktopService.releaseIfOwnedBy(chatSessionId);
        if (result.released) released.push(chatSessionId);
      }
      return { released };
    },
  };
}
