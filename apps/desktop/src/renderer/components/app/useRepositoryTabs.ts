/**
 * Repository tabs for the top bar (S4): the tab is the repository, and a copy
 * of it on one machine is what the tab shows now.
 *
 * - `useRepositoryIdentity` joins an origin to the account project, so a
 *   renamed repository and its old address are one tab, and the tab id is the
 *   account project id when the account knows the repository.
 * - `useOneCopyPerRepository` keeps one open copy per repository: when a
 *   switch opens another copy of a repository whose tab is open, the copy the
 *   tab showed before closes in place (same position, its view state kept).
 * - `useNoMachineTabCleanup` drops a no-machine tab once a copy of its
 *   repository is open.
 * - `carryRouteToCopy` keeps the page the person is on when the tab moves to
 *   another copy.
 *
 * Nothing here moves a tab to this computer's copy on its own: which machine
 * takes new work is the "Start on" rule (`resolveStartOn`), not the tab.
 */
import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { captureError } from "../../../shared/sentry/capture";
import type { AccountProjectView } from "../../../shared/accountProject";
import type { RemoteOpenProjectBinding } from "../../../shared/types";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { useAppStore, type NoMachineRepositoryTab } from "../../state/appStore";
import {
  savedRepositoryCopyKey,
  type SavedRepositoryTab,
  type SavedRepositoryTabCopy,
  type SavedWindowRepositoryTabs,
} from "../../../shared/windowRepositoryTabs";
import { START_ON_LAST_MACHINE_STORAGE_KEY, useAccountProjectList } from "../../state/useRepositoryCopies";
import { readStoredProjectRoute, writeStoredProjectRoute } from "./projectRouteStorage";
import type { ProjectTabGroup } from "./projectTabGrouping";

export type RepositoryIdentity = {
  /** The repository's current origin for any of its addresses. */
  canonicalOrigin: (origin: string) => string;
  /** The repository tab id of an origin: the account project id, else `repo:<origin>`. */
  repositoryIdForOrigin: (origin: string) => string;
  /** The account project of a tab id, when the account knows it. */
  accountProjectFor: (tabId: string) => AccountProjectView | null;
};

function originOfRepoKey(repoKey: string): string {
  return repoKey.startsWith("repo:") ? repoKey.slice("repo:".length) : repoKey;
}

/** The repository identity of origins, from the account's project list. */
export function useRepositoryIdentity(): RepositoryIdentity {
  const list = useAccountProjectList();
  return useMemo(() => {
    const projectByOrigin = new Map<string, AccountProjectView>();
    const projectById = new Map<string, AccountProjectView>();
    if (list.state === "ready") {
      for (const project of list.projects) {
        projectById.set(project.id, project);
        for (const key of [project.repoKey, ...project.aliases]) {
          const origin = normalizeGitRemoteIdentity(originOfRepoKey(key)) ?? originOfRepoKey(key);
          projectByOrigin.set(origin, project);
        }
      }
    }
    return {
      canonicalOrigin: (origin) => {
        const project = projectByOrigin.get(origin);
        return project ? (normalizeGitRemoteIdentity(originOfRepoKey(project.repoKey)) ?? origin) : origin;
      },
      repositoryIdForOrigin: (origin) => projectByOrigin.get(origin)?.id ?? `repo:${origin}`,
      accountProjectFor: (tabId) => projectById.get(tabId) ?? null,
    };
  }, [list]);
}

/** The surface key ProjectTabHost uses for a tab machine's binding key. */
function surfaceKeyFor(bindingKey: string): string {
  return bindingKey.startsWith("remote:") || bindingKey.startsWith("local:") ? bindingKey : `local:${bindingKey}`;
}

/**
 * Before a tab moves to another copy of its repository: the copy it moves to
 * opens on the page the person is on, unless that copy has a page of its own.
 */
