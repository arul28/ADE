import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { RemoteOpenProjectBinding, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import { useAppStore } from "../../state/appStore";
import { resolveProjectTabFallback, type ProjectTabGroup } from "./projectTabGrouping";
import { renameInTabOrder } from "./useRepositoryTabs";

/**
 * The remote tab in front, for ADE Web's move off a computer that left. The
 * forget can drop the binding before the move runs; then the last remote tab
 * is still the one in front, unless the person opened Home or a no-machine
 * tab since: a forget made from there never pulls them into a project.
 */
function frontRemoteTabKey(
  store: Pick<ReturnType<typeof useAppStore.getState>, "projectBinding" | "isNewTabOpen" | "activeNoMachineTabId">,
  lastRemoteBindingKey: string | null,
): string | null {
  // Home keeps the binding it opened over, so it goes first.
  if (store.isNewTabOpen || store.activeNoMachineTabId != null) return null;
  if (store.projectBinding?.kind === "remote") return store.projectBinding.key;
  if (store.projectBinding != null) return null;
  return lastRemoteBindingKey;
}

/**
 * ADE Web: how long a computer that was connected must stay away before its
 * tabs leave it. A project open passes through "idle" and "connecting" for
 * well under this; the reconnect hold covers a real drop before it.
 */
const WEB_STOP_SETTLE_MS = 3_000;

/**
 * ADE Web: the copies of no-machine tabs whose computer connected again, by
 * no-machine tab id, to open as their tabs again; the tab stays where it was in the strip, and the
 * no-machine tab closes once its repository is open (`useNoMachineTabCleanup`).
 * A tab the person closed, or one whose computer left the list, is dropped.
 */
function resumeWebStoppedTabs(
  stoppedTabs: Map<string, RemoteOpenProjectBinding>,
  targets: { connected: ReadonlySet<string>; gone: ReadonlySet<string> },
): Array<[string, RemoteOpenProjectBinding]> {
  if (stoppedTabs.size === 0) return [];
  const open = new Set(useAppStore.getState().noMachineTabs.map((tab) => tab.id));
  const resumed: Array<[string, RemoteOpenProjectBinding]> = [];
  for (const [id, binding] of stoppedTabs) {
    if (!open.has(id) || targets.gone.has(binding.targetId)) {
      stoppedTabs.delete(id);
      continue;
    }
    if (!targets.connected.has(binding.targetId)) continue;
    stoppedTabs.delete(id);
    resumed.push([id, binding]);
  }
  return resumed;
}

/**
 * ADE Web: a computer leaves this tab. It was forgotten or removed in this
 * browser (it leaves the connection list), or it stopped (still listed, not
 * connected once the reconnect hold ends). The tab is the repository (as on
 * the desktop, #2205): each of that computer's tabs moves to another
 * connected copy of its repository; a tab with none stays open with no
 * machine; only a folder with no repository closes. A drop never closes a
 * tab.
 */
export function useWebTabsFollowComputers({
  webMode,
  remoteBinding,
  remoteSnapshot,
  refs: { openRemoteProjectTabsRef, openProjectTabRootsRef, remoteSnapshotRef, tabGroupsRef, recordNameForRef },
  setOpenRemoteProjectTabs,
  setTabOrder,
  setPreferredBindingKeyByGroup,
}: {
  webMode: boolean;
  /** The remote copy in front, if any. */
  remoteBinding: RemoteOpenProjectBinding | null;
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null;
  /** The top bar's latest values, read when a computer leaves. */
  refs: {
    openRemoteProjectTabsRef: MutableRefObject<RemoteOpenProjectBinding[]>;
    openProjectTabRootsRef: MutableRefObject<string[]>;
    remoteSnapshotRef: MutableRefObject<RemoteRuntimeConnectionSnapshot | null>;
    tabGroupsRef: MutableRefObject<ProjectTabGroup[]>;
    recordNameForRef: MutableRefObject<(group: ProjectTabGroup) => string | null>;
  };
  setOpenRemoteProjectTabs: (next: RemoteOpenProjectBinding[]) => void;
  setTabOrder: Dispatch<SetStateAction<string[]>>;
  setPreferredBindingKeyByGroup: Dispatch<SetStateAction<Record<string, string>>>;
}): void {
  // The last remote tab in front: a forget can drop the binding before the
  // connection list loses its computer (see `frontRemoteTabKey`).
  const lastRemoteBindingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (remoteBinding) lastRemoteBindingKeyRef.current = remoteBinding.key;
  }, [remoteBinding]);
  const moveWebTabsOffGoneTargets = useCallback(async (
    gone: ReadonlySet<string>,
    waiting?: Map<string, RemoteOpenProjectBinding>,
  ): Promise<void> => {
    const latestRemoteTabs = openRemoteProjectTabsRef.current;
    const affected = latestRemoteTabs.filter((entry) => gone.has(entry.targetId));
    if (affected.length === 0) return;
    const connectedTargetIds = new Set(
      (remoteSnapshotRef.current?.connections ?? [])
        .filter((connection) => connection.state === "connected" && !gone.has(connection.target.id))
        .map((connection) => connection.target.id),
    );
    const openRemoteBindingKeys = latestRemoteTabs.map((entry) => entry.key);
    const plans = affected.map((tab) => {
      const fallback = resolveProjectTabFallback({
        bindingKey: tab.key,
        groups: tabGroupsRef.current,
        openLocalRoots: openProjectTabRootsRef.current,
        openRemoteBindingKeys,
        connectedTargetIds,
        excludeTargetId: tab.targetId,
      });
      // ADE Web has no this computer, so only a remote copy can take the tab,
      // and only on a computer connected now: a copy on one that also left,
      // or on one that is offline, leaves the tab on its no-machine page.
      const usable = fallback?.kind === "remote" && connectedTargetIds.has(fallback.binding.targetId) ? fallback : null;
      const group = tabGroupsRef.current.find((entry) => entry.machines.some((machine) => machine.bindingKey === tab.key));
      const noMachine = !usable && group?.origin
        ? { id: group.id, displayName: recordNameForRef.current(group) ?? tab.displayName, iconDataUrl: tab.iconDataUrl ?? null }
        : null;
      return { tab, fallback: usable, noMachine, groupId: group?.id ?? null };
    });
    const affectedKeys = new Set(affected.map((entry) => entry.key));
    const renamed = new Map<string, string>();
    const nextRemote = new Map<string, RemoteOpenProjectBinding>();
    // A computer that stopped stays listed with its copies, so the tab must
    // also prefer its new copy, or it would still show the one that left.
    const preferred: Record<string, string> = {};
    for (const entry of latestRemoteTabs) if (!affectedKeys.has(entry.key)) nextRemote.set(entry.key, entry);
    for (const plan of plans) {
      if (plan.fallback?.kind === "remote") {
        nextRemote.set(plan.fallback.binding.key, plan.fallback.binding);
        renamed.set(plan.tab.key, plan.fallback.binding.key);
        if (plan.groupId) preferred[plan.groupId] = plan.fallback.binding.key;
      }
    }
    if (Object.keys(preferred).length > 0) setPreferredBindingKeyByGroup((current) => ({ ...current, ...preferred }));
    const shownBeforeClose = {
      groups: tabGroupsRef.current,
      openLocal: new Set(openProjectTabRootsRef.current),
      openRemote: new Set(openRemoteBindingKeys),
    };
    if (renamed.size > 0) setTabOrder((prev) => renameInTabOrder(prev, renamed, shownBeforeClose));
    const nextRemoteTabs = [...nextRemote.values()];
    openRemoteProjectTabsRef.current = nextRemoteTabs;
    setOpenRemoteProjectTabs(nextRemoteTabs);
    for (const binding of affected) useAppStore.getState().evictProjectDataCaches(binding.key);
    // The tab that was in front stays in front: on its other copy, or with no machine.
    const store = useAppStore.getState();
    const frontKey = frontRemoteTabKey(store, lastRemoteBindingKeyRef.current);
    // A project open still on its way owns the front: the person's choice
    // replaces this tab, so the moved or waiting tab stays behind it.
    const frontWasAffected = frontKey != null && affectedKeys.has(frontKey) && store.projectTransition == null;
    for (const plan of plans) {
      if (!plan.noMachine) continue;
      // Kept before the switch below: a computer back during it finds the tab.
      waiting?.set(plan.noMachine.id, plan.tab);
      store.showNoMachineTab(plan.noMachine, { activate: frontWasAffected && plan.tab.key === frontKey });
    }
    const frontPlan = frontWasAffected ? plans.find((plan) => plan.tab.key === frontKey) : undefined;
    // A folder with no repository and no other copy closed: Home goes in front.
    if (frontPlan && !frontPlan.fallback && !frontPlan.noMachine) store.openNewTab();
    if (frontPlan?.fallback?.kind === "remote") {
      await store.switchRemoteProject(frontPlan.fallback.binding.targetId, frontPlan.fallback.binding.projectId).catch((error: unknown) => {
        // The tab moved; only its page did not open. A click on the tab opens it again.
        captureError(error, { fingerprint: ["repository-tabs", "web-move-open"], level: "warning", handled: true });
      });
    }
  }, [openProjectTabRootsRef, openRemoteProjectTabsRef, recordNameForRef, remoteSnapshotRef, setOpenRemoteProjectTabs, setPreferredBindingKeyByGroup, setTabOrder, tabGroupsRef]);
  const webSeenTargetIdsRef = useRef<ReadonlySet<string>>(new Set());
  // Computers connected at some point in this page, and the ones whose drop is
  // settling: a project open passes through "idle" and "connecting" for a
  // moment, so only a computer still away after WEB_STOP_SETTLE_MS stopped.
  const webEverConnectedRef = useRef(new Set<string>());
  const webStopTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const webStoppedTargetsRef = useRef(new Set<string>());
  // No-machine tabs made by a computer that stopped, by tab id, with the copy
  // each one had: the copy comes back when its computer connects again.
  const webStoppedTabsRef = useRef(new Map<string, RemoteOpenProjectBinding>());
  useEffect(() => {
    const timers = webStopTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    if (!webMode || !remoteSnapshot) return;
    const present = new Set(remoteSnapshot.connections.map((connection) => connection.target.id));
    const connected = new Set(
      remoteSnapshot.connections
        .filter((connection) => connection.state === "connected")
        .map((connection) => connection.target.id),
    );
    const gone = new Set([...webSeenTargetIdsRef.current].filter((targetId) => !present.has(targetId)));
    webSeenTargetIdsRef.current = present;
    const timers = webStopTimersRef.current;
    const stopTimer = (targetId: string) => {
      const timer = timers.get(targetId);
      if (timer) clearTimeout(timer);
      timers.delete(targetId);
    };
    for (const targetId of connected) {
      webEverConnectedRef.current.add(targetId);
      webStoppedTargetsRef.current.delete(targetId);
      stopTimer(targetId);
    }
    // Connected earlier in this page, still listed, not connected now. The
    // reconnect hold (federated adapter) reports a dropped computer as
    // connected while it comes back, so this one stayed away.
    for (const targetId of [...webEverConnectedRef.current]) {
      if (!present.has(targetId)) {
        webEverConnectedRef.current.delete(targetId);
        webStoppedTargetsRef.current.delete(targetId);
        stopTimer(targetId);
        continue;
      }
      if (connected.has(targetId) || timers.has(targetId) || webStoppedTargetsRef.current.has(targetId)) continue;
      timers.set(targetId, setTimeout(() => {
        timers.delete(targetId);
        const latest = remoteSnapshotRef.current?.connections.find((connection) => connection.target.id === targetId);
        if (!latest || latest.state === "connected") return;
        webStoppedTargetsRef.current.add(targetId);
        void moveWebTabsOffGoneTargets(new Set([targetId]), webStoppedTabsRef.current);
      }, WEB_STOP_SETTLE_MS));
    }
    const resumed = resumeWebStoppedTabs(webStoppedTabsRef.current, { connected, gone });
    if (resumed.length > 0) {
      const restore = (bindings: readonly RemoteOpenProjectBinding[]) => {
        const byKey = new Map(openRemoteProjectTabsRef.current.map((entry) => [entry.key, entry]));
        for (const binding of bindings) byKey.set(binding.key, binding);
        const nextRemoteTabs = [...byKey.values()];
        openRemoteProjectTabsRef.current = nextRemoteTabs;
        setOpenRemoteProjectTabs(nextRemoteTabs);
      };
      // A waiting tab in front opens its own copy; another project can be the
      // one under it. Its page stays until that copy is open, and only then
      // does the copy rejoin the strip (which closes the waiting page): either
      // one sooner shows the project under it while the open runs.
      const store = useAppStore.getState();
      const front = resumed.find(([id]) => id === store.activeNoMachineTabId)?.[1];
      const opensInFront = front != null && store.projectBinding?.key !== front.key;
      restore(resumed.map(([, binding]) => binding).filter((binding) => !opensInFront || binding !== front));
      if (opensInFront) {
        void store.switchRemoteProject(front.targetId, front.projectId, { keepNoMachineTab: true }).then(
          // Opened, or superseded by a later choice (the tab comes back behind it).
          () => restore([front]),
          (error: unknown) => {
            // Not opened: the waiting page stays, with Open on that computer.
            captureError(error, { fingerprint: ["repository-tabs", "web-resume-open"], level: "warning", handled: true });
          },
        );
      }
    }
    if (gone.size > 0) void moveWebTabsOffGoneTargets(gone);
  }, [moveWebTabsOffGoneTargets, openRemoteProjectTabsRef, remoteSnapshot, remoteSnapshotRef, setOpenRemoteProjectTabs, webMode]);
}
