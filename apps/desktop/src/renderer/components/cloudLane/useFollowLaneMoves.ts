import { useEffect, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { followSessionToMachine } from "../../lib/otherMachineNavigation";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { sameMachineKey } from "../../../shared/machineAddress";
import { savedChatsMachineKey } from "../../../shared/cloudSavedChats";

/**
 * Contract C3 for an open chat: when its cloud lane's computer changes (a
 * move, a new computer), the chat follows. Same chat id, same lane id; the
 * pin, and with it the Android panel and tools, move to the new computer.
 *
 * Two ways it notices:
 * - the move event (`window.ade.cloud.onLaneMoved`), live;
 * - the lane index, for a move made while this window was closed or on
 *   another desktop: the pin names a computer that the lane is no longer on,
 *   or a connection this desktop has since forgotten.
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
  // Only a chat on a cloud lane listens for moves.
  const isCloudLane = current != null;
  // A saved chat's stand-in pin (`cloud-saved:<machine key>`) names its machine itself.
  const standInKey = savedChatsMachineKey(pinTarget);
  const { snapshot, loaded } = useRemoteConnectionSnapshot(Boolean(current && pinTarget && !standInKey));
  // The machine the chat's pin reaches, by its saved connection.
  const pinConnection = pinTarget && !standInKey
    ? snapshot?.connections.find((connection) => connection.target.id === pinTarget) ?? null
    : null;
  const pinMachineKey = standInKey ?? pinConnection?.target.pairedMachine?.machineKey ?? null;
  // The snapshot lists every saved connection: a pin to one it no longer has
  // (forgotten when the lane moved, before this pane mounted) reaches nothing,
  // so the lane's computer now is where the chat goes.
  const pinGone = Boolean(pinTarget && !standInKey && loaded && snapshot && !pinConnection);
  const movedTo = current?.machineKey && (pinGone || (pinMachineKey && !sameMachineKey(current.machineKey, pinMachineKey)))
    ? current.machineKey
    : null;

  // The live move event names the new computer before the index is read again.
  const [eventTo, setEventTo] = useState<string | null>(null);
  useEffect(() => {
    setEventTo(null);
    if (!sessionId || !laneId || !isCloudLane) return;
    return window.ade.cloud?.onLaneMoved?.((move) => {
      if (move.laneId === laneId && move.to.machineKey) setEventTo(move.to.machineKey);
    }) ?? undefined;
  }, [sessionId, laneId, isCloudLane]);

  // One follow per move, whichever told first.
  const followTo = movedTo ?? (eventTo && !sameMachineKey(eventTo, pinMachineKey) ? eventTo : null);
  useEffect(() => {
    if (!sessionId || !followTo) return;
    // Looking at a moved chat opens no connection: its computer may sleep.
    return followSessionToMachine(sessionId, followTo, { connect: false });
  }, [sessionId, followTo]);
}