export function carryRouteToCopy(fromBindingKey: string | null, toBindingKey: string, groups: readonly ProjectTabGroup[]): void {
  if (!fromBindingKey || fromBindingKey === toBindingKey) return;
  const group = groups.find((entry) => entry.machines.some((machine) => machine.bindingKey === fromBindingKey));
  if (!group?.machines.some((machine) => machine.bindingKey === toBindingKey)) return;
  // One tab, one page: the copy the tab moves to shows the page the person
  // is on, also when that copy kept a page of its own from an earlier visit.
  const route = readStoredProjectRoute(surfaceKeyFor(fromBindingKey));
  if (route) writeStoredProjectRoute(surfaceKeyFor(toBindingKey), route);
}

/**
 * The tab order after some tabs give their place to another copy of the same
 * repository (`rename`: old binding key to new one). With no order of the
 * person's own, the strip puts local tabs before remote ones, so the order
 * the strip shows now is written down first: a local copy that gives its
 * place to a remote one (or the reverse) keeps the tab where it was.
 */
export function renameInTabOrder(
  prev: readonly string[],
  rename: ReadonlyMap<string, string>,
  shown: { groups: readonly ProjectTabGroup[]; openLocal: ReadonlySet<string>; openRemote: ReadonlySet<string> },
): string[] {
  const order = prev.length > 0
    ? prev
    : shown.groups.flatMap((group) => group.machines
      .filter((machine) => (machine.isLocal ? shown.openLocal : shown.openRemote).has(machine.bindingKey))
      .map((machine) => machine.bindingKey));
  if (!order.some((key) => rename.has(key))) return prev as string[];
  const next: string[] = [];
  for (const key of order) {
    const kept = rename.get(key) ?? key;
    if (!next.includes(kept)) next.push(kept);
  }
  return next;
}

/**
 * The strip of this window across a reload: the open remote tabs, the copy
 * each repository showed, and the tab order. The main process keeps only the
 * local tab roots and the binding in front; before S4 a repository's local
 * copy kept its own tab, so a reload never lost the repository. One tab per
 * repository closes that local copy, so the remote copy must come back too.
 * sessionStorage: one window, until the window closes. No icons (size).
 */
export const WINDOW_STRIP_STORAGE_KEY = "ade.projectTabs.windowStrip.v1";

export type WindowStripMemory = {
  remoteTabs: RemoteOpenProjectBinding[];
  preferredBindingKeyByGroup: Record<string, string>;
  tabOrder: string[];
};

function coerceRemoteTab(value: unknown): RemoteOpenProjectBinding | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === "string" && (row[key] as string).trim() ? (row[key] as string) : null);
  const key = text("key");
  const targetId = text("targetId");
  const projectId = text("projectId");
  const rootPath = text("rootPath");
  if (row.kind !== "remote" || !key || !targetId || !projectId || !rootPath) return null;
  return {
    kind: "remote",
    key,
    targetId,
    projectId,
    rootPath,
    runtimeName: text("runtimeName") ?? "",
    displayName: text("displayName") ?? rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath,
    ...(row.transport === "ssh" || row.transport === "paired" ? { transport: row.transport } : {}),
    ...(text("hostname") ? { hostname: text("hostname")! } : {}),
    gitOriginUrl: text("gitOriginUrl"),
    iconDataUrl: null,
  };
}

export function readWindowStripMemory(): WindowStripMemory | null {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(WINDOW_STRIP_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    const remoteTabs = Array.isArray(row.remoteTabs)
      ? row.remoteTabs.map(coerceRemoteTab).filter((entry): entry is RemoteOpenProjectBinding => entry !== null)
      : [];
    const preferred: Record<string, string> = {};
    if (row.preferredBindingKeyByGroup && typeof row.preferredBindingKeyByGroup === "object") {
      for (const [groupId, key] of Object.entries(row.preferredBindingKeyByGroup as Record<string, unknown>)) {
        if (typeof key === "string" && key) preferred[groupId] = key;
      }
    }
    const tabOrder = Array.isArray(row.tabOrder) ? row.tabOrder.filter((key): key is string => typeof key === "string") : [];
    return { remoteTabs, preferredBindingKeyByGroup: preferred, tabOrder };
  } catch {
    return null;
  }
}

