import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applySteerOrder, moveSteerId } from "../../../shared/steerOrder";

/** How long a settled move's local order waits for the host's confirming event. */
const HOST_ORDER_GRACE_MS = 1_500;

/** Drag payload type for a staged message, so file drops never read as a reorder. */
export const PENDING_STEER_DND_MIME = "application/x-ade-pending-steer";

/** What one staged row needs to be dragged or moved from the keyboard. */
export type PendingSteerReorder = {
  index: number;
  count: number;
  dragging: boolean;
  dropEdge: "before" | "after" | null;
  /** Move this row to `toIndex` in the current list. */
  onMove: (toIndex: number) => void;
  onDragStart: () => void;
  onDragOverRow: (edge: "before" | "after") => void;
  onDrop: () => void;
  onDragEnd: () => void;
  handleRef: (element: HTMLButtonElement | null) => void;
};

type SteerDrag = {
  steerId: string;
  over: { steerId: string; edge: "before" | "after" } | null;
};

/**
 * Reorder for the composer's staged-message list. The host publishes the new
 * order back as a `queue_reordered` event, so the local order is optimistic
 * only until the list it overrides changes, and it drops back to the host's
 * order when the move is refused.
 */
export function usePendingSteerReorder<T extends { steerId: string }>(
  pendingSteers: readonly T[],
  onMoveSteer: ((steerId: string, toIndex: number) => Promise<void>) | undefined,
): {
  orderedSteers: readonly T[];
  canReorder: boolean;
  reorderPropsFor: (steerId: string, index: number) => PendingSteerReorder;
} {
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<SteerDrag | null>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMoveRef = useRef<string | null>(null);
  const orderKey = pendingSteers.map((steer) => steer.steerId).join("\u0000");
  useEffect(() => {
    setOptimisticOrder(null);
  }, [orderKey]);
  const orderedSteers = useMemo(
    () => (optimisticOrder ? applySteerOrder(pendingSteers, (steer) => steer.steerId, optimisticOrder) : pendingSteers),
    [pendingSteers, optimisticOrder],
  );
  useLayoutEffect(() => {
    const steerId = focusAfterMoveRef.current;
    if (!steerId) return;
    focusAfterMoveRef.current = null;
    handleRefs.current.get(steerId)?.focus();
  });

  const move = (steerId: string, toIndex: number, options?: { focus?: boolean }) => {
    if (!onMoveSteer) return;
    const ids = orderedSteers.map((steer) => steer.steerId);
    if (ids.indexOf(steerId) === toIndex) return;
    const next = moveSteerId(ids, steerId, toIndex);
    if (!next) return;
    setOptimisticOrder(next);
    // Blur, then refocus once the row has moved: arrow keys keep moving the
    // same message, and the blur closes the handle's tooltip, which is
    // positioned once and would otherwise stay over the row's old slot.
    if (options?.focus) {
      handleRefs.current.get(steerId)?.blur();
      focusAfterMoveRef.current = steerId;
    }
    // The host's `queue_reordered` event replaces this order (the id list
    // changes). A host that accepted the call but kept its order sends no
    // event, so drop the local order shortly after a settled call either way.
    void onMoveSteer(steerId, toIndex)
      .then(() => {
        window.setTimeout(() => setOptimisticOrder((current) => (current === next ? null : current)), HOST_ORDER_GRACE_MS);
      })
      .catch(() => setOptimisticOrder(null));
  };

  const drop = () => {
    const current = drag;
    setDrag(null);
    if (!current?.over || current.over.steerId === current.steerId) return;
    const ids = orderedSteers.map((steer) => steer.steerId);
    const from = ids.indexOf(current.steerId);
    const targetIndex = ids.indexOf(current.over.steerId);
    if (from === -1 || targetIndex === -1) return;
    const insertAt = targetIndex + (current.over.edge === "after" ? 1 : 0);
    move(current.steerId, insertAt > from ? insertAt - 1 : insertAt);
  };

  return {
    orderedSteers,
    canReorder: Boolean(onMoveSteer) && orderedSteers.length > 1,
    reorderPropsFor: (steerId, index) => ({
      index,
      count: orderedSteers.length,
      dragging: drag?.steerId === steerId,
      dropEdge: drag?.over?.steerId === steerId && drag.steerId !== steerId ? drag.over.edge : null,
      onMove: (toIndex) => move(steerId, toIndex, { focus: true }),
      onDragStart: () => setDrag({ steerId, over: null }),
      onDragOverRow: (edge) => setDrag((current) => (
        current && (current.over?.steerId !== steerId || current.over.edge !== edge)
          ? { ...current, over: { steerId, edge } }
          : current
      )),
      onDrop: drop,
      onDragEnd: () => setDrag(null),
      handleRef: (element) => {
        if (element) handleRefs.current.set(steerId, element);
        else handleRefs.current.delete(steerId);
      },
    }),
  };
}
