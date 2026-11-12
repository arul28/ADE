/**
 * The machine scope of the open repository, for the page slices.
 *
 * A page that acts on the repository (not on one lane or one chat) needs one
 * of four answers: every online copy (a list merged from all machines), one
 * picked copy (a settings page), the reader copy (GitHub and Linear reads), or
 * one subscription for each online copy (events). Each page group reads them
 * here, so no page group edits a shared state file to get them.
 *
 * Until repository tabs replace the project tab (S4), the open repository is
 * derived from the tab's binding. The tab's own copy is always part of the
 * answer while the tab has one, so a page that moves to these hooks still
 * reaches the machine it reached before.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { accountRepoScopeKey } from "../../shared/accountSettingsScope";
import {
  repositoryTabFromAccountProject,
  thisComputerOnlyTab,
  type MachineAddress,
  type RepositoryCopy,
  type RepositoryTab,
} from "../../shared/repositoryTab";
import type { OpenProjectBinding } from "../../shared/types";
import { useAppStore } from "./appStore";
import {
  originUrlForBinding,
  projectOriginMemoryVersion,
  subscribeProjectOriginMemory,
} from "../components/lanes/laneMachines";
import { useStableBinding } from "./laneMachineRouting";
import { useRemoteTargetState, withMachineTimeout } from "./projectMachines";
import {
  useAccountProjectList,
  useRepositoryCopies,
  useRepositoryReader,
  useStartOn,
  type AccountProjectListState,
  type StartOnState,
} from "./useRepositoryCopies";

// ── The open repository ─────────────────────────────────────────────────────

/**
 * The repository tab of a project binding: the account project when the list
 * knows the origin, else an account tab keyed by the origin's address, else
 * (no GitHub origin) a this-computer-only tab for the folder. Null with no
 * binding. A local binding carries no origin, so `originUrl` gives the one the
 * recents know for its folder (`originUrlForBinding`).
 */
export function repositoryTabForBinding(
  binding: OpenProjectBinding | null,
  list: AccountProjectListState,
  originUrl: string | null = binding?.gitOriginUrl ?? null,
): RepositoryTab | null {
  if (!binding) return null;
  const repoKey = accountRepoScopeKey(originUrl);
  const iconDataUrl = binding.kind === "remote" ? binding.iconDataUrl ?? null : null;
  if (repoKey) {
    if (list.state === "ready") {
      const project = list.projects.find((row) => row.repoKey === repoKey || row.aliases.includes(repoKey));
      if (project) return repositoryTabFromAccountProject(project, { iconDataUrl });
    }
    const address = repoKey.slice("repo:".length);
    const host = address.split("/")[0]?.toLowerCase() || "github.com";
    return {
      kind: "account",
      // Not on the account list (yet): the address stands in for the id.
      id: repoKey,
      displayName: binding.displayName,
      iconDataUrl,
      host,
      repoKeys: [repoKey],
    };
  }
  return thisComputerOnlyTab({ rootPath: binding.rootPath, displayName: binding.displayName, iconDataUrl });
}

function tabIdentity(tab: RepositoryTab | null): string {
  if (!tab) return "";
  return tab.kind === "account"
    ? `${tab.id}\n${tab.displayName}\n${tab.iconDataUrl ?? ""}\n${tab.repoKeys.join(",")}`
    : `${tab.id}\n${tab.displayName}\n${tab.iconDataUrl ?? ""}`;
}

/** The repository the window shows, held by identity so effects keyed on it do not restart. */
export function useActiveRepositoryTab(): RepositoryTab | null {
  const binding = useAppStore((state) => state.projectBinding);
  const list = useAccountProjectList();
  // The origin memory fills from the recents after the tab opens; a local
  // binding has no origin of its own, so the tab follows the memory.
  const originVersion = useSyncExternalStore(subscribeProjectOriginMemory, projectOriginMemoryVersion, projectOriginMemoryVersion);
  const tab = useMemo(
    () => repositoryTabForBinding(binding, list, originUrlForBinding(binding)),
    // originVersion: the memory changed, so read the origin again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [binding, list, originVersion],
  );
  const held = useRef(tab);
  if (tabIdentity(held.current) !== tabIdentity(tab)) held.current = tab;
  return held.current;
}

