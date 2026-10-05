// Resolve a navigation target against the OTHER connected machines.
//
// A lane, chat or commit link is openable on this window whenever any machine
// in the cross-machine union holds it: Work lists every machine's chats, Lanes
// selects a lane by `?laneId&machineId`, and History reads a lane's commits from
// its own machine. The navigation dispatcher asks here before it falls back to
// the "cannot find" modal.

import type { LaneSummary, OpenProjectBinding } from "../../shared/types";
import { rootAppStoreApi } from "../state/appStore";
import {
  buildAllMachineLanes,
  connectionOnline,
  createLaneMachineRouter,
} from "../state/laneMachineRouting";

/** How long a link waits for the other machines to report before it gives up. */
export const OTHER_MACHINES_LOOKUP_MS = 3_000;

export type OtherMachines = {
  /**
   * The id of another machine that holds the lane and can be addressed, or null.
   * With `machineId`, only that machine counts.
   */
  machineIdForLane: (laneId: string, machineId?: string | null) => string | null;
  /** True when another machine lists the chat. */
  hasSession: (sessionId: string) => boolean;
  /** True when `machineId` is the machine the project tab is bound to. */
  isActiveMachine: (machineId: string) => boolean;
};

/**
 * The other machines as the union holds them now. Reads the ROOT store: only it
 * carries `crossMachineLanesByMachineId`.
 */
export function readOtherMachines(
  activeBinding: OpenProjectBinding | null,
  activeLanes: readonly LaneSummary[],
): OtherMachines {
  const all = buildAllMachineLanes({
    activeBinding,
    activeLanes,
    machines: rootAppStoreApi.getState().crossMachineLanesByMachineId ?? {},
  });
  const router = createLaneMachineRouter(all);
  return {
    machineIdForLane: (laneId, machineId) => {
      const route = router.route(laneId, machineId);
      // `unroutable`: the machine is known but has no binding, so nothing on it
      // can be read. `bound`: the tab's own machine, which the caller checked.
      return route.kind === "pinned" ? route.machine.machineId : null;
    },
    hasSession: (sessionId) => {
      for (const sessions of all.sessionsByMachineId.values()) {
        if (sessions.some((session) => session.id === sessionId)) return true;
      }
      return false;
    },
    isActiveMachine: (machineId) => router.machine(machineId)?.isActiveBinding === true,
  };
}

/**
 * Run `find` against the other machines. When it misses and a machine is
 * online, wait up to {@link OTHER_MACHINES_LOOKUP_MS} for the union to report:
 * it may not be loaded yet (no Work, Lanes or Files surface was open, or the app
 * just started). `onWaitChange` brackets the wait so the caller can keep the
 * union sync running for its length.
 */
export async function findOnOtherMachines<T>(
  read: () => OtherMachines,
  find: (other: OtherMachines) => T | null,
  onWaitChange: (waiting: boolean) => void,
): Promise<T | null> {
  const first = find(read());
  if (first != null) return first;
  const snapshot = await window.ade?.remoteRuntime?.getConnectionSnapshot?.().catch(() => null);
  if (!snapshot?.connections?.some((connection) => connectionOnline(connection))) return null;
  onWaitChange(true);
  try {
    return await new Promise<T | null>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        unsubscribe?.();
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(find(read())), OTHER_MACHINES_LOOKUP_MS);
      unsubscribe = rootAppStoreApi.subscribe(() => {
        const found = find(read());
        if (found != null) finish(found);
      });
    });
  } finally {
    onWaitChange(false);
  }
}
