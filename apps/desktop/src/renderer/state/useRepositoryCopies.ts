/**
 * The copies of a repository tab, its "Start on" choices and its repository
 * reader, for the renderer. The answers come from `shared/repositoryTab.ts`;
 * this module only gathers the inputs from state the app already has:
 *
 * - the account's project list, through a small injected store
 *   (`publishAccountProjectList`). It is empty until the client keeps the
 *   account list (the account list and its offline cache, slice S4 / L24),
 *   which publishes into it. Do not start a second list: publish here;
 * - the remote-runtime connection snapshot (a push feed, no polling);
 * - this computer's recents and account machine key, read once when a hook
 *   turns on and again on window focus (desktop only; the hosted web client
 *   has no computer of its own, so nothing there is "this computer");
 * - the ADE Cloud lane computers as last read (`adeCloudLaneIndex`, no read).
 *
 * No timer, no poll. Every derivation is memoized on its inputs, so a tick that
 * changes nothing returns the same arrays.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AccountProjectView } from "../../shared/accountProject";
import {
  buildRepositoryCopies,
  repositoryReaderAddress,
  resolveStartOn,
  startOnDefault,
  startOnMachines,
  type MachineAddress,
  type RepositoryCopy,
  type RepositoryCopyInputs,
  type RepositoryTab,
  type StartOnChoice,
} from "../../shared/repositoryTab";
import type { RecentProjectSummary } from "../../shared/types";
import { isWebClientMode } from "../lib/webClientMode";
import { adeCloudLaneComputerForMachine, useAdeCloudLaneComputers } from "./adeCloudLaneIndex";
import { useAdeCloudEnabled } from "./cloudAccess";
import { useStableBinding } from "./laneMachineRouting";
import { useRemoteConnectionSnapshot } from "./projectMachines";

// ── The account project list (injected) ────────────────────────────────────

export type AccountProjectListState = {
  /** `unknown` until something publishes; `signed_out` when there is no account. */
  state: "unknown" | "signed_out" | "ready";
  /** Live projects (removed and merged rows left out), with their copies on every machine. */
  projects: readonly AccountProjectView[];
  /** Machine names by account machine key, for copies on machines with no saved connection. */
  machineNames?: Readonly<Record<string, string>>;
};

const UNKNOWN_LIST: AccountProjectListState = { state: "unknown", projects: [] };
let accountProjectList: AccountProjectListState = UNKNOWN_LIST;
const accountProjectListListeners = new Set<() => void>();

/**
 * Replaces the account's project list that every copies hook reads. The
 * client's account list (and its offline cache) calls this; pass null to clear
 * it (sign-out, account switch).
 */
export function publishAccountProjectList(next: AccountProjectListState | null): void {
  accountProjectList = next ?? UNKNOWN_LIST;
  for (const listener of accountProjectListListeners) listener();
}

function subscribeAccountProjectList(listener: () => void): () => void {
  accountProjectListListeners.add(listener);
  return () => accountProjectListListeners.delete(listener);
}

const readAccountProjectList = () => accountProjectList;

/** The account's project list as last published. */
export function useAccountProjectList(): AccountProjectListState {
  return useSyncExternalStore(subscribeAccountProjectList, readAccountProjectList, readAccountProjectList);
}

// ── This computer ───────────────────────────────────────────────────────────

let thisMachineKeyCache: string | null = null;
let thisMachineKeyRead: Promise<string | null> | null = null;

function readThisMachineKey(): Promise<string | null> {
  if (thisMachineKeyCache) return Promise.resolve(thisMachineKeyCache);
  thisMachineKeyRead ??= Promise.resolve(window.ade?.account?.getLocalMachineIdentity?.())
    .then((identity) => {
      thisMachineKeyCache = identity?.machineKey?.trim() || null;
      return thisMachineKeyCache;
    })
    .catch(() => null)
    .finally(() => { thisMachineKeyRead = null; });
  return thisMachineKeyRead;
}

type ThisComputer = { machineKey: string | null; localProjects: readonly RecentProjectSummary[] };

const NO_RECENTS: readonly RecentProjectSummary[] = [];