/**
 * The copy the tab is bound to today, or null. Null also while that copy's
 * computer is offline: the page then shows its no-computer state and calls
 * nothing, instead of a connection error. A copy on this computer is always
 * online. Read it; do not pass it to silence a missing pin.
 */
export function useTabCopyPin(): MachineAddress | null {
  const binding = useAppStore((state) => state.projectBinding);
  const targetState = useRemoteTargetState(binding?.kind === "remote" ? binding.targetId : null);
  return useStableBinding(targetState === "offline" ? null : binding);
}

/** Every copy of the open repository (see `useRepositoryCopies`). */
export function useActiveRepositoryCopies(active = true): RepositoryCopy[] {
  return useRepositoryCopies(useActiveRepositoryTab(), active);
}

/** "Start on" for new work in the open repository (see `useStartOn`). */
export function useActiveStartOn(active = true): StartOnState {
  return useStartOn(useActiveRepositoryTab(), active);
}

/**
 * The address of repository-level reads (GitHub, PR lists, Linear): the tab's
 * copy while the tab has one, so the read goes where it went before; else the
 * first online copy in "Start on" order. Null when nothing is online: show the
 * empty state and call nothing.
 */
export function useActiveRepositoryReader(active = true): MachineAddress | null {
  const tabPin = useTabCopyPin();
  const reader = useRepositoryReader(useActiveRepositoryTab(), active && tabPin == null);
  return tabPin ?? reader;
}

function holdPins(previous: readonly MachineAddress[], next: readonly MachineAddress[]): readonly MachineAddress[] {
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index]?.key !== next[index]?.key) return next;
  }
  return previous;
}

/**
 * The address of every online copy of the open repository, the tab's copy
 * first. Held by keys, so effects keyed on `pinKeys(pins)` restart only when a
 * machine comes or goes. Empty when nothing is online.
 */
export function useOnlineCopyPins(active = true): readonly MachineAddress[] {
  const tabPin = useTabCopyPin();
  const copies = useActiveRepositoryCopies(active);
  const next = useMemo(() => {
    const pins: MachineAddress[] = tabPin ? [tabPin] : [];
    for (const copy of copies) {
      if (!copy.online || !copy.address) continue;
      if (pins.some((pin) => pin.key === copy.address?.key)) continue;
      pins.push(copy.address);
    }
    return pins;
  }, [copies, tabPin]);
  const held = useRef<readonly MachineAddress[]>(next);
  held.current = holdPins(held.current, next);
  return held.current;
}

/** One string for a list of pins: the dependency of an effect over them. */
export function pinKeys(pins: readonly { key: string }[]): string {
  return pins.map((pin) => pin.key).join("\n");
}

// ── One copy picked on a page (C-pick) ──────────────────────────────────────

/** `{ ["<tab id>\n<scope>"]: "<address key>" }`: the copy this client picked on a page. */
export const COPY_PICK_STORAGE_KEY = "ade.copyPick.v1";

function readCopyPick(slot: string): string | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COPY_PICK_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[slot];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function writeCopyPick(slot: string, key: string | null): void {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COPY_PICK_STORAGE_KEY) ?? "{}");
    const map = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    if (key) map[slot] = key;
    else delete map[slot];
    window.localStorage.setItem(COPY_PICK_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A pick that cannot be saved still holds for this page view.
  }
}

export type CopyPick = {
  /** The online copies the picker offers. */
  pins: readonly MachineAddress[];
  /** The picked copy while it is online, else the tab's copy, else the first online copy. Null when none is online. */
  pin: MachineAddress | null;
  /** Pick a copy by its address key; null goes back to the default. */
  pick: (key: string | null) => void;
};

/**
 * One copy picked on a page, remembered per client for each repository and
 * page (`scope`, e.g. "settings.projectConfig"). The default is the tab's
 * copy, which is where the page read before it had a picker.
 */
