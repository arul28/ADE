import { useMemo } from "react";
import type { AgentChatCrossMachineHandoffMachineOption } from "../../../shared/types";
import { isAdeCloudComputer, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { BRAND } from "../../../shared/brand";

/**
 * Why the move pickers show ADE Cloud as a disabled row. A lane moves only
 * onto a computer that is already on, and ADE Cloud makes a new computer per
 * lane. Same sentence as the iOS `LaneMoveSheet`.
 */
export const ADE_CLOUD_MOVE_UNAVAILABLE_SENTENCE = `${BRAND.CLOUD_NAME} can't take a moved lane yet. Pick one of your computers.`;

type CloudIndex = Parameters<typeof isAdeCloudComputer>[1];

/**
 * The move targets a person may pick: the brain's list without the account's
 * ADE Cloud computers. The brain still lists them (older clients read the
 * full list); a single cloud computer never shows in the UI.
 */
export function ownMoveMachines(
  machines: readonly AgentChatCrossMachineHandoffMachineOption[],
  index?: CloudIndex,
): AgentChatCrossMachineHandoffMachineOption[] {
  return machines.filter((machine) => !isAdeCloudComputer({ machineKey: machine.machineKey }, index));
}

/** `ownMoveMachines` on the cloud index this component subscribes to (no fetch, no timer). */
export function useOwnMoveMachines(
  machines: readonly AgentChatCrossMachineHandoffMachineOption[] | null | undefined,
): AgentChatCrossMachineHandoffMachineOption[] | null {
  const cloudIndex = useAdeCloudLaneComputers();
  return useMemo(() => (machines ? ownMoveMachines(machines, cloudIndex) : null), [machines, cloudIndex]);
}
