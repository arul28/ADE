import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import type { RemoteOpenProjectBinding } from "../../../shared/types";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { confirmDialog } from "../ui/dialog/confirm";
import { removeStoredProjectRoute } from "./projectRouteStorage";
import { activeMachineForGroup, tabOrderKey, type ProjectTabGroup } from "./projectTabGrouping";
import {
  cssToScreenScale,
  insertIndexAtClientX,
  useProjectTabDrag,
  type ScreenPoint,
  type TearOffStart,
} from "./useProjectTabDrag";

function confirmProjectTabRemoval(projectName: string): Promise<boolean> {
  const label = projectName.trim() || "this project";
  return confirmDialog({
    title: `Close "${label}" project tab?`,
    message: "This does not remove it from Recent Projects or delete any files on disk.",
    confirmLabel: "Close",
  });
}

function confirmProjectTabsRemoval(count: number): Promise<boolean> {
  return confirmDialog({
    title: `Close ${count} project tabs?`,
    message: "This does not remove them from Recent Projects or delete any files on disk.",
    confirmLabel: "Close",
  });
}

/**
 * Everything that changes which tabs a window holds and in what order:
 * closing one or many, reordering, tearing a tab off into its own window,
 * adopting a tab dropped from another window, moving a tab to a new window,
 * and replacing a project's tab with its fresh local clone.
 */