/** This computer's recents and machine key while `active`; null in the hosted web client. */
function useThisComputer(active: boolean): ThisComputer | null {
  const web = isWebClientMode();
  const [machineKey, setMachineKey] = useState<string | null>(thisMachineKeyCache);
  const [localProjects, setLocalProjects] = useState<readonly RecentProjectSummary[]>(NO_RECENTS);

  useEffect(() => {
    if (!active || web) return undefined;
    let cancelled = false;
    const listRecent = window.ade?.project?.listRecent;
    const read = () => {
      void readThisMachineKey().then((key) => {
        if (!cancelled && key) setMachineKey(key);
      });
      if (typeof listRecent !== "function") return;
      void listRecent().then(
        (rows) => { if (!cancelled) setLocalProjects(rows); },
        () => undefined,
      );
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [active, web]);

  return useMemo(
    () => (web ? null : { machineKey, localProjects }),
    [localProjects, machineKey, web],
  );
}

// ── Last used machine (per client) ──────────────────────────────────────────

/** `{ [tabId]: machineKey }`: the machine this client last started work on for each tab. */
export const START_ON_LAST_MACHINE_STORAGE_KEY = "ade.startOn.lastMachine.v1";

function readLastUsedMachineKey(tabId: string | null): string | null {
  if (!tabId) return null;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(START_ON_LAST_MACHINE_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[tabId];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export type RepositoryCopiesState = {
  copies: RepositoryCopy[];
  /** The inputs `resolveStartOn` also needs, so one hook call feeds both. */
  inputs: RepositoryCopyInputs;
};

const NO_COPIES: RepositoryCopy[] = [];

function useRepositoryCopyState(tab: RepositoryTab | null, active: boolean): RepositoryCopiesState {
  const on = active && tab != null;
  const list = useAccountProjectList();
  const { snapshot } = useRemoteConnectionSnapshot(on);
  const thisComputer = useThisComputer(on);
  const { computers } = useAdeCloudLaneComputers();

  const accountCopies = useMemo(() => {
    if (!tab || tab.kind !== "account" || list.state !== "ready") return null;
    return list.projects.find((project) => project.id === tab.id)?.copies ?? [];
  }, [list, tab]);

  const inputs = useMemo<RepositoryCopyInputs>(() => ({
    accountCopies,
    connections: snapshot?.connections ?? [],
    thisMachine: thisComputer,
    machineNames: list.machineNames,
    isAdeCloudMachine: (machine) => adeCloudLaneComputerForMachine(machine, computers) != null,
  }), [accountCopies, computers, list.machineNames, snapshot, thisComputer]);

  const copies = useMemo(
    () => (tab ? buildRepositoryCopies(tab, inputs) : NO_COPIES),
    [inputs, tab],
  );
  return { copies, inputs };
}

/**
 * Every copy of the tab's repository: on which machine, online or not, which
 * is main, and its address. Pass a stable `tab` (memoize it on its id).
 * `active` false reads nothing and keeps the last answer.
 */
export function useRepositoryCopies(tab: RepositoryTab | null, active = true): RepositoryCopy[] {
  return useRepositoryCopyState(tab, active).copies;
}

export type StartOnState = {
  choices: StartOnChoice[];
  /** The first available choice, or null when nothing can take new work. */
  defaultChoice: StartOnChoice | null;
};

/**
 * What "Start on" offers for new work in the tab, in order (see
 * `resolveStartOn`), and its default.
 */
export function useStartOn(tab: RepositoryTab | null, active = true): StartOnState {
  const { copies, inputs } = useRepositoryCopyState(tab, active);
  const cloudAvailable = useAdeCloudEnabled();
  const tabId = tab?.id ?? null;
  // Read when the tab changes; the writer (a successful start) comes with the picker.
  const lastUsedMachineKey = useMemo(() => readLastUsedMachineKey(tabId), [tabId]);
  const machines = useMemo(() => startOnMachines(inputs), [inputs]);
  return useMemo(() => {
    const choices = resolveStartOn(tab, { copies, machines, lastUsedMachineKey, cloudAvailable });
    return { choices, defaultChoice: startOnDefault(choices) };
  }, [cloudAvailable, copies, lastUsedMachineKey, machines, tab]);
}

/**
 * The address repository-level reads (GitHub issues, PR lists, Linear) use
 * until the client can ask GitHub itself: the first online copy in "Start on"
 * order. Null when no copy is online; the surface shows its empty state and
 * sends nothing. Held by key, so effects keyed on `pin?.key` do not restart.
 */
export function useRepositoryReader(tab: RepositoryTab | null, active = true): MachineAddress | null {
  const { choices } = useStartOn(tab, active);
  return useStableBinding(repositoryReaderAddress(choices));
}
