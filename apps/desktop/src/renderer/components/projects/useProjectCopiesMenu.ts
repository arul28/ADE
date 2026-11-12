import { useCallback, useMemo, useState, type MouseEvent } from "react";
import type { FixedAnchor } from "../../hooks/useClampedFixedPosition";
import type { RecentProjectSummary, RemoteOpenProjectBinding, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { projectRecordScope } from "../../../shared/projectRecord";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { activeMachineForGroup, type ProjectTabGroup } from "../app/projectTabGrouping";
import { rememberLastUsedMachine } from "../app/useRepositoryTabs";
import type { CloneLocallyTarget } from "./CloneLocallyDialog";
import type { CopiesMenuRow } from "./ProjectCopiesMenu";
import type { RemovalCopy, RemoveProjectTarget } from "./RemoveProjectDialog";
import { copyMachines, existingCopiesForRepo, repoKeyForOriginIdentity, repoKeyForUrl, type CopyMachine } from "./projectCopies";
import { startCopyJob } from "./projectCopyJobs";

/**
 * The copies menu of a project tab and the remove dialog it opens: one row
 * per machine with that machine's copy of the repository, the clone of a
 * new copy, and the switch to another machine's copy. The top bar owns the
 * tabs; this hook owns the menu, the dialog target and the models they show.
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
  knownRemoteProjectTabs: readonly RemoteOpenProjectBinding[];
  handleClonedLocally: (rootPath: string, remoteKey: string) => Promise<unknown> | unknown;
  handleSwitchProject: (rootPath: string) => unknown;
  handleSwitchRemoteProject: (binding: RemoteOpenProjectBinding) => unknown;
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
    knownRemoteProjectTabs,
    handleClonedLocally,
    handleSwitchProject,
    handleSwitchRemoteProject,
  } = args;
  // The copies menu of one tab: under its machine mark, or where the tab's
  // context menu was opened.
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
  const openRemoveDialog = useCallback((groupId: string) => {
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
    const inUseKey = model.rows.find((row) => row.inUse)?.copy?.bindingKey ?? null;
    const current = copies.find((copy) => copy.bindingKey === inUseKey) ?? copies[0];
    if (!current) return;
    setRemoveTarget({
      groupId,
      recordScope: model.repoKey ? projectRecordScope(model.group.origin ?? null) : null,
      projectName: model.projectName,
      repoKey: model.repoKey,
      current,
      copies,
    });
  }, [copiesModelFor]);

  const handleCopiesMenuSwitch = useCallback(
    (row: CopiesMenuRow) => {
      const group = copiesMenuModel?.group;
      const own = group?.machines.find((entry) => entry.bindingKey === row.copy?.bindingKey);
      // The machine picked here is also the one "Start on" offers first for
      // new work in this repository, on this client.
      if (group && row.copy) rememberLastUsedMachine(group.id, row.machine.machineId);
      if (row.machine.isLocal) {
        if (row.copy) handleSwitchProject(row.copy.rootPath);
        return;
      }
      const binding = own?.binding?.kind === "remote"
        ? own.binding
        : knownRemoteProjectTabs.find((entry) => entry.key === row.copy?.bindingKey) ?? null;
      if (!binding) return;
      handleSwitchRemoteProject(binding);
    },
    [copiesMenuModel?.group, handleSwitchProject, handleSwitchRemoteProject, knownRemoteProjectTabs],
  );

  const openCopiesMenuFor = useCallback((event: MouseEvent<HTMLElement>, groupId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setCopiesMenu((current) =>
      current?.groupId === groupId ? null : { x: rect.left, y: rect.bottom + 4, groupId },
    );
  }, []);

  return {
    copiesMenu,
    setCopiesMenu,
    closeCopiesMenu,
    copiesMenuModel,
    startCopyForRepo,
    addLocalCopyFromTab,
    removeTarget,
    openRemoveDialog,
    closeRemoveDialog,
    handleCopiesMenuSwitch,
    openCopiesMenuFor,
  };
}
