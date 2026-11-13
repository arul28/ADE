import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountProjectView } from "../../../shared/accountProject";
import type { RecentProjectSummary, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useAccountProjectList, useRepositoryCopySources } from "../../state/useRepositoryCopies";
import { foreignCopyPaths } from "../app/projectTabGrouping";
import { cachedGitRemoteIdentity } from "../lanes/laneMachines";
import { buildHomeProjectList, type HomeProjectList, type HomeWebComputer } from "./homeProjectRows";
import { useHomeHiddenProjects } from "./homeHiddenProjects";

/** This computer's account machine key: read once per app session, so Home does not render twice on each open. */
let thisMachineKeyCache: string | null | undefined;
export function useThisMachineKey(enabled: boolean): string | null {
  const [machineKey, setMachineKey] = useState<string | null>(() => thisMachineKeyCache ?? null);
  useEffect(() => {
    if (!enabled || thisMachineKeyCache !== undefined) return undefined;
    let cancelled = false;
    void Promise.resolve(window.ade?.account?.getLocalMachineIdentity?.())
      .then((identity) => {
        thisMachineKeyCache = identity?.machineKey?.trim() || null;
        if (!cancelled) setMachineKey(thisMachineKeyCache);
      })
      // Not read: the next Home mount asks again. Until then no row counts as another machine's.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return machineKey;
}

/** The account project of a recent row's origin, by any of the project's addresses. */
function accountProjectForOrigin(projects: readonly AccountProjectView[], gitOriginUrl: string | null | undefined): AccountProjectView | null {
  const origin = cachedGitRemoteIdentity(gitOriginUrl ?? null);
  if (!origin) return null;
  return projects.find((project) => [project.repoKey, ...project.aliases].some((key) =>
    cachedGitRemoteIdentity(key.startsWith("repo:") ? key.slice("repo:".length) : key) === origin)) ?? null;
}

/** This computer's catalog as Home last read it: shown at once on the next open, then read again. */
let thisComputerFoldersCache: readonly RecentProjectSummary[] = [];

/**
 * This computer's folders as its brain registers them. The desktop's recents
 * stop at 24; the catalog has every folder. Read when Home opens and each time
 * the recents change (an open or a forget changes both). Desktop only.
 */
function useThisComputerFolders(enabled: boolean, recentsVersion: unknown): readonly RecentProjectSummary[] {
  const [folders, setFolders] = useState<readonly RecentProjectSummary[]>(() => thisComputerFoldersCache);
  useEffect(() => {
    const read = window.ade?.project?.listThisComputer;
    if (!enabled || typeof read !== "function") return undefined;
    let cancelled = false;
    void read().then((next) => {
      thisComputerFoldersCache = next;
      if (!cancelled) setFolders(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, recentsVersion]);
  return enabled ? folders : NO_FOLDERS;
}
const NO_FOLDERS: readonly RecentProjectSummary[] = [];

/** The recents, then each catalog folder the recents do not have (the recents keep order and pins). */
function withCatalogFolders(
  recents: readonly RecentProjectSummary[],
  folders: readonly RecentProjectSummary[],
): readonly RecentProjectSummary[] {
  if (folders.length === 0) return recents;
  const listed = new Set(recents.filter((recent) => recent.kind !== "remote").map((recent) => recent.rootPath));
  const extra = folders.filter((folder) => !listed.has(folder.rootPath));
  return extra.length > 0 ? [...recents, ...extra] : recents;
}

/**
 * Icons seen this session, by account project id: a row keeps its icon after
 * its computer goes offline or the browser disconnects it. Memory only.
 */
const rememberedIcons = new Map<string, string>();

/**
 * Home's project list (one source, see `homeProjectRows`): one row per
 * account project, the same projects and count on every client, with or
 * without a machine connection; this computer's other folders in groups
 * below. `openNoMachineTab` opens a row's repository as a tab with no machine
 * (0M); it returns false when the row has no repository address.
 */
export function useHomeAccountProjects(args: {
  webMode: boolean;
  recentProjects: readonly RecentProjectSummary[];
  webRecents: readonly RecentProjectSummary[];
  /** Web: computers by account machine key, and by web machine row key. */
  webComputers: ReadonlyMap<string, HomeWebComputer>;
  webComputersByKey: ReadonlyMap<string, HomeWebComputer>;
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null;
  pendingForgetKeys: ReadonlySet<string>;
}): {
  list: HomeProjectList;
  openNoMachineTab: (rp: RecentProjectSummary) => boolean;
} {
  const { webMode, recentProjects, webRecents, webComputers, webComputersByKey, remoteSnapshot, pendingForgetKeys } = args;
  const accountList = useAccountProjectList();
  const accountProjects = accountList.state === "ready" ? accountList.projects : null;
  // This computer's key: the F6 rule and the copies (which copy is this computer's).
  const thisMachineKey = useThisMachineKey(!webMode && accountProjects != null);
  // The same sources as the copies menu and Settings › Location, so the
  // computer count agrees on all three. Home already holds the recents and
  // the connections on the desktop, so nothing is read a second time; ADE
  // Web reads its in-browser connections (no IPC there).
  const sources = useRepositoryCopySources(true, webMode ? null : {
    snapshot: remoteSnapshot,
    recents: recentProjects,
    machineKey: thisMachineKey,
  });
  const hidden = useHomeHiddenProjects();
  const catalogFolders = useThisComputerFolders(!webMode, recentProjects);
  const desktopFolders = useMemo(() => withCatalogFolders(recentProjects, catalogFolders), [catalogFolders, recentProjects]);
  const thisMachineName = (thisMachineKey ? accountList.machineNames?.[thisMachineKey]?.trim() : null) || "this computer";

  const list = useMemo(() => {
    const built = buildHomeProjectList({
      projects: accountProjects,
      sources,
      recents: webMode ? webRecents : desktopFolders,
      remoteSnapshot: webMode ? null : remoteSnapshot,
      webMode,
      webComputers,
      webComputersByKey,
      hidden,
      foreignPaths: webMode ? new Set() : foreignCopyPaths({ projects: accountProjects, thisMachineKey }),
      thisMachineName,
      rememberedIcons,
    });
    for (const row of built.accountRows) {
      if (row.iconDataUrl) rememberedIcons.set(row.key, row.iconDataUrl);
    }
    if (pendingForgetKeys.size === 0) return built;
    return {
      ...built,
      localGroups: built.localGroups
        .map((group) => ({ ...group, rows: group.rows.filter((row) => !pendingForgetKeys.has(row.group.id)) }))
        .filter((group) => group.rows.length > 0),
    };
  }, [accountProjects, desktopFolders, hidden, pendingForgetKeys, remoteSnapshot, sources, thisMachineKey, thisMachineName, webComputers, webComputersByKey, webMode, webRecents]);

  // A project with no computer online opens as its repository tab, with no
  // machine (0M): the tab waits for a computer instead of failing.
  const showNoMachineTab = useAppStore((s) => s.showNoMachineTab);
  const openNoMachineTab = useCallback((rp: RecentProjectSummary): boolean => {
    const origin = cachedGitRemoteIdentity(rp.gitOriginUrl ?? rp.remote?.gitOriginUrl ?? null);
    if (!origin) return false;
    const project = accountProjects ? accountProjectForOrigin(accountProjects, rp.gitOriginUrl ?? rp.remote?.gitOriginUrl) : null;
    showNoMachineTab({
      id: project?.id ?? `repo:${origin}`,
      displayName: project?.name ?? rp.displayName,
      iconDataUrl: rp.remote?.iconDataUrl ?? (project ? rememberedIcons.get(project.id) ?? null : null),
    });
    return true;
  }, [accountProjects, showNoMachineTab]);

  return { list, openNoMachineTab };
}
