import type {
  DevinCloudFleetStatus,
  DevinCloudMode,
  DevinCloudSessionSummary,
} from "./types/config";

/**
 * Canonical Devin fleet-row status logic, shared by the main-process fleet
 * service and the renderer so section placement, Stop-button visibility, and
 * filter results can never drift between layers.
 *
 * Devin reports a coarse `status` plus a `status_detail`. The detail carries
 * the attention signal ADE cares about: `waiting_for_user` and
 * `waiting_for_approval` are the two loud states — a session that needs the
 * human must not sit quietly in a fleet row.
 */
export function devinCloudFleetStatus(
  session: Pick<DevinCloudSessionSummary, "status" | "statusDetail" | "isArchived">,
): DevinCloudFleetStatus {
  if (session.isArchived) return "archived";
  const status = session.status?.toLowerCase() ?? "";
  const detail = session.statusDetail?.toLowerCase() ?? "";
  if (status === "error" || detail === "error") return "error";
  if (status === "exit" || detail === "finished") return "finished";
  if (status === "suspended") return "suspended";
  if (detail === "waiting_for_user" || detail === "waiting_for_approval") {
    return "needs_you";
  }
  if (status === "running") return "working";
  // new / claimed / resuming — the VM is coming up or the first turn has not
  // landed yet.
  return "starting";
}

/** True when the session is still doing something (or wants the human). */
export function isDevinCloudSessionActive(
  session: Pick<DevinCloudSessionSummary, "status" | "statusDetail" | "isArchived">,
): boolean {
  const status = devinCloudFleetStatus(session);
  return status === "starting" || status === "working" || status === "needs_you";
}

/** True when the row should surface in the loud "Needs you" tier. */
export function devinCloudSessionNeedsYou(
  session: Pick<DevinCloudSessionSummary, "status" | "statusDetail" | "isArchived">,
): boolean {
  return devinCloudFleetStatus(session) === "needs_you";
}

/** Display string: archived wins over run state. */
export function devinCloudFleetDisplayStatus(
  session: Pick<DevinCloudSessionSummary, "status" | "statusDetail" | "isArchived">,
): DevinCloudFleetStatus {
  return devinCloudFleetStatus(session);
}

/** Coerce a persisted/create-time devin_mode value; unknown → null. */
export function normalizeDevinCloudMode(value: unknown): DevinCloudMode | null {
  return value === "normal" || value === "fast" || value === "lite"
    || value === "ultra" || value === "fusion"
    ? value
    : null;
}

// ---------------------------------------------------------------------------
// Provenance tags
// ---------------------------------------------------------------------------

/**
 * Tag stamped on every session ADE creates so the fleet can badge "via ADE"
 * rows and filter From ADE, and so pull/continue can find the owning lane.
 */
export const DEVIN_CLOUD_ADE_TAG = "ade";
export const DEVIN_CLOUD_LANE_TAG_PREFIX = "ade:lane:";
export const DEVIN_CLOUD_PROJECT_TAG_PREFIX = "ade:project:";
export const DEVIN_CLOUD_SESSION_TAG_PREFIX = "ade:session:";

export function devinCloudAdeLaneId(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith(DEVIN_CLOUD_LANE_TAG_PREFIX)) {
      const id = tag.slice(DEVIN_CLOUD_LANE_TAG_PREFIX.length).trim();
      if (id) return id;
    }
  }
  return null;
}

export function devinCloudAdeSessionTag(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith(DEVIN_CLOUD_SESSION_TAG_PREFIX)) {
      const id = tag.slice(DEVIN_CLOUD_SESSION_TAG_PREFIX.length).trim();
      if (id) return id;
    }
  }
  return null;
}

export function devinCloudCreatedViaAde(tags: readonly string[]): boolean {
  return tags.includes(DEVIN_CLOUD_ADE_TAG);
}

export function buildDevinCloudAdeTags(args: {
  laneId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  extra?: readonly string[];
}): string[] {
  const tags = new Set<string>([DEVIN_CLOUD_ADE_TAG]);
  if (args.laneId?.trim()) tags.add(`${DEVIN_CLOUD_LANE_TAG_PREFIX}${args.laneId.trim()}`);
  if (args.projectId?.trim()) tags.add(`${DEVIN_CLOUD_PROJECT_TAG_PREFIX}${args.projectId.trim()}`);
  if (args.sessionId?.trim()) tags.add(`${DEVIN_CLOUD_SESSION_TAG_PREFIX}${args.sessionId.trim()}`);
  for (const extra of args.extra ?? []) {
    const trimmed = extra.trim();
    if (trimmed) tags.add(trimmed);
  }
  return [...tags];
}
