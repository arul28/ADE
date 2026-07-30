import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import {
  useAppStore,
  useRootAppStore,
  selectActiveProjectStateKey,
} from "../../state/appStore";
import { useStartChatInLane } from "../../hooks/useStartChatInLane";
import { LaneContextMenu } from "../lanes/LaneContextMenu";
import { ForeignLaneContextMenu } from "./ForeignLaneContextMenu";
import { WorkManageLaneDialogHost } from "./WorkManageLaneDialogHost";

type MenuState = { laneId: string; x: number; y: number };
/**
 * Foreign menus can be opened on a machine that is offline, so the menu has to
 * know. It carries the machine ID rather than a captured `online` flag: a flag
 * read at right-click time would still say "online" in the one case that
 * matters, the machine dropping while the menu is open. Liveness is read from
 * the store on every render instead.
 */
type ForeignMenuState = {
  lane: LaneSummary;
  binding: OpenProjectBinding;
  machineName: string;
  machineId: string;
  x: number;
  y: number;
};
type ManagedLaneState = {
  laneId: string;
  lane?: LaneSummary;
  binding?: OpenProjectBinding;
};

export type LaneContextTrigger = (
  laneId: string,
  e: { preventDefault: () => void; clientX: number; clientY: number },
) => void;
export type ForeignLaneContextTrigger = (
  lane: LaneSummary,
  binding: OpenProjectBinding,
  machineName: string,
  machineId: string,
  e: { preventDefault: () => void; clientX: number; clientY: number },
) => void;

/** The behavioural half of the lane menu, minus the menu itself. */
export type LaneMenuActions = {
  onAdoptAttached: (laneId: string) => void;
  onManage: (laneId: string) => void;
  selectLane: (id: string) => void;
  onRemoveFromSplit: (laneId: string) => void;
  onCloseOtherSplits: (keepLaneId: string) => void;
  onSelectAll: () => void;
  onBatchManage: (laneIds: string[]) => void;
  onStartChatInLane: (laneId: string) => void;
};

/**
 * Wires the lane menu's actions once, for every surface that renders lane menu
 * items: the lane divider's own menu here, and the "Lane ▸" submenu a singleton
 * lane's session card carries. Items come from `buildLaneMenuGroups`; this is
 * the other half of keeping those two surfaces from drifting apart.
 *
 * `onManageLane` is supplied by the host rather than resolved here because the
 * manage dialog has to outlive the menu that opened it — the host owns the
 * dialog state, this hook only routes the click.
 */
export function useLaneMenuActions(args: {
  close: () => void;
  onManageLane: (laneId: string) => void;
}): LaneMenuActions {
  const { close, onManageLane } = args;
  const navigate = useNavigate();
  const selectLane = useAppStore((s) => s.selectLane);
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);

  const goToLanesAction = useCallback(
    (laneId: string | null, action: string, extras?: Record<string, string>) => {
      const init: Record<string, string> = { action, ...(extras ?? {}) };
      if (laneId) init.laneId = laneId;
      const params = new URLSearchParams(init);
      if (laneId) selectLane(laneId);
      void navigate(`/lanes?${params.toString()}`);
    },
    [navigate, selectLane],
  );

  const startChatInLane = useStartChatInLane({
    projectStateKey,
    setWorkViewState,
    selectLane,
    navigate,
  });

  return useMemo<LaneMenuActions>(() => ({
    onAdoptAttached: (laneId) => goToLanesAction(laneId, "adopt"),
    onManage: (laneId) => {
      close();
      onManageLane(laneId);
    },
    selectLane: (laneId) => {
      if (!laneId) return;
      goToLanesAction(laneId, "split-open");
    },
    onRemoveFromSplit: (laneId) => goToLanesAction(laneId, "split-remove"),
    onCloseOtherSplits: (keepLaneId) => goToLanesAction(keepLaneId, "split-close-others"),
    onSelectAll: () => goToLanesAction(null, "select-all"),
    onBatchManage: (laneIds) => {
      if (!laneIds.length) return;
      goToLanesAction(laneIds[0], "batch", { laneIds: laneIds.join(",") });
    },
    onStartChatInLane: startChatInLane,
  }), [close, goToLanesAction, onManageLane, startChatInLane]);
}

