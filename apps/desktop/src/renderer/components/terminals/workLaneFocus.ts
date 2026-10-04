/**
 * Lane focus for the Work sidebar: one status per lane, and the "fold busy
 * lanes" rule that moves a lane into the Working shelf while nothing in it is
 * waiting on the user.
 *
 * A lane's status is rolled up from its rows in the Work board's column
 * vocabulary — Needs you > Working > Waiting > Done — so the lane header and
 * the board can never name different states for the same work. Snoozed and
 * settled rows do not take part: they already have their own shelves.
 *
 * Folding is a different question from the badge. A lane folds only when every
 * live row is Working or Waiting, or Done in a way the user has already seen.
 * A raised hand, a stale run, or a finished turn nobody has looked at keeps the
 * whole lane out, with every row still visible, so the user sees the context of
 * the thing asking for them.
 *
 * Pure on purpose: the sidebar hands over plain data and the rules stay
 * testable without mounting a list.
 */
import type { TerminalSessionSummary } from "../../../shared/types";
import { canonicalInputFromSummary, sessionCanonicalUiState, type SessionFilingBucket } from "../../lib/terminalAttention";
import type { WorkBoardColumn } from "../../../shared/types/chat";

/** The board's columns, used as a lane's rolled-up status. */
export type WorkLaneFocusStatus = WorkBoardColumn;

export type WorkRowFocus = {
  status: WorkLaneFocusStatus;
  /** True when this row alone keeps its lane out of the Working shelf. */
  holdsOut: boolean;
};

const STATUS_RANK: Record<WorkLaneFocusStatus, number> = {
  needs_you: 0,
  working: 1,
  waiting: 2,
  done: 3,
};

/**
 * When a finished row last changed, which is the moment a later view has to
 * beat for the row to count as seen. Falls back to `startedAt` so a row with no
 * recorded activity still compares against something real.
 */
function finishedAtMs(session: TerminalSessionSummary): number {
  let latest = Date.parse(session.startedAt);
  for (const value of [session.lastActivityAt, session.endedAt, session.activityStatusChangedAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && (!Number.isFinite(latest) || parsed > latest)) latest = parsed;
  }
  return Number.isFinite(latest) ? latest : 0;
}

/**
 * Has the user looked at this row since it last finished? The open row always
 * counts as seen: the user is looking at it right now.
 */
export function isWorkRowSeen(args: {
  session: TerminalSessionSummary;
  seenAt: string | null | undefined;
  selected: boolean;
}): boolean {
  if (args.selected) return true;
  if (!args.seenAt) return false;
  const seenMs = Date.parse(args.seenAt);
  return Number.isFinite(seenMs) && seenMs >= finishedAtMs(args.session);
}

/**
 * One row's place in its lane's focus, or null for a snoozed/settled row.
 *
 * `laneWaiting` is the lane's PR wait (CI running or a review requested). It
 * parks a running row in Waiting exactly as the board does.
 */
export function workRowFocus(args: {
  session: TerminalSessionSummary;
  filingBucket: SessionFilingBucket | null | undefined;
  laneWaiting: boolean;
  seen: boolean;
}): WorkRowFocus | null {
  if (args.filingBucket === "snoozed" || args.filingBucket === "settled") return null;
  const phase = sessionCanonicalUiState(canonicalInputFromSummary(args.session)).phase;
  switch (phase) {
    case "needs_you":
      return { status: "needs_you", holdsOut: true };
    case "starting":
    case "running":
      return { status: args.laneWaiting ? "waiting" : "working", holdsOut: false };
    case "stale":
      // Still filed as running, but a run that stopped producing output may be
      // stuck. Hiding it is the one way this mode could make things worse.
      return { status: "working", holdsOut: true };
    case "settled":
      return null;
    default:
      // ready / idle / failed / stopped / ended: the turn is over. It holds the
      // lane out until the user has looked at it since it finished.
      return { status: "done", holdsOut: !args.seen };
  }
}

/** Highest-priority status among a lane's live rows, or null when it has none. */
export function rollUpLaneFocusStatus(
  rows: readonly (WorkRowFocus | null)[],
  extraWorking = 0,
): WorkLaneFocusStatus | null {
  let best: WorkLaneFocusStatus | null = extraWorking > 0 ? "working" : null;
  for (const row of rows) {
    if (!row) continue;
    if (best === null || STATUS_RANK[row.status] < STATUS_RANK[best]) best = row.status;
  }
  return best;
}

