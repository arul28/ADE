import os from "node:os";
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

type ReleasedState = Record<string, string>;

export type SettledLaneReleaseActions = {
  stopDevServers: (laneId: string, chatSessionIds: ReadonlySet<string>) => Promise<string[]>;
  powerOffAppleDevices: (laneId: string, chatSessionIds: ReadonlySet<string>) => Promise<string[]>;
  stopAndroidEmulators: (laneId: string, chatSessionIds: ReadonlySet<string>) => Promise<string[]>;
  releaseMacDesktop: (chatSessionIds: ReadonlySet<string>) => Promise<number>;
};

export type SettledLaneReleaseDeps = SettledLaneReleaseActions & {
  db: Pick<AdeDb, "getJson" | "setJson">;
  /** A brain with no chats on a project still answers; rows are read fresh each sweep. */
  listSessions: () => readonly TerminalSessionSummary[];
  /** A quiet line in one of the lane's chats. */
  notify: (args: { sessionId: string; message: string; detail?: string | null }) => void;
  logger?: Pick<Logger, "info" | "warn"> | null;
  now?: () => number;
  everyMs?: number;
};

function isSettled(session: TerminalSessionSummary): boolean {
  return session.settleOverride === "settled" || Boolean(session.settledAt);
}

/** Chats that have not ended or been archived; an ended chat holds nothing a release could free. */
function isLiveChat(session: TerminalSessionSummary): boolean {
  return isChatToolType(session.toolType) && !session.archivedAt && !session.endedAt;
}

export function createSettledLaneReleaseService(deps: SettledLaneReleaseDeps) {
  const now = deps.now ?? (() => Date.now());
  let sweeping = false;

  const readState = (): ReleasedState => {
    const stored = deps.db.getJson<ReleasedState>(RELEASED_KEY);
    return stored && typeof stored === "object" ? { ...stored } : {};
  };

  const releaseLane = async (laneId: string, chats: readonly TerminalSessionSummary[], lastChat: TerminalSessionSummary): Promise<void> => {
    const chatIds = new Set(chats.map((chat) => chat.id));
    const parts: string[] = [];
    const attempt = async <T>(label: string, step: () => Promise<T>): Promise<T | null> => {
      try {
        return await step();
      } catch (error) {
        deps.logger?.warn("settled_lane_release.step_failed", {
          laneId,
          step: label,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };
    const servers = await attempt("dev_servers", () => deps.stopDevServers(laneId, chatIds));
    if (servers?.length) parts.push(servers.length === 1 ? `dev server on ${servers[0]}` : `dev servers on ${servers.join(", ")}`);
    const appleDevices = await attempt("apple_devices", () => deps.powerOffAppleDevices(laneId, chatIds));
    if (appleDevices?.length) parts.push(`${appleDevices.join(", ")} simulator${appleDevices.length === 1 ? "" : "s"}`);
    const emulators = await attempt("android_emulators", () => deps.stopAndroidEmulators(laneId, chatIds));
    if (emulators?.length) parts.push(`${emulators.join(", ")} emulator${emulators.length === 1 ? "" : "s"}`);
    const screens = await attempt("mac_desktop", () => deps.releaseMacDesktop(chatIds));
    if (screens) parts.push("Mac Desktop control");

    deps.logger?.info("settled_lane_release.done", { laneId, chats: chats.length, released: parts.length });
    if (parts.length === 0) return;
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
      const state = readState();
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
        const settled = chats.filter(isSettled);
        if (settled.length !== chats.length) {
          // A chat woke up: the wait starts over, and the next settle counts again.
          if (state[laneId] !== undefined) {
            delete state[laneId];
            stateChanged = true;
          }
          continue;
        }
        const last = settled.reduce((latest, chat) => (
          Date.parse(chat.settledAt ?? "") > Date.parse(latest.settledAt ?? "") ? chat : latest
        ));
        const lastSettledAt = last.settledAt ?? "";
        const lastMs = Date.parse(lastSettledAt);
        if (!Number.isFinite(lastMs) || now() - lastMs < SETTLED_LANE_RELEASE_DELAY_MS) continue;
        if (state[laneId] === lastSettledAt) continue;
        await releaseLane(laneId, chats, last);
        state[laneId] = lastSettledAt;
        stateChanged = true;
      }
      if (stateChanged) deps.db.setJson(RELEASED_KEY, state);
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
    }>;
  } | null;
  androidEmulatorService?: {
    powerOffEmulators: (args: { laneId: string; avdNames: ReadonlySet<string> }) => Promise<{
      poweredOff: Array<{ avdName: string }>;
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
      const stopped: string[] = [];
      for (const record of hosts.devServers.list()) {
        const sessionId = record.source.sessionId;
        if (record.source.laneId !== laneId || !sessionId || !chatSessionIds.has(sessionId)) continue;
        const result = await stopChatDevServer({ chatSessionId: sessionId, port: record.port, record, logger: hosts.logger ?? null });
        if (result.ok) stopped.push(`:${record.port}`);
      }
      return stopped;
    },
    powerOffAppleDevices: async (laneId, chatSessionIds) => {
      if (!hosts.iosSimulatorService) return [];
      const result = await hosts.iosSimulatorService.powerOffChatStartedDevices({ laneId, chatSessionIds });
      return result.poweredOff.map((device) => device.name ?? device.udid);
    },
    stopAndroidEmulators: async (laneId, chatSessionIds) => {
      if (!hosts.androidEmulatorService) return [];
      const avdNames = new Set(
        new AndroidEmulatorOwnersStore(machineAndroidEmulatorOwnersPath()).read().emulators
          .filter((record) => record.laneId === laneId && record.chatSessionId != null && chatSessionIds.has(record.chatSessionId))
          .map((record) => record.avdName.toLowerCase()),
      );
      if (avdNames.size === 0) return [];
      const result = await hosts.androidEmulatorService.powerOffEmulators({ laneId, avdNames });
      const avdHome = androidAvdHome(process.env, os.homedir());
      return result.poweredOff.map((device) => readAndroidAvd(avdHome, device.avdName)?.displayName ?? device.avdName);
    },
    releaseMacDesktop: async (chatSessionIds) => {
      if (!hosts.macDesktopService) return 0;
      let released = 0;
      for (const chatSessionId of chatSessionIds) {
        const result = await hosts.macDesktopService.releaseIfOwnedBy(chatSessionId);
        if (result.released) released += 1;
      }
      return released;
    },
  };
}
