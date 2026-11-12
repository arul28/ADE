import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountProjectView } from "../../../shared/accountProject";
import type { RecentProjectSummary, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useAccountProjectList } from "../../state/useRepositoryCopies";
import {
  accountProjectGroups,
  foreignCopyPaths,
  groupRecentProjects,
  type RecentProjectGroup,
} from "../app/projectTabGrouping";
import { cachedGitRemoteIdentity } from "../lanes/laneMachines";

/** This computer's account machine key: read once per app session, so Home does not render twice on each open. */
let thisMachineKeyCache: string | null | undefined;
function useThisMachineKey(enabled: boolean): string | null {
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

/**
 * Home's project rows with the account's projects (S4): every project of the
 * account shows, also one added or cloned on another machine, and a row of
 * another machine's copy opens that machine's copy (F6). `openNoMachineTab`
 * opens a row's repository as a tab with no machine (0M); it returns false
 * when the row has no repository address.
 */
export function useHomeAccountProjects(args: {
  webMode: boolean;
  recentProjects: readonly RecentProjectSummary[];
  webRecents: readonly RecentProjectSummary[];
  /** On the web: each recent row's machine key to its account machine key. */
  webAccountMachineKeys: ReadonlyMap<string, string>;
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null;
  pendingForgetKeys: ReadonlySet<string>;
}): {
  visibleProjectGroups: RecentProjectGroup[];
  openNoMachineTab: (rp: RecentProjectSummary) => boolean;
  /** How many live projects the account has; 0 until the list is read. */
  accountProjectCount: number;
} {
  const { webMode, recentProjects, webRecents, webAccountMachineKeys, remoteSnapshot, pendingForgetKeys } = args;
  const accountList = useAccountProjectList();
  const accountProjects = accountList.state === "ready" ? accountList.projects : null;
  // Only the F6 rule needs it, and only with the account's list.
  const thisMachineKey = useThisMachineKey(!webMode && accountProjects != null);
  const visibleProjectGroups = useMemo(() => {
    const foreign = webMode ? new Set<string>() : foreignCopyPaths({ projects: accountProjects, thisMachineKey });
    const kept = (webMode ? webRecents : recentProjects).filter((rp) => {
      if (rp.kind === "remote") return true;
      if (foreign.has(rp.rootPath)) return false;
      return rp.exists && !rp.rootPath.includes("ade-project");
    });
    const groups = groupRecentProjects({
      recentProjects: kept,
      remoteSnapshot: webMode ? null : remoteSnapshot,
    });
    // On the web too (S14): the account's projects come from the account
    // directory there, so a project on a computer this browser never
    // connected to, or on no computer, still has a row.
    const withAccount = accountProjects
      ? accountProjectGroups({
          projects: accountProjects,
          shownGroups: groups,
          remoteSnapshot: webMode ? null : remoteSnapshot,
          thisMachineKey: webMode ? null : thisMachineKey,
          machineNames: accountList.machineNames,
          accountMachineKeys: webMode ? webAccountMachineKeys : undefined,
        })
      : groups;
    return withAccount.filter((group) => !pendingForgetKeys.has(group.id));
  }, [accountList.machineNames, accountProjects, pendingForgetKeys, recentProjects, remoteSnapshot, thisMachineKey, webAccountMachineKeys, webMode, webRecents]);

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
      iconDataUrl: rp.remote?.iconDataUrl ?? null,
    });
    return true;
  }, [accountProjects, showNoMachineTab]);

  return { visibleProjectGroups, openNoMachineTab, accountProjectCount: accountProjects?.length ?? 0 };
}