/**
 * Should this lane fold into the Working shelf?
 *
 * Every live row must be busy (Working/Waiting) or already-seen Done, and at
 * least one must actually be busy: a lane holding only finished rows is not
 * working, it is waiting to be settled. `extraWorking` counts launches that
 * have no session row yet.
 */
export function laneFoldsIntoWorking(
  rows: readonly (WorkRowFocus | null)[],
  extraWorking = 0,
): boolean {
  let busy = extraWorking;
  for (const row of rows) {
    if (!row) continue;
    if (row.holdsOut) return false;
    if (row.status === "working" || row.status === "waiting") busy += 1;
  }
  return busy > 0;
}

/**
 * Lanes that came back out of the Working shelf, newest return first.
 *
 * The first observation only records which lanes are folded, so opening the
 * sidebar never reshuffles it. After that, a lane that leaves the fold gets a
 * return time, and a lane that folds again loses it.
 */
export type WorkLaneReturnState = {
  folded: ReadonlySet<string>;
  returnedAtMs: ReadonlyMap<string, number>;
  initialized: boolean;
};

export const EMPTY_WORK_LANE_RETURN_STATE: WorkLaneReturnState = {
  folded: new Set(),
  returnedAtMs: new Map(),
  initialized: false,
};

export function nextWorkLaneReturnState(
  previous: WorkLaneReturnState,
  foldedNow: ReadonlySet<string>,
  presentLaneIds: ReadonlySet<string>,
  nowMs: number,
): WorkLaneReturnState {
  if (!previous.initialized) {
    return { folded: new Set(foldedNow), returnedAtMs: new Map(), initialized: true };
  }
  let changed = false;
  const returnedAtMs = new Map(previous.returnedAtMs);
  for (const laneId of previous.folded) {
    if (!foldedNow.has(laneId) && presentLaneIds.has(laneId)) {
      returnedAtMs.set(laneId, nowMs);
      changed = true;
    }
  }
  for (const laneId of foldedNow) {
    if (returnedAtMs.delete(laneId)) changed = true;
  }
  for (const laneId of returnedAtMs.keys()) {
    if (!presentLaneIds.has(laneId)) {
      returnedAtMs.delete(laneId);
      changed = true;
    }
  }
  const foldedChanged = foldedNow.size !== previous.folded.size
    || [...foldedNow].some((laneId) => !previous.folded.has(laneId));
  if (!changed && !foldedChanged) return previous;
  return { folded: new Set(foldedNow), returnedAtMs, initialized: true };
}

/**
 * Float returned lanes to the front of their own run, newest return first,
 * leaving every other lane in the order it already had. `canFloat` names the
 * lanes allowed to move (the active tier): the primary lane and pins keep
 * their fixed places above.
 */
export function floatReturnedLanes<T extends { id: string }>(
  ordered: readonly T[],
  returnedAtMs: ReadonlyMap<string, number>,
  canFloat: (lane: T) => boolean,
): T[] {
  if (returnedAtMs.size === 0) return [...ordered];
  const firstFloatable = ordered.findIndex(canFloat);
  if (firstFloatable === -1) return [...ordered];
  const returned = ordered
    .filter((lane) => canFloat(lane) && returnedAtMs.has(lane.id))
    .sort((a, b) => (returnedAtMs.get(b.id) ?? 0) - (returnedAtMs.get(a.id) ?? 0));
  if (returned.length === 0) return [...ordered];
  const returnedIds = new Set(returned.map((lane) => lane.id));
  const rest = ordered.filter((lane) => !returnedIds.has(lane.id));
  const insertAt = rest.findIndex(canFloat);
  const at = insertAt === -1 ? rest.length : insertAt;
  return [...rest.slice(0, at), ...returned, ...rest.slice(at)];
}

/** Keep the persisted seen map bounded: newest entries win. */
export const WORK_SEEN_AT_LIMIT = 400;

export function stampWorkSeenAt(
  previous: Readonly<Record<string, string>>,
  sessionIds: readonly string[],
  at: string,
): Record<string, string> {
  const next: Record<string, string> = { ...previous };
  for (const id of sessionIds) {
    if (!id) continue;
    delete next[id];
    next[id] = at;
  }
  const keys = Object.keys(next);
  if (keys.length <= WORK_SEEN_AT_LIMIT) return next;
  const trimmed: Record<string, string> = {};
  for (const key of keys.slice(keys.length - WORK_SEEN_AT_LIMIT)) trimmed[key] = next[key]!;
  return trimmed;
}
