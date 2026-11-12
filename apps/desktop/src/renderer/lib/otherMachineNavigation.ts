// Resolve a navigation target against the OTHER connected machines.
//
// A lane, chat or commit link is openable on this window whenever any machine
// in the cross-machine union holds it: Work lists every machine's chats, Lanes
// selects a lane by `?laneId&machineId`, and History reads a lane's commits from
// its own machine. The navigation dispatcher asks here before it falls back to
// the "cannot find" modal.

import type { LaneSummary, OpenProjectBinding } from "../../shared/types";
import { rootAppStoreApi } from "../state/appStore";
import { navigateToAppTarget } from "./openExternal";
import { isAdeAvailable } from "./adeAvailability";
import { savedChatsMachineKey } from "../../shared/cloudSavedChats";
import { sameMachineKey } from "../../shared/machineAddress";
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
      // can be read. The tab's own machine routes as `pinned` too, but it is not
      // another machine: the caller already looked there.
      return route.kind === "pinned" && !route.machine.isActiveBinding ? route.machine.machineId : null;
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
 * Whether the machine `machineKey` lists the chat: through a connection to it
 * (`targetIds`, this window's saved connections to that machine), or, with
 * `savedCopy`, as its saved copy while it isn't connected
 * (`cloud-saved:<machine key>`).
 */
function machineListsSession(
  machines: CrossMachineLanes,
  sessionId: string,
  machineKey: string,
  targetIds: ReadonlySet<string>,
  savedCopy: boolean,
): boolean {
  return Object.entries(machines ?? {}).some(([machineId, machine]) =>
    ((savedCopy && sameMachineKey(savedChatsMachineKey(machineId), machineKey)) || (machine.targetId != null && targetIds.has(machine.targetId)))
    && machine.sessions.some((session) => session.id === sessionId));
}

/** The connections that list the chat. */
function targetsListingSession(machines: CrossMachineLanes, sessionId: string): string[] {
  return Object.values(machines ?? {}).flatMap((machine) =>
    machine.targetId != null && machine.sessions.some((session) => session.id === sessionId) ? [machine.targetId] : []);
}

/**
 * Connects this window to the account machine `machineKey`, so the union
 * starts reading it. A machine already connected is left alone, and a saved
 * one connects with its saved pairing: pairing again replaces the live
 * connection on that machine. Only a machine this window never saved is
 * paired. Best effort: this computer's own key, or a failure, only logs.
 */
async function connectAccountMachine(machineKey: string): Promise<void> {
  // Contract C2: a saved connection is reused, a new machine paired through the account.
  // The web client has no `machines` (its stand-in answers nothing).
  if (!isAdeAvailable(window.ade?.machines) || !isAdeAvailable(window.ade.machines.connect)) return;
  try {
    const result = await window.ade.machines.connect(machineKey);
    if (!result.ok) console.warn("[otherMachineNavigation] could not connect the machine the chat moved to", result.message);
  } catch (error) {
    console.warn("[otherMachineNavigation] could not connect the machine the chat moved to", error);
  }
}

/** This window's saved connections to the machine `machineKey`. */
async function savedTargetIdsOf(machineKey: string): Promise<Set<string>> {
  const targets = await window.ade.remoteRuntime.listTargets().catch(() => []);
  return new Set(targets.filter((target) => sameMachineKey(target.pairedMachine?.machineKey, machineKey)).map((target) => target.id));
}

/**
 * Opens the chat in Work once the machine `machineKey` lists it: after a send
 * reached that machine for the first time, or after the chat's lane moved
 * there. The chat keeps its id; only the machine that shows it changes, so
 * the old computer still listing it doesn't count.
 * `connect: false` (a lane move noticed while the person only looks) never
 * opens a connection, so a sleeping cloud computer stays asleep: its saved
 * copy lists the chat, and the person's next send reaches it. With a
 * connection opened, only the live machine's listing counts.
 */
export function followSessionToMachine(sessionId: string, machineKey: string | null, options?: { connect?: boolean }): () => void {
  return openWhenOtherMachineListsSession(sessionId, () => navigateToAppTarget({ kind: "work", sessionId }), machineKey, {
    ...options,
    onlyThatMachine: true,
  });
}

/**
 * Call `open` once another machine lists the chat. A chat that just moved
 * there is listed after the union's next read of that machine, which can be
 * well past {@link OTHER_MACHINES_LOOKUP_MS}. The union reads only connected
 * machines and saved copies, so a `machineKey` is paired and connected first
 * unless `connect` is false. With `onlyThatMachine`, only `machineKey`'s
 * listing counts (a lane move, where the old computer lists the same chat
 * id); without it any machine does (a handoff, whose new chat id exists only
 * on the destination, which may be reached by SSH or be this computer).
 * Gives up after a minute. Returns a cancel.
 */
export function openWhenOtherMachineListsSession(
  sessionId: string,
  open: () => void,
  machineKey?: string | null,
  options?: { connect?: boolean; onlyThatMachine?: boolean },
): () => void {
  let done = false;
  let unsubscribe: (() => void) | null = null;
  const key = machineKey?.trim() || null;
  const onlyOn = options?.onlyThatMachine ? key : null;
  const savedCopy = options?.connect === false;
  let targetIds: ReadonlySet<string> = new Set();
  // Connections already asked about: a new one listing the chat may be the
  // machine's, saved after the follow began (main pairs a moved lane's new
  // computer in the background).
  const asked = new Set<string>();
  let reading = false;
  // The store changes on every chat event; only a new machine list is read.
  let seen: CrossMachineLanes | undefined;
  const stop = () => {
    done = true;
    window.clearTimeout(timer);
    unsubscribe?.();
  };
  const refreshTargets = async () => {
    if (!onlyOn || reading) return;
    reading = true;
    try {
      targetIds = await savedTargetIdsOf(onlyOn);
    } finally {
      reading = false;
    }
    check(true);
  };
  const check = (force = false) => {
    if (done) return;
    const machines = rootAppStoreApi.getState().crossMachineLanesByMachineId;
    if (machines === seen && !force) return;
    seen = machines;
    if (!onlyOn) {
      if (!unionListsSession(machines, sessionId)) return;
    } else if (!machineListsSession(machines, sessionId, onlyOn, targetIds, savedCopy)) {
      const unseen = targetsListingSession(machines, sessionId).filter((id) => !asked.has(id) && !targetIds.has(id));
      if (unseen.length > 0 && !reading) {
        for (const id of unseen) asked.add(id);
        void refreshTargets();
      }
      return;
    }
    stop();
    open();
  };
  const timer = window.setTimeout(stop, FOLLOW_MOVED_CHAT_MS);
  unsubscribe = rootAppStoreApi.subscribe(() => check());
  if (onlyOn) for (const id of targetsListingSession(rootAppStoreApi.getState().crossMachineLanesByMachineId, sessionId)) asked.add(id);
  check();
  if (!done && key) {
    void (options?.connect === false ? refreshTargets() : connectAccountMachine(key).then(refreshTargets));
  }
  return stop;
}