/** Writes the strip once the window session is restored (an earlier write would replace it with the empty first paint). */
export function useWindowStripMemory(args: WindowStripMemory & { enabled: boolean }): void {
  const { enabled, remoteTabs, preferredBindingKeyByGroup, tabOrder } = args;
  useEffect(() => {
    if (!enabled) return;
    try {
      window.sessionStorage.setItem(WINDOW_STRIP_STORAGE_KEY, JSON.stringify({
        remoteTabs: remoteTabs.map((entry) => ({ ...entry, iconDataUrl: null })),
        preferredBindingKeyByGroup,
        tabOrder,
      }));
    } catch {
      // Storage full or unavailable: a reload then keeps what the main process keeps.
    }
  }, [enabled, preferredBindingKeyByGroup, remoteTabs, tabOrder]);
}

/**
 * The window's repository tabs as main saves them (S5): each open tab by its
 * repository id, with the copy it shows, then the tabs with no computer
 * online. Main reopens them on the next launch, also after an update.
 */
export function buildSavedWindowRepositoryTabs(args: {
  groups: readonly ProjectTabGroup[];
  openLocal: ReadonlySet<string>;
  openRemote: ReadonlySet<string>;
  noMachineTabs: readonly NoMachineRepositoryTab[];
  activeBindingKey: string | null;
  activeNoMachineTabId: string | null;
  /** True while Home, a new tab or a page with no project is in front. */
  noTabInFront: boolean;
  nameFor: (group: ProjectTabGroup) => string;
}): SavedWindowRepositoryTabs {
  const tabs: SavedRepositoryTab[] = [];
  const seen = new Set<string>();
  let activeId: string | null = null;
  for (const group of args.groups) {
    const open = group.machines.filter((machine) =>
      (machine.isLocal ? args.openLocal : args.openRemote).has(machine.bindingKey));
    if (open.length === 0 || seen.has(group.id)) continue;
    const shown = open.find((machine) => machine.bindingKey === args.activeBindingKey) ?? open[0]!;
    let copy: SavedRepositoryTabCopy | null = null;
    if (shown.isLocal) copy = { kind: "local", rootPath: shown.rootPath };
    else if (shown.binding?.kind === "remote") copy = { kind: "remote", binding: { ...shown.binding, iconDataUrl: null } };
    if (!copy) continue;
    seen.add(group.id);
    tabs.push({ id: group.id, displayName: args.nameFor(group), copy });
    if (!args.noTabInFront && shown.bindingKey === args.activeBindingKey) activeId = group.id;
  }
  for (const tab of args.noMachineTabs) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push({ id: tab.id, displayName: tab.displayName, copy: null });
  }
  if (args.activeNoMachineTabId && seen.has(args.activeNoMachineTabId)) activeId = args.activeNoMachineTabId;
  return { tabs, activeId };
}

/** Sends the window's repository tabs to main when they change (desktop only). */
export function useWindowRepositoryTabsSync(enabled: boolean, tabs: SavedWindowRepositoryTabs): void {
  const serialized = enabled ? JSON.stringify(tabs) : null;
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (serialized == null || serialized === lastSentRef.current) return;
    const send = window.ade?.app?.setWindowRepositoryTabs;
    if (typeof send !== "function") return;
    lastSentRef.current = serialized;
    void send(JSON.parse(serialized) as SavedWindowRepositoryTabs).catch(() => {
      lastSentRef.current = null;
    });
  }, [serialized]);
}

/** The renderer state that reopens a saved strip: open copies, no-machine tabs and the order. */
export function restoredStripFromSaved(saved: SavedWindowRepositoryTabs): {
  localRoots: string[];
  remoteBindings: RemoteOpenProjectBinding[];
  noMachineTabs: NoMachineRepositoryTab[];
  tabOrder: string[];
  active: SavedRepositoryTab | null;
} {
  const localRoots: string[] = [];
  const remoteBindings: RemoteOpenProjectBinding[] = [];
  const noMachineTabs: NoMachineRepositoryTab[] = [];
  const tabOrder: string[] = [];
  for (const tab of saved.tabs) {
    const key = savedRepositoryCopyKey(tab.copy);
    if (tab.copy?.kind === "local") localRoots.push(tab.copy.rootPath);
    else if (tab.copy?.kind === "remote") remoteBindings.push(tab.copy.binding);
    else noMachineTabs.push({ id: tab.id, displayName: tab.displayName, iconDataUrl: null });
    if (key) tabOrder.push(key);
  }
  return {
    localRoots,
    remoteBindings,
    noMachineTabs,
    tabOrder,
    active: saved.tabs.find((tab) => tab.id === saved.activeId) ?? null,
  };
}

