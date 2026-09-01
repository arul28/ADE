import type { WorkProjectViewState } from "../state/appStore";

export type StartChatDraftPatch = Pick<
  WorkProjectViewState,
  | "draftKind"
  | "orchestratorEnabled"
  | "draftLaneId"
  | "draftMachineId"
  | "activeItemId"
  | "selectedItemId"
>;

/**
 * Persist a foreign machine id on the Work draft. The tab's bound machine is
 * represented as `null` so `WorkStartSurface` keeps reading the local lane list.
 */
export function chatDraftMachineId(
  machineId: string | null | undefined,
  boundMachineId: string,
): string | null {
  const trimmed = machineId?.trim() || null;
  if (!trimmed || trimmed === boundMachineId) return null;
  return trimmed;
}

export function startChatDraftPatch(
  laneId: string,
  machineId: string | null = null,
): StartChatDraftPatch {
  return {
    draftKind: "chat",
    orchestratorEnabled: false,
    draftLaneId: laneId,
    draftMachineId: machineId,
    activeItemId: null,
    selectedItemId: null,
  };
}
