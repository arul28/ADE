import type { WorkGridSet } from "../state/appStore";

/**
 * Pure helpers for Cursor-style work grids. A grid set is a group of chat/CLI
 * sessions sharing the work area in a resizable split. Membership lives in
 * `WorkGridSet.sessionIds`; the split geometry persists separately under
 * `layoutId` via `window.ade.tilingTree`. A session is in at most one set, and a
 * set always has >= 2 members (a set that drops to 1 dissolves back to single
 * view).
 */

export const GRID_SESSION_DND_MIME = "application/x-ade-grid-session";

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function makeGridSetId(): string {
  return `grid_${randomId()}`;
}

/** Stable per-grid-set tiling-tree layout id (scoped to the project). */
export function makeGridLayoutId(projectRoot: string | null | undefined, gridSetId: string): string {
  return `work:grid:v2:${projectRoot ?? "global"}:${gridSetId}`;
}

export function findGridSetForSession(
  gridSets: readonly WorkGridSet[],
  sessionId: string | null | undefined,
): WorkGridSet | null {
  if (!sessionId) return null;
  for (const set of gridSets) {
    if (set.sessionIds.includes(sessionId)) return set;
  }
  return null;
}

export function isSessionInAnyGrid(
  gridSets: readonly WorkGridSet[],
  sessionId: string | null | undefined,
): boolean {
  return findGridSetForSession(gridSets, sessionId) != null;
}

/** Remove a session from whatever grid set it's in; dissolve sets < 2 members. */
export function removeSessionFromGrids(
  gridSets: readonly WorkGridSet[],
  sessionId: string,
): WorkGridSet[] {
  const out: WorkGridSet[] = [];
  for (const set of gridSets) {
    if (!set.sessionIds.includes(sessionId)) {
      out.push(set);
      continue;
    }
    const remaining = set.sessionIds.filter((id) => id !== sessionId);
    // A grid needs >= 2 members; the lone survivor returns to single view.
    if (remaining.length >= 2) {
      out.push({ ...set, sessionIds: remaining });
    }
  }
  return out;
}

/**
 * Add `sessionId` next to `targetSessionId`.
 * - If the target already belongs to a grid set, the session joins that set.
 * - Otherwise a brand-new grid set is created from the pair.
 * The session is first detached from any prior set. No-ops if already grouped
 * with the target.
 *
 * Returns the new gridSets array plus the id of the set the session landed in.
 */
export function addSessionBesideTarget(
  gridSets: readonly WorkGridSet[],
  params: {
    sessionId: string;
    targetSessionId: string;
    projectRoot: string | null | undefined;
    /** Insert before/after the target within the set's membership order. */
    placeAfterTarget?: boolean;
  },
): { gridSets: WorkGridSet[]; gridSetId: string } {
  const { sessionId, targetSessionId, projectRoot, placeAfterTarget = true } = params;
  if (sessionId === targetSessionId) {
    const existing = findGridSetForSession(gridSets, targetSessionId);
    return { gridSets: [...gridSets], gridSetId: existing?.id ?? makeGridSetId() };
  }

  // Detach the dragged session from any set it currently lives in.
  const detached = removeSessionFromGrids(gridSets, sessionId);
  const targetSet = findGridSetForSession(detached, targetSessionId);

  if (targetSet) {
    const next = detached.map((set) => {
      if (set.id !== targetSet.id) return set;
      const base = set.sessionIds.filter((id) => id !== sessionId);
      const idx = base.indexOf(targetSessionId);
      const insertAt = idx < 0 ? base.length : idx + (placeAfterTarget ? 1 : 0);
      const sessionIds = [...base.slice(0, insertAt), sessionId, ...base.slice(insertAt)];
      return { ...set, sessionIds };
    });
    return { gridSets: next, gridSetId: targetSet.id };
  }

  // Target is single — create a new grid set from the pair.
  const id = makeGridSetId();
  const layoutId = makeGridLayoutId(projectRoot, id);
  const sessionIds = placeAfterTarget
    ? [targetSessionId, sessionId]
    : [sessionId, targetSessionId];
  return { gridSets: [...detached, { id, layoutId, sessionIds }], gridSetId: id };
}
