/**
 * Which lanes' App Control screencast frames something shows. A lane's
 * screencast streams only while a window, a sync viewer or a recording wants
 * it; see `AppControlService.setFrameDemand`.
 */
export type AppControlFrameDemand = readonly string[] | "all";

/** The key of a window hold that admits every lane (`holdFrames()` with no lane). */
export const APP_CONTROL_FRAME_ALL_LANES = "*";

/** Params of the brain's `appControl.setFrameDemand`: one connection's demand in one project. */
export type AppControlSetFrameDemandParams =
  & { projectId: string }
  & ({ all: true } | { laneIds: string[] });

export function appControlFrameDemandParams(
  projectId: string,
  demand: AppControlFrameDemand,
): AppControlSetFrameDemandParams {
  return demand === "all" ? { projectId, all: true } : { projectId, laneIds: [...demand] };
}

/** The demand an `appControl.setFrameDemand` call carries. Malformed lane lists count as none. */
export function readAppControlFrameDemand(params: Record<string, unknown>): AppControlFrameDemand {
  if (params.all === true) return "all";
  if (!Array.isArray(params.laneIds)) return [];
  return params.laneIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

/** The lane a screencast `frame` event belongs to: the event's own, else the frame's. */
export function appControlFrameEventLaneId(event: {
  laneId?: string | null;
  frame?: { laneId?: string | null } | null;
}): string | null {
  return event.laneId ?? event.frame?.laneId ?? null;
}
