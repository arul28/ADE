import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAppStore, selectActiveProjectRoot } from "../../state/appStore";
import { useStartChatInLane } from "../../hooks/useStartChatInLane";
import { LaneContextMenu } from "../lanes/LaneContextMenu";

type MenuState = { laneId: string; x: number; y: number };

export type LaneContextTrigger = (
  laneId: string,
  e: { preventDefault: () => void; clientX: number; clientY: number },
) => void;

export function useWorkLaneContextMenu(): {
  trigger: LaneContextTrigger;
  menu: React.ReactNode;
} {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);

  const [menuState, setMenuState] = useState<MenuState | null>(null);

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

  const close = useCallback(() => setMenuState(null), []);

  useEffect(() => {
    if (!menuState) return;
    const onPointerDown = () => setMenuState(null);
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuState]);

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
    projectRoot,
    setWorkViewState,
    selectLane,
    navigate,
  });

  const menu = menuState
    ? createPortal(
        <LaneContextMenu
          laneContextMenu={menuState}
          lanesById={lanesById}
          visibleLaneIds={visibleLaneIds}
          onClose={close}
          onAdoptAttached={(laneId) => goToLanesAction(laneId, "adopt")}
          onManage={(laneId) => goToLanesAction(laneId, "manage")}
          onOpenRun={(laneId) => {
            selectLane(laneId);
            void navigate("/project");
          }}
          selectLane={(laneId) => {
            if (!laneId) return;
            goToLanesAction(laneId, "split-open");
          }}
          onRemoveFromSplit={(laneId) => goToLanesAction(laneId, "split-remove")}
          onCloseOtherSplits={(keepLaneId) => goToLanesAction(keepLaneId, "split-close-others")}
          onSelectAll={() => {
            if (!menuState) return;
            goToLanesAction(null, "select-all");
          }}
          onBatchManage={(laneIds) => {
            if (!laneIds.length) return;
            goToLanesAction(laneIds[0], "batch", { laneIds: laneIds.join(",") });
          }}
          onStartChatInLane={startChatInLane}
        />,
        document.body,
      )
    : null;

  return { trigger, menu };
}