/** Records the machine this client last used for a tab, for "Start on" (`ade.startOn.lastMachine.v1`). */
export function rememberLastUsedMachine(tabId: string, machineKey: string): void {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(START_ON_LAST_MACHINE_STORAGE_KEY) ?? "{}");
    const next: Record<string, string> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, string>) }
      : {};
    delete next[tabId];
    next[tabId] = machineKey;
    // Bounded: keep the 200 most recent tabs.
    const entries = Object.entries(next).slice(-200);
    window.localStorage.setItem(START_ON_LAST_MACHINE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage full or unavailable: "Start on" falls back to its default order.
  }
}

/**
 * One open copy per repository. A group with two open copies is the moment a
 * switch opened the second one (or a window an older version saved with two
 * tabs of one repository): the copy in front stays, the other closes, and the
 * tab keeps its place in the order. The closed copy keeps its view state and
 * route, so it opens where it was when the person picks it again.
 */
export function useOneCopyPerRepository(args: {
  enabled: boolean;
  tabGroups: readonly ProjectTabGroup[];
  activeBindingKey: string | null;
  openProjectTabRoots: readonly string[];
  openRemoteProjectTabs: readonly RemoteOpenProjectBinding[];
  setOpenProjectTabRoots: (update: (prev: string[]) => string[]) => void;
  setOpenRemoteProjectTabs: (update: (prev: RemoteOpenProjectBinding[]) => RemoteOpenProjectBinding[]) => void;
  setTabOrder: Dispatch<SetStateAction<string[]>>;
}): void {
  const {
    enabled,
    tabGroups,
    activeBindingKey,
    openProjectTabRoots,
    openRemoteProjectTabs,
    setOpenProjectTabRoots,
    setOpenRemoteProjectTabs,
    setTabOrder,
  } = args;
  useEffect(() => {
    if (!enabled) return;
    const openLocal = new Set(openProjectTabRoots);
    const openRemote = new Set(openRemoteProjectTabs.map((entry) => entry.key));
    const closeLocal = new Set<string>();
    const closeRemote = new Set<string>();
    const rename = new Map<string, string>();
    for (const group of tabGroups) {
      const open = group.machines.filter((machine) =>
        machine.isLocal ? openLocal.has(machine.bindingKey) : openRemote.has(machine.bindingKey));
      if (open.length < 2) continue;
      const keep = open.find((machine) => machine.bindingKey === activeBindingKey)
        ?? open.find((machine) => machine.bindingKey === group.activeBindingKey)
        ?? open[0]!;
      for (const machine of open) {
        if (machine === keep) continue;
        if (machine.isLocal) closeLocal.add(machine.bindingKey);
        else closeRemote.add(machine.bindingKey);
        rename.set(machine.bindingKey, keep.bindingKey);
      }
    }
    if (rename.size === 0) return;
    if (closeLocal.size > 0) setOpenProjectTabRoots((prev) => prev.filter((root) => !closeLocal.has(root)));
    if (closeRemote.size > 0) setOpenRemoteProjectTabs((prev) => prev.filter((entry) => !closeRemote.has(entry.key)));
    setTabOrder((prev) => renameInTabOrder(prev, rename, { groups: tabGroups, openLocal, openRemote }));
    // Only the data caches go: a copy that closes here can open again.
    const store = useAppStore.getState();
    for (const key of [...closeLocal, ...closeRemote]) store.evictProjectDataCaches(key);
  }, [
    activeBindingKey,
    enabled,
    openProjectTabRoots,
    openRemoteProjectTabs,
    setOpenProjectTabRoots,
    setOpenRemoteProjectTabs,
    setTabOrder,
    tabGroups,
  ]);
}

