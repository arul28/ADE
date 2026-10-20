/**
 * Personal chats from every machine at once.
 *
 * A personal chat belongs to a machine, not to a project, so the Chats page
 * lists the chats of every connected machine together, the way the Work tab
 * lists every machine's sessions. Each call names the machine it goes to
 * (`PersonalChatMachineTarget`); nothing here moves the window's project tab.
 * The machine picker beside the composer only chooses where a new chat runs.
 *
 * Machine ids are routing ids: `THIS_MACHINE_ID` or a remote runtime target id
 * on the desktop, a connected target id in the hosted web client.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatSessionSummary,
  OpenProjectBinding,
  PersonalChatAction,
  PersonalChatActionArgs,
  PersonalChatCallArgs,
} from "../../../shared/types";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import type { AgentChatApi } from "../chat/agentChatApi";
import { useAppStore } from "../../state/appStore";
import { machineScopedId } from "../../state/foreignMachineReads";
import { connectionOnline } from "../../state/laneMachineRouting";
import { useRemoteConnectionSnapshot, withMachineTimeout } from "../../state/projectMachines";
import { useWebChatsMachines } from "../../webclient/workspace/useWebChatsMachines";
import { createPersonalAgentChatApi, personalCallResult, type PersonalChatsBridge } from "./personalAgentChatApi";

export type PersonalChatMachine = { id: string; name: string; isThisMachine: boolean };

/** One rail row: a chat, the machine it lives on, and an id unique across machines. */
export type PersonalChatRow = AgentChatSessionSummary & {
  rowId: string;
  machineId: string;
  /** Shown on the row when chats from more than one machine are listed; null for This computer. */
  machineName: string | null;
};

/** The personal-chat bridge for one machine. Resolved per call, like `personalChatsBridge`. */
export function personalChatsBridgeFor(machineId: string): PersonalChatsBridge {
  const target = { machineId };
  const bridge = () => {
    const candidate = (window.ade as typeof window.ade & { personalChats?: Window["ade"]["personalChats"] }).personalChats;
    if (!candidate) throw new Error("Personal chats are not available in this ADE runtime.");
    return candidate;
  };
  return {
    call: (request) => bridge().call(request, target),
    streamEvents: (request) => bridge().streamEvents(request, target),
  };
}

export async function callPersonalOn<T, A extends PersonalChatAction = PersonalChatAction>(
  machineId: string,
  action: A,
  args?: PersonalChatActionArgs<A>,
): Promise<T> {
  const request = (args === undefined ? { action } : { action, args }) as PersonalChatCallArgs;
  return personalCallResult<T>(await personalChatsBridgeFor(machineId).call(request));
}

/**
 * One chat API per machine, shared by the rail and the pane so each machine
 * has one event poller. The poller runs only while something listens.
 */
const apiByMachine = new Map<string, AgentChatApi>();
export function personalAgentChatApiFor(machineId: string): AgentChatApi {
  let api = apiByMachine.get(machineId);
  if (!api) {
    api = createPersonalAgentChatApi(personalChatsBridgeFor(machineId));
    apiByMachine.set(machineId, api);
  }
  return api;
}

/** The catalog scope key for a machine's personal model catalog. */
export function personalChatsMachineTargetKey(machineId: string): string {
  return machineId === THIS_MACHINE_ID ? "local-machine" : `machine:${machineId}`;
}

export type PersonalChatMachinesState = {
  /** Every machine whose chats the rail lists, This computer first. */
  machines: PersonalChatMachine[];
  /** True once the machine list has been read; before that a short list may just be unread. */
  settled: boolean;
  /** The picker beside the composer: where a new chat runs. */
  draftOptions: Array<{ id: string; name: string }>;
  draftOptionId: string;
  /** The machine a new chat is created on, or null while none is reachable. */
  draftMachineId: string | null;
  /** Resolves to an error message, or null when the pick landed. */
  selectDraft: (optionId: string) => Promise<string | null>;
  /** The machine the window is bound to: the Browser tab's docked chat lives there. */
  boundMachineId: string | null;
};

const DRAFT_MACHINE_STORAGE_KEY = "ade.chats.draftMachine.v1";

function readStoredDraftMachine(): string {
  try {
    return window.localStorage.getItem(DRAFT_MACHINE_STORAGE_KEY)?.trim() || THIS_MACHINE_ID;
  } catch {
    return THIS_MACHINE_ID;
  }
}

