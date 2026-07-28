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

export function startChatDraftPatch(laneId: string): StartChatDraftPatch {
  return {
    draftKind: "chat",
    orchestratorEnabled: false,
    draftLaneId: laneId,
    draftMachineId: null,
    activeItemId: null,
    selectedItemId: null,
  };
}