/** Drops a no-machine tab once a copy of its repository is open in this window. */
export function useNoMachineTabCleanup(tabGroups: readonly ProjectTabGroup[]): void {
  const noMachineTabs = useAppStore((state) => state.noMachineTabs);
  useEffect(() => {
    if (noMachineTabs.length === 0) return;
    const openIds = new Set(tabGroups.map((group) => group.id));
    for (const tab of noMachineTabs) {
      if (openIds.has(tab.id)) useAppStore.getState().closeNoMachineTab(tab.id);
    }
  }, [noMachineTabs, tabGroups]);
}

/**
 * The tab in front of a saved strip could not open again (its folder is gone,
 * its computer refused). The strip stays as it is; Sentry hears about it.
 */
export function reportStripRestoreFailure(error: unknown): void {
  captureError(error, { fingerprint: ["repository-tabs", "strip-restore-open"], level: "warning", handled: true });
}

/**
 * The strip's rules, in one place for the top bar: one open copy per
 * repository, no-machine tabs that leave once a copy opens, this window's
 * memory across a reload, and the strip main saves for the next launch (S5).
 */
export function useRepositoryTabStrip(args: {
  windowSessionRestored: boolean;
  projectBusy: boolean;
  webMode: boolean;
  tabGroups: readonly ProjectTabGroup[];
  activeBindingKey: string | null;
  openProjectTabRoots: readonly string[];
  openRemoteProjectTabs: RemoteOpenProjectBinding[];
  setOpenProjectTabRoots: (update: (prev: string[]) => string[]) => void;
  setOpenRemoteProjectTabs: (update: (prev: RemoteOpenProjectBinding[]) => RemoteOpenProjectBinding[]) => void;
  setTabOrder: Dispatch<SetStateAction<string[]>>;
  preferredBindingKeyByGroup: Record<string, string>;
  tabOrder: string[];
  noMachineTabs: readonly NoMachineRepositoryTab[];
  activeNoMachineTabId: string | null;
  noTabInFront: boolean;
  recordNameFor: (group: ProjectTabGroup) => string | null | undefined;
}): void {
  const {
    windowSessionRestored,
    projectBusy,
    webMode,
    tabGroups,
    activeBindingKey,
    openProjectTabRoots,
    openRemoteProjectTabs,
    preferredBindingKeyByGroup,
    tabOrder,
    noMachineTabs,
    activeNoMachineTabId,
    noTabInFront,
    recordNameFor,
  } = args;
  // A repository has one tab and one open copy. No rule moves the tab to this
  // computer's copy: "Start on" picks the machine for new work.
  useOneCopyPerRepository({
    enabled: windowSessionRestored && !projectBusy,
    tabGroups,
    activeBindingKey,
    openProjectTabRoots,
    openRemoteProjectTabs,
    setOpenProjectTabRoots: args.setOpenProjectTabRoots,
    setOpenRemoteProjectTabs: args.setOpenRemoteProjectTabs,
    setTabOrder: args.setTabOrder,
  });
  useNoMachineTabCleanup(tabGroups);
  useWindowStripMemory({
    enabled: windowSessionRestored,
    remoteTabs: openRemoteProjectTabs,
    preferredBindingKeyByGroup,
    tabOrder,
  });
  // Main saves the strip by repository and reopens it on the next launch (S5).
  const savedRepositoryTabs = useMemo(
    () => buildSavedWindowRepositoryTabs({
      groups: tabGroups,
      openLocal: new Set(openProjectTabRoots),
      openRemote: new Set(openRemoteProjectTabs.map((entry) => entry.key)),
      noMachineTabs,
      activeBindingKey,
      activeNoMachineTabId,
      noTabInFront,
      nameFor: (group) => recordNameFor(group) ?? group.displayName,
    }),
    [activeBindingKey, activeNoMachineTabId, noMachineTabs, noTabInFront, openProjectTabRoots, openRemoteProjectTabs, recordNameFor, tabGroups],
  );
  useWindowRepositoryTabsSync(windowSessionRestored && !webMode, savedRepositoryTabs);
}