function storeDraftMachine(machineId: string): void {
  try {
    window.localStorage.setItem(DRAFT_MACHINE_STORAGE_KEY, machineId);
  } catch {
    // Storage unavailable: the pick holds for this visit.
  }
}

function boundMachineIdFor(binding: OpenProjectBinding | null | undefined): string {
  return binding?.kind === "remote" ? binding.targetId : THIS_MACHINE_ID;
}

/** The machines the Chats page lists and creates on. */
export function usePersonalChatMachines(): PersonalChatMachinesState {
  const webMachines = useWebChatsMachines();
  const projectBinding = useAppStore((state) => state.projectBinding);
  const { snapshot, loaded } = useRemoteConnectionSnapshot(!webMachines);
  const [storedDraft, setStoredDraft] = useState(readStoredDraftMachine);

  const desktopMachines = useMemo<PersonalChatMachine[]>(() => {
    const machines: PersonalChatMachine[] = [{ id: THIS_MACHINE_ID, name: THIS_MACHINE_NAME, isThisMachine: true }];
    for (const connection of snapshot?.connections ?? []) {
      if (!connectionOnline(connection) || machines.some((machine) => machine.id === connection.target.id)) continue;
      machines.push({
        id: connection.target.id,
        name: connection.target.name || connection.target.hostname,
        isThisMachine: false,
      });
    }
    return machines;
  }, [snapshot]);

  const selectDesktopDraft = useCallback(async (machineId: string) => {
    storeDraftMachine(machineId);
    setStoredDraft(machineId);
    return null;
  }, []);

  return useMemo<PersonalChatMachinesState>(() => {
    if (webMachines) {
      // A browser has no This computer: the rail lists every live machine, and
      // the picker's machine is the one the chats surface addresses.
      const machines = webMachines.liveMachines.map((machine) => ({ ...machine, isThisMachine: false }));
      return {
        machines,
        settled: true,
        draftOptions: webMachines.options,
        draftOptionId: webMachines.machineId ?? "",
        draftMachineId: webMachines.targetId,
        selectDraft: webMachines.select,
        boundMachineId: webMachines.targetId,
      };
    }
    // A machine picked earlier that is not connected now: new chats run here
    // until it is back, and the pick is kept for then.
    const draftMachineId = desktopMachines.some((machine) => machine.id === storedDraft) ? storedDraft : THIS_MACHINE_ID;
    return {
      machines: desktopMachines,
      settled: loaded || snapshot != null,
      draftOptions: desktopMachines.map(({ id, name }) => ({ id, name })),
      draftOptionId: draftMachineId,
      draftMachineId,
      selectDraft: selectDesktopDraft,
      boundMachineId: boundMachineIdFor(projectBinding),
    };
  }, [desktopMachines, loaded, projectBinding, selectDesktopDraft, snapshot, storedDraft, webMachines]);
}

/** Rail refreshes coalesce: a streaming turn emits many events a second. */
const SESSIONS_REFRESH_DEBOUNCE_MS = 400;

export type MachineChatsLoad = { status: "loading" | "error"; message: string | null };

export type PersonalChatsAcrossMachines = {
  /** Every listed machine's chats, newest first. */
  rows: PersonalChatRow[];
  /** Machines still on their first read, or whose last read failed. */
  loadByMachine: Readonly<Record<string, MachineChatsLoad>>;
  /** Machines that have answered at least once since the view last changed. */
  readMachineIds: ReadonlySet<string>;
  refreshMachine: (machineId: string) => Promise<void>;
};

/**
 * The live or archived chats of every machine in `machines`. Each machine is
 * read on its own and timed out, so one slow or unreachable machine never holds
 * the list; a failed read keeps what that machine showed. Each machine's event
 * stream re-reads only that machine.
 */
