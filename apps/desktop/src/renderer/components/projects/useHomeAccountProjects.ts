import { useCallback, useEffect, useMemo, useState } from "react";
import { captureError } from "../../../shared/sentry/capture";
import type { AccountProjectView } from "../../../shared/accountProject";
import type { RecentProjectSummary, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useAccountProjectList, useRepositoryCopySources, useThisMachineKey } from "../../state/useRepositoryCopies";
import { normalizePathForComparison } from "../../lib/pathUtils";
import { foreignCopyPaths } from "../app/projectTabGrouping";
import { cachedGitRemoteIdentity } from "../lanes/laneMachines";
import { buildHomeProjectList, type HomeProjectList, type HomeWebComputer } from "./homeProjectRows";
import { useHomeHiddenProjects } from "./homeHiddenProjects";

/** The account project of a recent row's origin, by any of the project's addresses. */
function accountProjectForOrigin(projects: readonly AccountProjectView[], gitOriginUrl: string | null | undefined): AccountProjectView | null {
  const origin = cachedGitRemoteIdentity(gitOriginUrl ?? null);
  if (!origin) return null;
  return projects.find((project) => [project.repoKey, ...project.aliases].some((key) =>
    cachedGitRemoteIdentity(key.startsWith("repo:") ? key.slice("repo:".length) : key) === origin)) ?? null;
}

/** This computer's catalog as Home last read it: shown at once on the next open, then read again. */
let thisComputerFoldersCache: readonly RecentProjectSummary[] = [];
/** The local brain as this window last heard of it ("connected:<pid>" or its state); null before the first report. */
let brainIdentity: string | null = null;
/** The brain identity the last catalog read went to. */
let catalogReadIdentity: string | null = null;

/**
 * Counts the times a connected local brain answers that the last catalog read
 * did not reach: Home opened before the brain connected (the read answered
 * nothing), or the brain restarted. The status report also comes as a
 * heartbeat; a heartbeat of the same brain changes nothing.
 */
function useBrainConnects(desktop: boolean): number {
  const [connects, setConnects] = useState(0);
  useEffect(() => {
    const subscribe = window.ade?.app?.onRuntimeStatusChanged;
    if (!desktop || typeof subscribe !== "function") return undefined;
    return subscribe((status) => {
      brainIdentity = status.connectionState === "connected" ? `connected:${status.pid ?? ""}` : status.connectionState;
      if (status.connectionState === "connected" && catalogReadIdentity !== brainIdentity) setConnects((count) => count + 1);
    });
  }, [desktop]);
  return connects;
}

/** The same folders in the same order: a read that changes nothing keeps the list Home already shows. */
function sameFolders(a: readonly RecentProjectSummary[], b: readonly RecentProjectSummary[]): boolean {
  return a.length === b.length && a.every((folder, index) => {
    const other = b[index]!;
    return folder.rootPath === other.rootPath
      && folder.displayName === other.displayName
      && folder.lastOpenedAt === other.lastOpenedAt
      && (folder.gitOriginUrl ?? null) === (other.gitOriginUrl ?? null);
  });
}

/**
 * This computer's folders as its brain registers them. The desktop's recents
 * stop at 24; the catalog has every folder. Read when Home opens and each time
 * the recents change (an open or a forget changes both), and when a brain the
 * last read missed connects. The read waits for Home's first recents read
 * (`ready`), so one open reads the catalog once; the last catalog shows until
 * then. Desktop only.
 */
function useThisComputerFolders(desktop: boolean, ready: boolean, recentsVersion: unknown): readonly RecentProjectSummary[] {
  const [folders, setFolders] = useState<readonly RecentProjectSummary[]>(() => thisComputerFoldersCache);
  const brainConnects = useBrainConnects(desktop);
  useEffect(() => {
    const read = window.ade?.project?.listThisComputer;
    if (!desktop || !ready || typeof read !== "function") return undefined;
    let cancelled = false;
    catalogReadIdentity = brainIdentity;
    void read().then((next) => {
      thisComputerFoldersCache = next;
      if (!cancelled) setFolders((current) => (sameFolders(current, next) ? current : next));
    }, (error: unknown) => {
      // Home keeps the last catalog it read (or the recents alone); the next open reads again.
      captureError(error, { fingerprint: ["home-projects", "this-computer-folders-read"], level: "warning", handled: true });
    });
    return () => {
      cancelled = true;
    };
  }, [brainConnects, desktop, ready, recentsVersion]);
  return desktop ? folders : NO_FOLDERS;
}
const NO_FOLDERS: readonly RecentProjectSummary[] = [];

/** The recents, then each catalog folder the recents do not have (the recents keep order and pins). */
function withCatalogFolders(
  recents: readonly RecentProjectSummary[],
  folders: readonly RecentProjectSummary[],
): readonly RecentProjectSummary[] {
  if (folders.length === 0) return recents;
  // Windows and macOS paths differ in case between two writers; compare by the shared key.
  const listed = new Set(recents.filter((recent) => recent.kind !== "remote").map((recent) => normalizePathForComparison(recent.rootPath)));
  const extra = folders.filter((folder) => !listed.has(normalizePathForComparison(folder.rootPath)));
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
  /** Home has read the desktop's recents once (or failed to): the catalog read waits for it. */
  recentsLoaded: boolean;
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
  const { webMode, recentProjects, recentsLoaded, webRecents, webComputers, webComputersByKey, remoteSnapshot, pendingForgetKeys } = args;
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
  const catalogFolders = useThisComputerFolders(!webMode, recentsLoaded, recentProjects);
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