export function useProjectTabLifecycle({
  tabGroupsRef,
  openProjectTabRootsRef,
  openRemoteProjectTabsRef,
  setTabOrder,
  checkForActiveWorkloads,
  isProjectBusy,
}: {
  tabGroupsRef: MutableRefObject<ProjectTabGroup[]>;
  openProjectTabRootsRef: MutableRefObject<string[]>;
  openRemoteProjectTabsRef: MutableRefObject<RemoteOpenProjectBinding[]>;
  setTabOrder: Dispatch<SetStateAction<string[]>>;
  checkForActiveWorkloads: (rootPath: string) => Promise<boolean>;
  isProjectBusy: boolean;
}) {
  const setOpenProjectTabRoots = useAppStore((s) => s.setOpenProjectTabRoots);
  const setOpenRemoteProjectTabs = useAppStore((s) => s.setOpenRemoteProjectTabs);
  const evictProjectState = useAppStore((s) => s.evictProjectState);

  /**
   * Closes one or more tabs. Every tab is a project, wherever its checkout
   * lives, so one path handles all of them: it closes the tabs in the visual
   * order the user sees, and when the active tab closes it moves to the
   * nearest remaining tab on the right, else on the left.
   *
   * `forgetState` drops a closed project's view state and remembered route. A
   * tab that moves to another window keeps nothing here either, but the state
   * belongs to that window now, so the caller decides.
   */
  const closeTabGroups = useCallback(
    async (
      groupIds: readonly string[],
      opts: { confirm: boolean; checkWorkloads: boolean; forgetState: boolean },
    ): Promise<boolean> => {
      const closingIds = new Set(groupIds);
      const closing = tabGroupsRef.current.filter((group) => closingIds.has(group.id));
      if (closing.length === 0) return false;
      if (opts.confirm) {
        const confirmed = closing.length === 1
          ? await confirmProjectTabRemoval(closing[0]!.displayName)
          : await confirmProjectTabsRemoval(closing.length);
        if (!confirmed) return false;
      }

      const openLocalRoots = new Set(openProjectTabRootsRef.current);
      const openRemoteKeys = new Set(openRemoteProjectTabsRef.current.map((entry) => entry.key));
      const localRoots = new Set<string>();
      const remoteKeys = new Set<string>();
      for (const group of closing) {
        for (const machine of group.machines) {
          if (openLocalRoots.has(machine.bindingKey)) localRoots.add(machine.bindingKey);
          else if (openRemoteKeys.has(machine.bindingKey)) remoteKeys.add(machine.bindingKey);
        }
      }
      if (opts.checkWorkloads) {
        for (const rootPath of localRoots) {
          if (!(await checkForActiveWorkloads(rootPath))) return false;
        }
      }

      const removeFromLists = () => {
        const nextRoots = openProjectTabRootsRef.current.filter((root) => !localRoots.has(root));
        openProjectTabRootsRef.current = nextRoots;
        setOpenProjectTabRoots((prev) => prev.filter((root) => !localRoots.has(root)));
        const nextRemote = openRemoteProjectTabsRef.current.filter((entry) => !remoteKeys.has(entry.key));
        openRemoteProjectTabsRef.current = nextRemote;
        setOpenRemoteProjectTabs((prev) => prev.filter((entry) => !remoteKeys.has(entry.key)));
        setTabOrder((prev) => prev.filter((key) => !localRoots.has(key) && !remoteKeys.has(key)));
        if (opts.forgetState) {
          for (const key of remoteKeys) {
            evictProjectState(key);
            removeStoredProjectRoute(key);
          }
        }
      };

      // Read the tabs again: they can change while the confirm dialog and the
      // workload check wait.
      const groups = tabGroupsRef.current;
      const state = useAppStore.getState();
      const activeKey = state.projectBinding?.kind === "remote"
        ? state.projectBinding.key
        : state.project?.rootPath ?? null;
      const activeIndex = activeKey == null
        ? -1
        : groups.findIndex((group) => group.machines.some((machine) => machine.bindingKey === activeKey));
      if (activeIndex === -1 || !closingIds.has(groups[activeIndex]!.id)) {
        removeFromLists();
        return true;
      }

      const nextGroup =
        groups.slice(activeIndex + 1).find((group) => !closingIds.has(group.id))
        ?? groups.slice(0, activeIndex).reverse().find((group) => !closingIds.has(group.id))
        ?? null;
      const next = nextGroup ? activeMachineForGroup(nextGroup) : null;
      try {
        if (next?.isLocal) {
          await state.switchProjectToPath(next.rootPath);
        } else if (next?.binding?.kind === "remote") {
          await state.switchRemoteProject(next.binding.targetId, next.binding.projectId);
        } else {
          await state.closeProject();
          removeFromLists();
          return true;
        }
      } catch {
        return false;
      }
      // Remove only after the switch: while a project is still active, the
      // binding effects above would put its tab straight back.
      removeFromLists();
      return true;
    },
    [
      openProjectTabRootsRef,
      openRemoteProjectTabsRef,
      setTabOrder,
      tabGroupsRef,
      checkForActiveWorkloads,
      evictProjectState,
      setOpenProjectTabRoots,
      setOpenRemoteProjectTabs,
    ],
  );

  const groupIdForBindingKey = useCallback(
    (bindingKey: string) => {
      const groups = tabGroupsRef.current;
      // A tab's own checkout wins over a checkout it merely lists.
      return (
        groups.find((group) => group.machines[0]?.bindingKey === bindingKey)
        ?? groups.find((group) =>
          group.machines.some((machine) => machine.bindingKey === bindingKey),
        )
      )?.id ?? null;
    },
    [tabGroupsRef],
  );

  const handleRemoveTab = useCallback(
    (rootPath: string) => {
      const groupId = groupIdForBindingKey(rootPath);
      if (!groupId) return;
      void closeTabGroups([groupId], { confirm: true, checkWorkloads: true, forgetState: true });
    },
    [closeTabGroups, groupIdForBindingKey],
  );

  const handleCloseRemoteTab = useCallback((binding: RemoteOpenProjectBinding) => {
    if (isProjectBusy) return;
    const groupId = groupIdForBindingKey(binding.key);
    if (!groupId) return;
    void closeTabGroups([groupId], { confirm: false, checkWorkloads: false, forgetState: true });
  }, [closeTabGroups, groupIdForBindingKey, isProjectBusy]);

  const handleReorderTabs = useCallback(
    (orderedKeys: string[]) => {
      setTabOrder(orderedKeys);
      // Main persists the local tab list in its own order, so keep that list
      // in the same relative order for the next launch.
      const ranked = new Map(orderedKeys.map((key, index) => [key, index]));
      setOpenProjectTabRoots((prev) =>
        [...prev].sort(
          (a, b) => (ranked.get(a) ?? orderedKeys.length) - (ranked.get(b) ?? orderedKeys.length),
        ),
      );
    },
    [setOpenProjectTabRoots, setTabOrder],
  );

  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const tearOffRef = useRef<{
    key: string;
    moveSource: boolean;
    started: Promise<{ windowId: number | null }>;
  } | null>(null);

  const handleTearOff = useCallback(
    ({ key, grab, moveSource, point }: TearOffStart) => {
      const group = tabGroupsRef.current.find((entry) => tabOrderKey(entry) === key);
      const binding = group?.machines[0]?.binding;
      if (!binding) return;
      tearOffRef.current = {
        key,
        moveSource,
        started: window.ade.app
          .projectTabDragStart({ binding, grab, moveSource, point })
          .catch(() => ({ windowId: null })),
      };
    },
    [tabGroupsRef],
  );

  const handleTearOffMove = useCallback((point: ScreenPoint) => {
    if (tearOffRef.current) window.ade.app.projectTabDragMove(point);
  }, []);

  const handleTearOffEnd = useCallback((point: ScreenPoint | null) => {
    const tearOff = tearOffRef.current;
    tearOffRef.current = null;
    if (!tearOff) return;
    void (async () => {
      const started = await tearOff.started;
      const result = await window.ade.app
        .projectTabDragEnd(point)
        .catch(() => ({ merged: false, intoSender: false }));
      // A lone tab moved its own window; there is nothing left to remove here.
      if (started.windowId == null || tearOff.moveSource) return;
      // Dropped back on this window's own strip: the adopt event reorders it.
      if (result.intoSender) return;
      const groupId = groupIdForBindingKey(tearOff.key);
      if (!groupId) return;
      // The tab now lives in another window, so its work is not stopped and
      // nothing is asked: the project only moved.
      await closeTabGroups([groupId], { confirm: false, checkWorkloads: false, forgetState: false });
    })();
  }, [closeTabGroups, groupIdForBindingKey]);

  const projectTabDrag = useProjectTabDrag({
    stripRef: tabStripRef,
    canTearOff: !isWebClientMode() && !isProjectBusy,
    onReorder: handleReorderTabs,
    onTearOff: handleTearOff,
    onTearOffMove: handleTearOffMove,
    onTearOffEnd: handleTearOffEnd,
  });

  // A tab dragged out of another window (or out of this one and back) and
  // released over this strip joins it where it was dropped, and opens.
  useEffect(() => {
    const subscribe = window.ade?.app?.onAdoptProjectTab;
    if (typeof subscribe !== "function") return;
    return subscribe(({ binding, screenOffsetX }) => {
      const key = binding.kind === "remote" ? binding.key : binding.rootPath;
      const keys = tabGroupsRef.current.map(tabOrderKey).filter((entry) => entry !== key);
      const strip = tabStripRef.current;
      // Main measures in screen points; the strip is laid out in CSS pixels.
      const insertAt = strip
        ? insertIndexAtClientX(strip, screenOffsetX / cssToScreenScale(), key)
        : keys.length;
      keys.splice(insertAt, 0, key);
      handleReorderTabs(keys);
      const state = useAppStore.getState();
      if (binding.kind === "remote") {
        state.switchRemoteProject(binding.targetId, binding.projectId).catch(() => {});
      } else {
        state.switchProjectToPath(binding.rootPath, { skipWorktreeGate: true }).catch(() => {});
      }
    });
  }, [handleReorderTabs, tabGroupsRef]);

  // The clone opens in the tab the project already had, in the same place.
  const handleClonedLocally = useCallback(
    async (rootPath: string, remoteKey: string) => {
      const keys = tabGroupsRef.current.map(tabOrderKey);
      const at = keys.indexOf(remoteKey);
      try {
        await useAppStore.getState().switchProjectToPath(rootPath, { skipWorktreeGate: true });
      } catch {
        return;
      }
      const next = keys.filter((key) => key !== remoteKey && key !== rootPath);
      next.splice(at === -1 ? next.length : at, 0, rootPath);
      handleReorderTabs(next);
      const groupId = groupIdForBindingKey(remoteKey);
      if (groupId) {
        await closeTabGroups([groupId], { confirm: false, checkWorkloads: false, forgetState: true });
      }
    },
    [closeTabGroups, groupIdForBindingKey, handleReorderTabs, tabGroupsRef],
  );

  const handleMoveTabToNewWindow = useCallback(
    (group: ProjectTabGroup) => {
      const binding = group.machines[0]?.binding;
      if (!binding) return;
      void (async () => {
        try {
          const result = await window.ade.app.openProjectInNewWindow(binding);
          if (result.windowId == null) return;
        } catch {
          return;
        }
        await closeTabGroups([group.id], { confirm: false, checkWorkloads: false, forgetState: false });
      })();
    },
    [closeTabGroups],
  );

  return {
    closeTabGroups,
    groupIdForBindingKey,
    handleRemoveTab,
    handleCloseRemoteTab,
    handleReorderTabs,
    handleClonedLocally,
    handleMoveTabToNewWindow,
    tabStripRef,
    projectTabDrag,
  };
}
