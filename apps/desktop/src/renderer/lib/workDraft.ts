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

export function startChatDraftPatch(
  laneId: string,
  machineId: string | null = null,
): StartChatDraftPatch {
  return {
    draftKind: "chat",
    draftLaneId: laneId,
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
const LANE_REQUEST_MAX_AGE_MS = 30_000;
const laneRequestedAtByProject = new Map<string, number>();

export function noteWorkDraftLaneRequested(projectStateKey: string): void {
  laneRequestedAtByProject.set(projectStateKey, Date.now());
  window.dispatchEvent(new CustomEvent(WORK_DRAFT_LANE_REQUESTED_EVENT));
}

export function takeWorkDraftLaneRequest(projectStateKey: string | null): boolean {
  if (!projectStateKey) return false;
  const requestedAt = laneRequestedAtByProject.get(projectStateKey);
  if (requestedAt == null) return false;
  laneRequestedAtByProject.delete(projectStateKey);
  return Date.now() - requestedAt <= LANE_REQUEST_MAX_AGE_MS;
}
