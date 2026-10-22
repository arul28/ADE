import type { WorkProjectViewState } from "../state/appStore";

export type StartChatDraftPatch = Pick<
  WorkProjectViewState,
  | "draftKind"
  | "draftLaneId"
  | "draftMachineId"
  | "activeItemId"
  | "selectedItemId"
  | "workSidebarOpen"
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

export type WorkViewStateUpdater = (
  projectRoot: string,
  next: WorkProjectViewState | ((prev: WorkProjectViewState) => WorkProjectViewState),
) => void;

export type WorkDraftModelRequest = {
  modelId: string;
  reasoningEffort: string | null;
  permission: string | null;
};

export type WorkDraftLaneRequest = {
  modelRequest: WorkDraftModelRequest | null;
};

/**
 * Point the Work draft at a lane the user named ("New chat in this lane", a
 * PR's chat action), and note the request so the composer shows that lane
 * instead of a restored "Auto-create lane".
 */
export function openStartChatDraft(
  setWorkViewState: WorkViewStateUpdater,
  projectStateKey: string,
  laneId: string,
  machineId: string | null,
  modelRequest?: WorkDraftModelRequest | null,
): void {
  setWorkViewState(projectStateKey, (prev) => ({
    ...prev,
    ...startChatDraftPatch(laneId, machineId),
  }));
  if (laneId) noteWorkDraftLaneRequested(projectStateKey, modelRequest);
}

export function startChatDraftPatch(
  laneId: string,
  machineId: string | null = null,
): StartChatDraftPatch {
  return {
    draftKind: "chat",
    draftLaneId: laneId || null,
    draftMachineId: machineId,
    activeItemId: null,
    selectedItemId: null,
    // New chat has no Tools toggle; close a leftover pane from the previous
    // session instead of leaving it sitting on an empty draft.
    workSidebarOpen: false,
  };
}

/**
 * "New chat in this lane" names a lane, but the Work composer restores its
 * saved draft on open, and that draft can still say "Auto-create lane". This
 * notes, per project, that the next composer to settle must drop that saved
 * target so the named lane shows. Held here, not in a window event alone: the
 * request is made before Work (and its composer) has mounted.
 */
export const WORK_DRAFT_LANE_REQUESTED_EVENT = "ade:work:draft-lane-requested";
const laneRequestsByProject = new Map<string, WorkDraftLaneRequest>();

export function noteWorkDraftLaneRequested(
  projectStateKey: string,
  modelRequest?: WorkDraftModelRequest | null,
): void {
  laneRequestsByProject.set(projectStateKey, { modelRequest: modelRequest ?? null });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WORK_DRAFT_LANE_REQUESTED_EVENT));
  }
}

export function takeWorkDraftLaneRequest(projectStateKey: string | null): WorkDraftLaneRequest | null {
  if (!projectStateKey) return null;
  const request = laneRequestsByProject.get(projectStateKey) ?? null;
  laneRequestsByProject.delete(projectStateKey);
  return request;
}

/** A user's newer destination choice supersedes a pending lane request. */
export function cancelWorkDraftLaneRequest(projectStateKey: string | null): void {
  if (projectStateKey) laneRequestsByProject.delete(projectStateKey);
}