export function useCopyPick(scope: string, active = true): CopyPick {
  const tab = useActiveRepositoryTab();
  const pins = useOnlineCopyPins(active);
  const slot = tab ? `${tab.id}\n${scope}` : null;
  const [picked, setPicked] = useState<string | null>(() => (slot ? readCopyPick(slot) : null));
  const [readSlot, setReadSlot] = useState(slot);
  if (readSlot !== slot) {
    setReadSlot(slot);
    setPicked(slot ? readCopyPick(slot) : null);
  }
  const pin = useStableBinding(pins.find((candidate) => candidate.key === picked) ?? pins[0] ?? null);
  return useMemo(() => ({
    pins,
    pin,
    pick: (key: string | null) => {
      setPicked(key);
      if (slot) writeCopyPick(slot, key);
    },
  }), [pin, pins, slot]);
}

// ── One subscription for each machine ───────────────────────────────────────

/**
 * Keeps one subscription for each pin, keyed on `pin.key`: a machine that
 * comes online is subscribed, one that goes away is unsubscribed, and the
 * others are left alone (their shared event pump keeps running). `subscribe`
 * may change on every render; the latest one is used for new machines.
 *
 * Example: `useEachMachineSubscription(pins, (pin) => window.ade.lanes.onLifecycleEvent(onEvent, pin))`.
 */
export function useEachMachineSubscription(
  pins: readonly MachineAddress[],
  subscribe: (pin: MachineAddress) => () => void,
): void {
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const removers = useRef(new Map<string, () => void>());
  const keys = pinKeys(pins);

  useEffect(() => {
    const live = new Set(pinsRef.current.map((pin) => pin.key));
    for (const [key, remove] of removers.current) {
      if (live.has(key)) continue;
      remove();
      removers.current.delete(key);
    }
    for (const pin of pinsRef.current) {
      if (removers.current.has(pin.key)) continue;
      removers.current.set(pin.key, subscribeRef.current(pin));
    }
  }, [keys]);

  useEffect(() => () => {
    for (const remove of removers.current.values()) remove();
    removers.current.clear();
  }, []);
}

// ── Calls to several machines ───────────────────────────────────────────────

export type MachineCallResult<T> =
  | { pin: MachineAddress; ok: true; value: T }
  | { pin: MachineAddress; ok: false; error: unknown };

/**
 * Calls every pin at once and keeps each machine's answer apart. A machine
 * other than the tab's gets the 8 s machine timeout; the tab's own call keeps
 * no timeout, as before. One failed machine never fails the others.
 */
export function callEachMachine<T>(
  pins: readonly MachineAddress[],
  call: (pin: MachineAddress) => Promise<T>,
  options: { tabPinKey?: string | null; machineName?: (pin: MachineAddress) => string } = {},
): Promise<MachineCallResult<T>[]> {
  return Promise.all(pins.map(async (pin): Promise<MachineCallResult<T>> => {
    try {
      const pending = call(pin);
      const value = pin.key === options.tabPinKey
        ? await pending
        : await withMachineTimeout(pending, options.machineName?.(pin) ?? pin.displayName);
      return { pin, ok: true, value };
    } catch (error) {
      return { pin, ok: false, error };
    }
  }));
}

/**
 * Splits items by the machine each one lives on, for a call that takes ids of
 * one machine only (settle, snooze, wake). Items with no machine are returned
 * apart; the caller shows them as not sent.
 */
export function groupByMachine<T>(
  items: readonly T[],
  pinFor: (item: T) => MachineAddress | null | undefined,
): { groups: Array<{ pin: MachineAddress; items: T[] }>; unrouted: T[] } {
  const byKey = new Map<string, { pin: MachineAddress; items: T[] }>();
  const unrouted: T[] = [];
  for (const item of items) {
    const pin = pinFor(item);
    if (!pin) {
      unrouted.push(item);
      continue;
    }
    const group = byKey.get(pin.key);
    if (group) group.items.push(item);
    else byKey.set(pin.key, { pin, items: [item] });
  }
  return { groups: [...byKey.values()], unrouted };
}
