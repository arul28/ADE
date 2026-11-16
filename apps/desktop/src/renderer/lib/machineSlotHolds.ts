import { useEffect } from "react";
import type { OpenProjectBinding } from "../../shared/types";

/**
 * Computers the user is looking at right now: a visible chat or CLI pane whose
 * session lives there holds that computer's connection slot. ADE Web keeps at
 * most a fixed number of computers connected; when a new one needs a slot it
 * parks the least recently used computer that nothing holds, never the one
 * under an open chat, its draft or its running turn.
 *
 * Holds are counted, so two panes on one computer release it only when both
 * close. The time a computer was last held counts as use, so a computer whose
 * chat was open a moment ago is not the first to go.
 */
const holdCounts = new Map<string, number>();
const lastHeldAt = new Map<string, number>();

export function holdMachineSlot(targetId: string): () => void {
  holdCounts.set(targetId, (holdCounts.get(targetId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lastHeldAt.set(targetId, Date.now());
    const remaining = (holdCounts.get(targetId) ?? 1) - 1;
    if (remaining > 0) holdCounts.set(targetId, remaining);
    else holdCounts.delete(targetId);
  };
}

export function isMachineSlotHeld(targetId: string): boolean {
  return (holdCounts.get(targetId) ?? 0) > 0;
}

/** When a pane last let go of this computer; 0 when none ever held it. */
export function machineSlotLastHeldAt(targetId: string): number {
  return lastHeldAt.get(targetId) ?? 0;
}

/**
 * Holds the slot of the computer a visible pane's session lives on. Keyed on
 * the computer, so a rebuilt pin for the same copy keeps one hold.
 */
export function useMachineSlotHold(pin: OpenProjectBinding | null | undefined, visible: boolean): void {
  const targetId = pin?.kind === "remote" ? pin.targetId : null;
  useEffect(() => {
    if (!visible || !targetId) return;
    return holdMachineSlot(targetId);
  }, [targetId, visible]);
}
