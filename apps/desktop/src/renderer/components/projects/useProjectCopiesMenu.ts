import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FixedAnchor } from "../../hooks/useClampedFixedPosition";
import type { RecentProjectSummary, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { projectRecordScope } from "../../../shared/projectRecord";
import { ACCOUNT_PROJECT_ID_PATTERN } from "../../../shared/accountProject";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { activeMachineForGroup, type ProjectTabGroup } from "../app/projectTabGrouping";
import type { CloneLocallyTarget } from "./CloneLocallyDialog";
import type { CopiesMenuRow } from "./ProjectCopiesMenu";
import type { RemovalCopy, RemoveProjectTarget } from "./RemoveProjectDialog";
import { copyMachines, existingCopiesForRepo, repoKeyForOriginIdentity, repoKeyForUrl, type CopyMachine } from "./projectCopies";
import { startCopyJob } from "./projectCopyJobs";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";
import { buildRepositoryCopies, copyComputers, repositoryTabFromAccountProject, type RepositoryCopy } from "../../../shared/repositoryTab";
import { useAccountProjectList, useRepositoryCopySources, useThisMachineKey } from "../../state/useRepositoryCopies";
import { REQUEST_COPIES_MENU_EVENT, type CopiesMenuRequest } from "./removeProjectRequest";

/** ADE Web has no recents of its own. */
const NO_RECENT_PROJECTS: readonly RecentProjectSummary[] = [];

/**
 * Lays the tab's shared copies (`useRepositoryCopies`, the source of the
 * "on N computers" count) over the menu's machine rows, so the rows and the
 * count name the same computers:
 *
 * - A machine row with no copy gets the shared copy of that machine.
 * - A computer with a copy but no saved connection (another account
 *   computer) gets an offline row; nothing can open it from here.
 * - An offline machine's copy that only an old recent remembers, and the
 *   account does not list, loses its folder: it is not counted either.
 */
export function rowsWithSharedCopies(
  rowsIn: readonly CopiesMenuRow[],
  copies: readonly RepositoryCopy[] | null,
  adeCloudTargetIds: ReadonlySet<string>,
): CopiesMenuRow[] {
  // An ADE Cloud lane computer is never a copy to list or a place to clone to.
  const rows = rowsIn.filter((row) => !row.machine.targetId || !adeCloudTargetIds.has(row.machine.targetId));
  if (!copies) return rows;
  const shared = copies.filter((copy) => !copy.isAdeCloud);
  const sharedFor = (machine: CopyMachine): RepositoryCopy | undefined =>
    shared.find((copy) => machine.isLocal
      ? copy.machineId === THIS_MACHINE_ID
      : copy.machineId === machine.machineId
        || (copy.address?.kind === "remote" && copy.address.targetId === machine.targetId));
  const bindingKeyOf = (copy: RepositoryCopy): string =>
    copy.address?.key ?? (copy.machineId === THIS_MACHINE_ID ? copy.rootPath : `${copy.machineId}:${copy.rootPath}`);
  const next = rows.map((row): CopiesMenuRow => {
    const match = sharedFor(row.machine);
    if (!row.copy) {
      if (!match) return row;
      const binding = match.address?.kind === "remote" ? match.address : null;
      return { ...row, copy: { rootPath: match.rootPath, bindingKey: bindingKeyOf(match), binding } };
    }
    if (!row.inUse && !row.machine.online && !match) return { ...row, copy: null };
    return row;
  });
  const covered = new Set<string>();
  for (const row of next) {
    const match = sharedFor(row.machine);
    if (match) covered.add(match.machineKey?.trim() || match.machineId);
  }
  for (const copy of shared) {
    const key = copy.machineKey?.trim() || copy.machineId;
    if (covered.has(key)) continue;
    covered.add(key);
    next.push({
      machine: { machineId: copy.machineId, name: copy.machineName, targetId: null, isLocal: false, online: false },
      copy: { rootPath: copy.rootPath, bindingKey: bindingKeyOf(copy) },
      inUse: false,
    });
  }
  return next;
}

/**
 * The "Computers with a copy" list of a project and the remove dialog it
 * opens: one row per machine with that machine's copy of the repository and
 * its state, and the clone of a new copy. It never moves the tab: a tab shows
 * the work of every computer with a copy, so there is nothing to switch to.
 * The top bar owns the tabs; this hook owns the list, the dialog target and
 * the models they show.
 */
export function useProjectCopiesMenu(args: {
  tabGroups: readonly ProjectTabGroup[];
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null;
  webMode: boolean;
  recordNameFor: (group: ProjectTabGroup) => string | null;
  workspaceProjectOpen: boolean;
  projectRootPath: string | null;
  hasOrigin: boolean | null | undefined;
  recentProjects: RecentProjectSummary[];
  /** The binding key of the tab in front: the computers tag opens its copies. */
  activeTabBindingKey: string | null;
  handleClonedLocally: (rootPath: string, remoteKey: string) => Promise<unknown> | unknown;
}) {
  const {
    tabGroups,
    remoteSnapshot,
    webMode,
    recordNameFor,
    workspaceProjectOpen,
    projectRootPath,
    hasOrigin,
    recentProjects,
    activeTabBindingKey,
    handleClonedLocally,
  } = args;
  // The copies menu of one project: under the computers tag or a Home row's
  // chip, or where the tab's context menu was opened.
  const [copiesMenu, setCopiesMenu] = useState<(FixedAnchor & { groupId: string }) | null>(null);
  const closeCopiesMenu = useCallback(() => setCopiesMenu(null), []);

  /**
   * Starts a copy of a tab's repository on one machine. The clone goes to
   * that machine (this computer, or `machine.targetId`), and its retry goes
   * there too (see projectCopyJobs). An https URL works on every machine; an
   * ssh alias exists only in one machine's ssh config.
   */
  const startCopyForRepo = useCallback(
    (repoKey: string, displayName: string, machine: CopyMachine, onReady?: Parameters<typeof startCopyJob>[1]) => {
      const name = repoKey.split("/").pop() ?? displayName;
      startCopyJob(
        {
          repoKey,
          url: `https://${repoKey}`,
          name,
          parentDir: null,
          displayName: name,
          machine: { machineId: machine.machineId, name: machine.name, targetId: machine.targetId },
        },
        onReady,
      );
    },
    [],
  );

  /** "Add a copy on this computer…" from a tab's context menu: the old clone-locally path. */
  const addLocalCopyFromTab = useCallback(
    (target: CloneLocallyTarget, anchor: FixedAnchor, groupId: string) => {
      const repoKey = repoKeyForUrl(target.gitOriginUrl);
      const local = copyMachines(null, { includeLocal: true })[0];
      if (!repoKey || !local) return;
      startCopyForRepo(repoKey, target.displayName, local, (result) => {
        if (result.kind === "local") void handleClonedLocally(result.rootPath, target.remoteKey);
      });
      // The menu shows the clone's progress and its failure, with Retry.
      setCopiesMenu({ ...anchor, groupId });
    },
    [handleClonedLocally, startCopyForRepo],
  );

  /** The copies of one tab's repository, one row per machine: what the copies menu and the remove dialog show. */
  const copiesModelFor = useCallback((groupId: string) => {
    const group = tabGroups.find((entry) => entry.id === groupId);
    const active = group ? activeMachineForGroup(group) : null;
    if (!group || !active) return null;
    const repoKey = repoKeyForOriginIdentity(group.origin);
    const machines = copyMachines(remoteSnapshot, { includeLocal: !webMode });
    const machineFor = (machineId: string, fallbackName: string): CopyMachine =>
      machines.find((entry) => entry.machineId === machineId)
      ?? { machineId, name: fallbackName, targetId: machineId, isLocal: false, online: false };
    const projectName = recordNameFor(group) ?? active.displayName;
    if (!repoKey) {
      // No origin: nothing joins this folder to a copy elsewhere, so the menu
      // names the one machine it is on and offers Publish.
      const machine = active.isLocal
        ? (machines.find((entry) => entry.isLocal) ?? machineFor(active.machineId, active.machineName))
        : machineFor(active.machineId, active.machineName);
      const canPublish =
        active.isLocal
        && workspaceProjectOpen
        && projectRootPath === active.rootPath
        && hasOrigin === false;
      return {
        group,
        projectName,
        repoKey: null,
        rows: [{ machine, copy: { rootPath: active.rootPath, bindingKey: active.bindingKey }, inUse: true }],
        onlyOneMachine: active.isLocal ? "This machine only" : `Only on ${active.machineName}`,
        canPublish,
      };
    }
    const existing = existingCopiesForRepo(repoKey, { recents: recentProjects, snapshot: remoteSnapshot });
    const rows: CopiesMenuRow[] = machines.map((machine) => {
      // The tab's own checkout of each machine wins: two checkouts on this
      // computer are two tabs, and each menu shows its own folder.
      const own = group.machines.find((entry) => entry.machineId === machine.machineId);
      const known = existing.get(machine.machineId);
      const copy = own
        ? { rootPath: own.rootPath, bindingKey: own.bindingKey }
        : known
          ? {
              rootPath: known.rootPath,
              bindingKey: known.projectId && machine.targetId
                ? remoteProjectBindingKey(machine.targetId, known.projectId)
                : known.rootPath,
            }
          : null;
      return { machine, copy, inUse: copy?.bindingKey === active.bindingKey };
    });
    if (!rows.some((row) => row.inUse)) {
      // The machine in use is no longer saved; still show where the tab is.
      rows.unshift({
        machine: machineFor(active.machineId, active.machineName),
        copy: { rootPath: active.rootPath, bindingKey: active.bindingKey },
        inUse: true,
      });
    }
    return { group, projectName, repoKey, rows, onlyOneMachine: null, canPublish: false };
  }, [
    hasOrigin,
    projectRootPath,
    recentProjects,
    recordNameFor,
    remoteSnapshot,
    tabGroups,
    webMode,
    workspaceProjectOpen,
  ]);
  const copiesMenuModel = useMemo(
    () => (copiesMenu ? copiesModelFor(copiesMenu.groupId) : null),
    [copiesMenu, copiesModelFor],
  );

  // The remove dialog of one tab ("Remove project…" in its copies menu and
  // its right-click menu). The hosted web client has no remove: it cannot
  // reach a machine's folders.
  const [removeTarget, setRemoveTarget] = useState<
    (RemoveProjectTarget & { groupId: string; recordScope: string | null }) | null
  >(null);
  const closeRemoveDialog = useCallback(() => setRemoveTarget(null), []);
  /**
   * Opens the remove dialog of one tab. `currentBindingKey` names the copy
   * "From this computer" acts on (the Location page's row); else the copy in use.
   */
  const openRemoveDialog = useCallback((groupId: string, options?: { currentBindingKey?: string; extraCopy?: RemovalCopy }) => {
    const model = copiesModelFor(groupId);
    if (!model) return;
    const toCopy = (row: CopiesMenuRow): RemovalCopy | null => {
      if (!row.copy) return null;
      const prefix = row.machine.targetId ? `remote:${row.machine.targetId}:` : null;
      return {
        machine: row.machine,
        rootPath: row.copy.rootPath,
        bindingKey: row.copy.bindingKey,
        projectId: prefix && row.copy.bindingKey.startsWith(prefix) ? row.copy.bindingKey.slice(prefix.length) : null,
      };
    };
    const copies = model.rows.map(toCopy).filter((copy): copy is RemovalCopy => copy !== null);
    const extra = options?.extraCopy;
    if (extra && !copies.some((copy) => copy.bindingKey === extra.bindingKey)) copies.push(extra);
    const inUseKey = options?.currentBindingKey ?? model.rows.find((row) => row.inUse)?.copy?.bindingKey ?? null;
    const current = inUseKey ? copies.find((copy) => copy.bindingKey === inUseKey) : copies[0];
    // A named copy the model does not know is never swapped for another one.
    if (!current) return;
    setRemoveTarget({
      groupId,
      recordScope: model.repoKey ? projectRecordScope(model.group.origin ?? null) : null,
      projectName: model.projectName,
      repoKey: model.repoKey,
      current,
      copies,
      accountProjectId: ACCOUNT_PROJECT_ID_PATTERN.test(groupId) ? groupId : null,
    });
  }, [copiesModelFor]);

  /** The remove dialog of a tab with no computer online: it can only leave the account. */
  const openRemoveNoMachineDialog = useCallback((tab: { id: string; displayName: string }) => {
    if (!ACCOUNT_PROJECT_ID_PATTERN.test(tab.id)) return;
    setRemoveTarget({
      groupId: tab.id,
      recordScope: null,
      projectName: tab.displayName,
      repoKey: null,
      current: null,
      copies: [],
      accountProjectId: tab.id,
    });
  }, []);

  /** The remove dialog with a target the caller built (Home's row, from the account list). */
  const openRemoveDialogWithTarget = useCallback(
    (target: RemoveProjectTarget & { groupId: string; recordScope: string | null }) => setRemoveTarget(target),
    [],
  );

  // The list says how many computers have a copy, by the shared rule
  // (`copyComputers`), and lists the same ones. The
  // sources are the snapshot and recents the top bar already holds (the
  // sources add this computer's catalog): no new read.
  const accountProjectList = useAccountProjectList();
  const thisMachineKey = useThisMachineKey(!webMode && accountProjectList.state === "ready");
  const copySources = useRepositoryCopySources(true, {
    snapshot: remoteSnapshot,
    recents: webMode ? NO_RECENT_PROJECTS : recentProjects,
    machineKey: thisMachineKey,
  });
  // ADE Cloud lane computers take no new work: no "Add a copy" there.
  const adeCloudTargetIds = useMemo(() => new Set(
    (remoteSnapshot?.connections ?? [])
      .filter((connection) => copySources.isAdeCloudMachine?.({
        hostname: connection.target.hostname ?? null,
        machineKey: connection.target.pairedMachine?.machineKey ?? null,
      }))
      .map((connection) => connection.target.id),
  ), [copySources, remoteSnapshot]);
  const sharedCopiesFor = useCallback((groupId: string): RepositoryCopy[] | null => {
    if (accountProjectList.state !== "ready") return null;
    const accountProject = accountProjectList.projects.find((entry) => entry.id === groupId);
    if (!accountProject) return null;
    return buildRepositoryCopies(repositoryTabFromAccountProject(accountProject), {
      ...copySources,
      accountCopies: accountProject.copies,
    });
  }, [accountProjectList, copySources]);
  // A Home row's project that no tab holds: its model comes from the account
  // list alone (every machine, with the account's copies laid over it below).
  const copiesMenuView = useMemo(() => {
    if (copiesMenuModel) return copiesMenuModel;
    if (!copiesMenu || accountProjectList.state !== "ready") return null;
    const accountProject = accountProjectList.projects.find((entry) => entry.id === copiesMenu.groupId);
    if (!accountProject) return null;
    const machines = copyMachines(remoteSnapshot, { includeLocal: !webMode });
    return {
      group: null,
      projectName: accountProject.name,
      repoKey: accountProject.repoKey.startsWith("repo:") ? accountProject.repoKey.slice("repo:".length) : accountProject.repoKey,
      rows: machines.map((machine): CopiesMenuRow => ({ machine, copy: null, inUse: false })),
      onlyOneMachine: null,
      canPublish: false,
    };
  }, [accountProjectList, copiesMenu, copiesMenuModel, remoteSnapshot, webMode]);
  const copiesMenuCopies = useMemo(
    () => (copiesMenu ? sharedCopiesFor(copiesMenu.groupId) : null),
    [copiesMenu, sharedCopiesFor],
  );
  const copiesMenuComputers = useMemo(
    () => (copiesMenuCopies ? copyComputers(copiesMenuCopies) : null),
    [copiesMenuCopies],
  );
  const copiesMenuRows = useMemo(
    () => rowsWithSharedCopies(copiesMenuView?.rows ?? [], copiesMenuCopies, adeCloudTargetIds),
    [adeCloudTargetIds, copiesMenuCopies, copiesMenuView?.rows],
  );

  // The computers tag on the project page opens the copies menu of the tab in
  // front; a Home row's computers chip opens it for that account project,
  // open in a tab or not. The listener stays; it reads the tab in front here.
  const activeGroupIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeGroupIdRef.current = activeTabBindingKey
      ? tabGroups.find((entry) => entry.machines.some((machine) => machine.bindingKey === activeTabBindingKey))?.id ?? null
      : null;
  }, [activeTabBindingKey, tabGroups]);
  useEffect(() => {
    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<CopiesMenuRequest>).detail;
      if (!request) return;
      const groupId = request.projectId || activeGroupIdRef.current;
      if (!groupId) return;
      setCopiesMenu((current) => (current?.groupId === groupId ? null : { x: request.x, y: request.y, groupId }));
    };
    window.addEventListener(REQUEST_COPIES_MENU_EVENT, onRequest);
    return () => window.removeEventListener(REQUEST_COPIES_MENU_EVENT, onRequest);
  }, []);

  return {
    copiesMenu,
    closeCopiesMenu,
    copiesMenuModel,
    startCopyForRepo,
    addLocalCopyFromTab,
    removeTarget,
    openRemoveDialog,
    openRemoveNoMachineDialog,
    openRemoveDialogWithTarget,
    closeRemoveDialog,
    copiesMenuView,
    copiesMenuRows,
    copiesMenuComputers,
  };
}
