import type { WorkProjectViewState } from "../state/appStore";

export type StartChatDraftPatch = Pick<
  WorkProjectViewState,
  "draftKind" | "orchestratorEnabled" | "draftLaneId" | "activeItemId" | "selectedItemId"
>;

export function startChatDraftPatch(laneId: string): StartChatDraftPatch {
  return {
    draftKind: "chat",
    orchestratorEnabled: false,
    draftLaneId: laneId,
    activeItemId: null,
    selectedItemId: null,
  };
}
