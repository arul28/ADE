import { useCallback, useEffect, useRef, useState } from "react";
import { ADE_WORK_LANE_DND_MIME } from "./workLaneOrder";

type LaneDrop = { laneId: string; edge: "before" | "after" } | null;

type ReorderWorkLanes = (args: {
  movedLaneId: string;
  targetLaneId: string;
  edge: "before" | "after";
  renderedLaneIds: readonly string[];
}) => void;

/**
 * Native HTML5 lane-header reordering for the Work sidebar.
 *
 * The controller owns the drag lifecycle and edge auto-scroll so the list
 * component can stay responsible for rendering lane groups and their state.
 */
export function useWorkLaneReorder(
  reorderWorkLanes: ReorderWorkLanes | undefined,
  renderedLaneIds: readonly string[],
  canDropLane: (movedLaneId: string, targetLaneId: string) => boolean,
  canStartLaneDrag: (laneId: string) => boolean,
): {
  listScrollRef: React.RefObject<HTMLDivElement>;
  laneDrop: LaneDrop;
  laneDragProps: (laneId: string) => React.HTMLAttributes<HTMLDivElement> | null;
} {
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const [laneDrop, setLaneDrop] = useState<LaneDrop>(null);
  const draggedLaneIdRef = useRef<string | null>(null);
  const autoScrollRef = useRef<{ frame: number | null; velocity: number }>({ frame: null, velocity: 0 });

  const stopLaneAutoScroll = useCallback(() => {
    if (autoScrollRef.current.frame != null) cancelAnimationFrame(autoScrollRef.current.frame);
    autoScrollRef.current = { frame: null, velocity: 0 };
  }, []);

  const setLaneAutoScrollVelocity = useCallback((velocity: number) => {
    autoScrollRef.current.velocity = velocity;
    if (velocity === 0) {
      stopLaneAutoScroll();
      return;
    }
    if (autoScrollRef.current.frame != null) return;
    const step = () => {
      const container = listScrollRef.current;
      const { velocity: current } = autoScrollRef.current;
      if (!container || current === 0) {
        stopLaneAutoScroll();
        return;
      }
      container.scrollTop += current;
      autoScrollRef.current.frame = requestAnimationFrame(step);
    };
    autoScrollRef.current.frame = requestAnimationFrame(step);
  }, [stopLaneAutoScroll]);

  useEffect(() => stopLaneAutoScroll, [stopLaneAutoScroll]);

  const endLaneDrag = useCallback(() => {
    draggedLaneIdRef.current = null;
    setLaneDrop(null);
    stopLaneAutoScroll();
  }, [stopLaneAutoScroll]);

  const laneDragProps = useCallback((laneId: string): React.HTMLAttributes<HTMLDivElement> | null => {
    if (!reorderWorkLanes || !canStartLaneDrag(laneId)) return null;
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent<HTMLDivElement>) => {
        draggedLaneIdRef.current = laneId;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(ADE_WORK_LANE_DND_MIME, laneId);
      },
      onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes(ADE_WORK_LANE_DND_MIME)) return;
        const movedLaneId = draggedLaneIdRef.current;
        if (!movedLaneId || movedLaneId === laneId || !canDropLane(movedLaneId, laneId)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const edge = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        setLaneDrop((previous) =>
          previous?.laneId === laneId && previous.edge === edge ? previous : { laneId, edge });

        const container = listScrollRef.current;
        if (!container) return;
        const bounds = container.getBoundingClientRect();
        const fromTop = event.clientY - bounds.top;
        const fromBottom = bounds.bottom - event.clientY;
        const ramp = (distance: number) => 2 + 14 * (1 - Math.max(0, distance) / 48);
        if (fromTop < 48) setLaneAutoScrollVelocity(-ramp(fromTop));
        else if (fromBottom < 48) setLaneAutoScrollVelocity(ramp(fromBottom));
        else setLaneAutoScrollVelocity(0);
      },
      onDragLeave: () => {
        setLaneDrop((previous) => (previous?.laneId === laneId ? null : previous));
        setLaneAutoScrollVelocity(0);
      },
      onDrop: (event: React.DragEvent<HTMLDivElement>) => {
        const movedLaneId = draggedLaneIdRef.current
          ?? event.dataTransfer.getData(ADE_WORK_LANE_DND_MIME);
        const edge = laneDrop?.laneId === laneId ? laneDrop.edge : null;
        endLaneDrag();
        if (!movedLaneId || !edge || movedLaneId === laneId || !canDropLane(movedLaneId, laneId)) return;
        event.preventDefault();
        reorderWorkLanes({ movedLaneId, targetLaneId: laneId, edge, renderedLaneIds });
      },
      onDragEnd: endLaneDrag,
    };
  }, [canDropLane, canStartLaneDrag, endLaneDrag, laneDrop, reorderWorkLanes, renderedLaneIds, setLaneAutoScrollVelocity]);

  return { listScrollRef, laneDrop, laneDragProps };
}
