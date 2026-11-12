import { useEffect } from "react";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { followSessionToMachine } from "../../lib/otherMachineNavigation";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { sameMachineKey } from "../../../shared/machineAddress";

/**
 * Contract C3 for an open chat: when its cloud lane's computer changes (a
 * move, a new computer), the chat follows. Same chat id, same lane id; the
 * pin, and with it the Android panel and tools, move to the new computer.
 *
 * Two ways it notices:
 * - the move event (`window.ade.cloud.onLaneMoved`), live;
 * - the lane index, for a move made while this window was closed or on
 *   another desktop: the pin names a computer that the lane is no longer on.
 *
 * It reads nothing of its own: the index is filled by reads ADE already makes.
 */
export function useFollowLaneMoves(args: {
  sessionId: string | null;
  laneId: string | null;
  pin: OpenProjectBinding | null;
}): void {
  const { sessionId, laneId } = args;
  const pinTarget = args.pin?.kind === "remote" ? args.pin.targetId : null;
  const { computers } = useAdeCloudLaneComputers();
  // The lane's computer now. Only a cloud lane's chat follows anything.
  const current = laneId ? computers.find((computer) => computer.laneId === laneId) ?? null : null;
  const { snapshot } = useRemoteConnectionSnapshot(Boolean(current && pinTarget));
  // The machine the chat's pin reaches, by its saved connection.
  const pinMachineKey = pinTarget
    ? snapshot?.connections.find((connection) => connection.target.id === pinTarget)?.target.pairedMachine?.machineKey ?? null
    : null;
  const movedTo = current?.machineKey && pinMachineKey && !sameMachineKey(current.machineKey, pinMachineKey)
    ? current.machineKey
    : null;

  useEffect(() => {
    if (!sessionId || !movedTo) return;
    return followSessionToMachine(sessionId, movedTo);
  }, [sessionId, movedTo, pinTarget]);

  useEffect(() => {
    if (!sessionId || !laneId) return;
    let stop: (() => void) | null = null;
    const off = window.ade.cloud?.onLaneMoved?.((move) => {
      if (move.laneId !== laneId || !move.to.machineKey) return;
      stop?.();
      stop = followSessionToMachine(sessionId, move.to.machineKey);
    }) ?? null;
    return () => {
      off?.();
      stop?.();
    };
  }, [sessionId, laneId]);
}