export function useWorkLaneContextMenu(options?: {
  /** Work-sidebar lane pin. Omitted by callers that have no pinning surface. */
  onToggleWorkPin?: (laneId: string) => void;
  workPinnedLaneIds?: string[];
}): {
  trigger: LaneContextTrigger;
  triggerForeign: ForeignLaneContextTrigger;
  menu: React.ReactNode;
} {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const switchRemoteProject = useAppStore((s) => s.switchRemoteProject);

  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [foreignMenuState, setForeignMenuState] = useState<ForeignMenuState | null>(null);
  const [managedLane, setManagedLane] = useState<ManagedLaneState | null>(null);
  // Read live, not captured: a machine that drops while its menu is open must
  // disable the actions that would now fail rather than keep offering them.
  const foreignMachineOnline = useRootAppStore((state) =>
    foreignMenuState
      ? state.crossMachineLanesByMachineId[foreignMenuState.machineId]?.online ?? false
      : false,
  );
  const lanesById = useMemo(() => {
    const map = new Map<string, (typeof lanes)[number]>();
    for (const lane of lanes) map.set(lane.id, lane);
    return map;
  }, [lanes]);

  const visibleLaneIds = useMemo(() => {
    const id = menuState?.laneId;
    return id ? [id] : [];
  }, [menuState?.laneId]);

  const trigger = useCallback<LaneContextTrigger>((laneId, e) => {
    e.preventDefault();
    setMenuState({ laneId, x: e.clientX, y: e.clientY });
  }, []);
  const triggerForeign = useCallback<ForeignLaneContextTrigger>((
    lane,
    binding,
    machineName,
    machineId,
    event,
  ) => {
    event.preventDefault();
    setMenuState(null);
    setForeignMenuState({
      lane,
      binding,
      machineName,
      machineId,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const close = useCallback(() => {
    setMenuState(null);
    setForeignMenuState(null);
  }, []);

  useEffect(() => {
    if (!menuState && !foreignMenuState) return;
    const onPointerDown = () => close();
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, foreignMenuState, menuState]);

  const openManageDialog = useCallback((laneId: string) => {
    setManagedLane({ laneId });
  }, []);
  const laneMenuActions = useLaneMenuActions({ close, onManageLane: openManageDialog });

  const startForeignChat = useCallback(() => {
    if (!foreignMenuState || !projectStateKey || !foreignMachineOnline) return;
    const laneId = foreignMenuState.lane.id;
    setWorkViewState(projectStateKey, (previous) => ({
      ...previous,
      draftKind: "chat",
      draftLaneId: laneId,
      draftMachineId: foreignMenuState.binding.kind === "remote"
        ? foreignMenuState.binding.targetId
        : "this-mac",
      activeItemId: null,
      selectedItemId: null,
    }));
    close();
    void navigate("/work");
  }, [
    close,
    foreignMachineOnline,
    foreignMenuState,
    navigate,
    projectStateKey,
    setWorkViewState,
  ]);
  const openForeignLane = useCallback(() => {
    if (!foreignMenuState || !foreignMachineOnline) return;
    const { binding, lane } = foreignMenuState;
    close();
    const switching = binding.kind === "remote"
      ? switchRemoteProject(binding.targetId, binding.projectId)
      : switchProjectToPath(binding.rootPath);
    void switching.then(() => {
      selectLane(lane.id);
      void navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single`);
    });
  }, [
    close,
    foreignMachineOnline,
    foreignMenuState,
    navigate,
    selectLane,
    switchProjectToPath,
    switchRemoteProject,
  ]);
  const manageForeignLane = useCallback(() => {
    if (!foreignMenuState || !foreignMachineOnline) return;
    const { binding, lane } = foreignMenuState;
    close();
    setManagedLane({
      laneId: lane.id,
      lane,
      binding,
    });
  }, [close, foreignMachineOnline, foreignMenuState]);

  const menu = menuState || foreignMenuState || managedLane
    ? createPortal(
        <>
          {menuState ? (
            <LaneContextMenu
              laneContextMenu={menuState}
              lanesById={lanesById}
              visibleLaneIds={visibleLaneIds}
              onClose={close}
              {...laneMenuActions}
              onToggleWorkPin={options?.onToggleWorkPin}
              workPinnedLaneIds={options?.workPinnedLaneIds}
            />
          ) : null}
          {foreignMenuState ? (
            <>
              <div
                className="fixed inset-0 z-40"
                onContextMenu={(event) => {
                  event.preventDefault();
                  close();
                }}
              />
              <ForeignLaneContextMenu
                lane={foreignMenuState.lane}
                machineName={foreignMenuState.machineName}
                online={foreignMachineOnline}
                x={foreignMenuState.x}
                y={foreignMenuState.y}
                onClose={close}
                onStartChat={startForeignChat}
                onManage={manageForeignLane}
                onOpenInLanes={openForeignLane}
              />
            </>
          ) : null}
          <WorkManageLaneDialogHost
            laneId={managedLane?.laneId ?? null}
            lane={managedLane?.lane}
            runtimePin={managedLane?.binding}
            onClose={() => setManagedLane(null)}
          />
        </>,
        document.body,
      )
    : null;

  return { trigger, triggerForeign, menu };
}