export function usePersonalChatsAcrossMachines(
  machines: readonly PersonalChatMachine[],
  showArchived: boolean,
): PersonalChatsAcrossMachines {
  const [rowsByMachine, setRowsByMachine] = useState<Record<string, AgentChatSessionSummary[]>>({});
  const [loadByMachine, setLoadByMachine] = useState<Record<string, MachineChatsLoad>>({});
  const [readMachineIds, setReadMachineIds] = useState<ReadonlySet<string>>(() => new Set());
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const seqRef = useRef(new Map<string, number>());

  const refreshMachine = useCallback(async (machineId: string) => {
    const machine = machinesRef.current.find((entry) => entry.id === machineId);
    if (!machine) return;
    const seq = (seqRef.current.get(machineId) ?? 0) + 1;
    seqRef.current.set(machineId, seq);
    const archived = showArchivedRef.current;
    // A machine that left the list mid-read must not write its rows back: on
    // reconnect they would pass for a fresh read.
    const current = () => seqRef.current.get(machineId) === seq
      && archived === showArchivedRef.current
      && machinesRef.current.some((entry) => entry.id === machineId);
    try {
      const read = callPersonalOn<AgentChatSessionSummary[]>(machineId, "list", { includeArchived: archived });
      const rows = machine.isThisMachine ? await read : await withMachineTimeout(read, machine.name);
      if (!current()) return;
      // Not a list (a peer on another version, a malformed reply) is not "no
      // chats": keep what is shown.
      if (!Array.isArray(rows)) throw new Error("The chat list could not be read.");
      // `includeArchived` returns live chats as well; the archived view shows only the archived ones.
      const inView = rows.filter((session) => Boolean(session.archivedAt) === archived);
      setRowsByMachine((previous) => ({ ...previous, [machineId]: inView }));
      setLoadByMachine((previous) => {
        if (!previous[machineId]) return previous;
        const { [machineId]: _done, ...rest } = previous;
        return rest;
      });
      setReadMachineIds((previous) => (previous.has(machineId) ? previous : new Set([...previous, machineId])));
    } catch (reason) {
      if (!current()) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setLoadByMachine((previous) => ({ ...previous, [machineId]: { status: "error", message } }));
      setReadMachineIds((previous) => (previous.has(machineId) ? previous : new Set([...previous, machineId])));
    }
  }, []);

  const machineIdsKey = machines.map((machine) => machine.id).join("\n");
  const rowsByMachineRef = useRef(rowsByMachine);
  rowsByMachineRef.current = rowsByMachine;

  // A machine that joins is read; one that leaves takes its rows with it.
  // Switching between live and archived chats re-reads every machine.
  const viewRef = useRef<boolean | null>(null);
  useEffect(() => {
    const ids = machineIdsKey ? machineIdsKey.split("\n") : [];
    const viewChanged = viewRef.current !== showArchived;
    viewRef.current = showArchived;
    const needsRead = (id: string) => viewChanged || !(id in rowsByMachineRef.current);
    const listed = <V,>(record: Record<string, V>) => Object.fromEntries(
      Object.entries(record).filter(([id]) => ids.includes(id)),
    ) as Record<string, V>;
    setRowsByMachine((previous) => (viewChanged ? {} : listed(previous)));
    setReadMachineIds((previous) => new Set(viewChanged ? [] : [...previous].filter((id) => ids.includes(id))));
    setLoadByMachine((previous) => {
      const next = viewChanged ? {} : listed(previous);
      for (const id of ids) if (needsRead(id)) next[id] = { status: "loading", message: null };
      return next;
    });
    for (const id of ids) if (needsRead(id)) void refreshMachine(id);
  }, [machineIdsKey, refreshMachine, showArchived]);

  // Each machine's stream refreshes that machine's rows: titles, activity and
  // new chats appear without a manual refresh.
  useEffect(() => {
    const ids = machineIdsKey ? machineIdsKey.split("\n") : [];
    const timers = new Map<string, number>();
    const unsubscribes = ids.map((id) => personalAgentChatApiFor(id).onEvent(() => {
      if (timers.has(id)) return;
      timers.set(id, window.setTimeout(() => {
        timers.delete(id);
        void refreshMachine(id);
      }, SESSIONS_REFRESH_DEBOUNCE_MS));
    }));
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [machineIdsKey, refreshMachine]);

  const rows = useMemo(() => {
    const multiMachine = machines.filter((machine) => (rowsByMachine[machine.id]?.length ?? 0) > 0).length > 1;
    const merged: PersonalChatRow[] = [];
    for (const machine of machines) {
      for (const session of rowsByMachine[machine.id] ?? []) {
        merged.push({
          ...session,
          rowId: machineScopedId(machine.id, session.sessionId),
          machineId: machine.id,
          machineName: multiMachine && !machine.isThisMachine ? machine.name : null,
        });
      }
    }
    return merged.sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
  }, [machines, rowsByMachine]);

  return { rows, loadByMachine, readMachineIds, refreshMachine };
}
