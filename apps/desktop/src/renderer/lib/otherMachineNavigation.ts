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

/** How long a chat that just moved to another machine is waited on before the window gives up following it. */
const FOLLOW_MOVED_CHAT_MS = 60_000;

type CrossMachineLanes = ReturnType<typeof rootAppStoreApi.getState>["crossMachineLanesByMachineId"];

function unionListsSession(machines: CrossMachineLanes, sessionId: string): boolean {
  return Object.values(machines ?? {}).some((machine) => machine.sessions.some((session) => session.id === sessionId));
}

/**
 * Connects this window to the account machine `machineKey`, so the union
 * starts reading it. A machine already connected is left alone, and a saved
 * one connects with its saved pairing: pairing again replaces the live
 * connection on that machine. Only a machine this window never saved is
 * paired. Best effort: this computer's own key, or a failure, only logs.
 */
async function connectAccountMachine(machineKey: string): Promise<void> {
  const sameKey = (key: string | null | undefined) => key?.trim().toLowerCase() === machineKey.toLowerCase();
  try {
    const local = (await window.ade.account.getLocalMachineIdentity?.())?.machineKey ?? null;
    if (sameKey(local)) return;
    const runtime = window.ade.remoteRuntime;
    const live = (await runtime.getConnectionSnapshot()).connections
      .find((connection) => sameKey(connection.target.pairedMachine?.machineKey));
    if (live && (live.state === "connected" || live.state === "connecting")) return;
    const saved = live?.target ?? (await runtime.listTargets()).find((target) => sameKey(target.pairedMachine?.machineKey));
    const targetId = saved?.id ?? (await window.ade.account.pairMachine(machineKey)).targetId;
    await runtime.connect(targetId);
  } catch (error) {
    console.warn("[otherMachineNavigation] could not connect the machine the chat moved to", error);
  }
}

/**
 * Call `open` once another machine lists the chat. A chat that just moved
 * there is listed after the union's next read of that machine, which can be
 * well past {@link OTHER_MACHINES_LOOKUP_MS}. The union reads only connected
 * machines, so a `machineKey` that is not listed yet is paired and connected
 * first (a cloud machine made for the move is new to this window). Gives up
 * after a minute. Returns a cancel.
 */
export function openWhenOtherMachineListsSession(sessionId: string, open: () => void, machineKey?: string | null): () => void {
  let done = false;
  let unsubscribe: (() => void) | null = null;
  // The store changes on every chat event; only a new machine list is read.
  let seen: CrossMachineLanes | undefined;
  const stop = () => {
    done = true;
    window.clearTimeout(timer);
    unsubscribe?.();
  };
  const check = () => {
    if (done) return;
    const machines = rootAppStoreApi.getState().crossMachineLanesByMachineId;
    if (machines === seen) return;
    seen = machines;
    if (!unionListsSession(machines, sessionId)) return;
    stop();
    open();
  };
  const timer = window.setTimeout(stop, FOLLOW_MOVED_CHAT_MS);
  unsubscribe = rootAppStoreApi.subscribe(check);
  check();
  const key = machineKey?.trim();
  if (!done && key) void connectAccountMachine(key);
  return stop;
}
