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
 * A finished helper that an agent launched (its nesting parent, or the
 * `launchedBySessionId` of a `--no-parent` chat) is the launcher's business while
 * the launcher is busy in the same lane: it takes no part in the fold, just like a
 * finished nested row. Once the launcher finishes, its own Done holds the lane out
 * and the helpers hold it out again until the user has looked at them.
 *
 * A finished chat with a scheduled wake still to come is Waiting, not Done: it
 * will start again on its own (a subagent polling CI, a /loop). A parent whose
 * subagent is still busy is Waiting too, because that subagent reports back and
 * wakes it. A wake that came due and never started is Done again and holds its
 * lane out, so a dead scheduler cannot leave a lane folded forever.
 *
 * Pure on purpose: the sidebar hands over plain data and the rules stay
 * testable without mounting a list.
 */
import { isTrackedAgentCliToolType, type TerminalSessionSummary } from "../../../shared/types";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import { scheduledWakeState, sessionTurnStallMs } from "../../../shared/sessionStatusPresentation";
import { canonicalInputFromSummary, sessionCanonicalUiState, type SessionFilingBucket } from "../../lib/terminalAttention";
import type { WorkBoardColumn } from "../../../shared/types/chat";

/** The board's columns, used as a lane's rolled-up status. */
export type WorkLaneFocusStatus = WorkBoardColumn;

type WorkRowFocus = {
  status: WorkLaneFocusStatus;
  /** True when this row alone keeps its lane out of the Working shelf. */
  holdsOut: boolean;
  /**
   * A scheduled wake came due and never started a turn. Unlike an ordinary
   * finished row it holds the lane out even when nested or already seen: the
   * work it promised is not coming on its own.
   */
  missedWake?: boolean;
  /**
   * A chat between turns (ready/idle) with nothing scheduled. Only such a row
   * may be lifted to Waiting by a busy subagent: a failed or stopped parent
   * still needs the user, whatever its subagents are doing.
   */
  resting?: boolean;
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
 * Has the user left this row since it last finished? Seen comes only from the
 * leave stamp (`useWorkSessions`), never from the row being open: a finished
 * row clicked in the inbox must not fold its lane out from under the cursor.
 * Its lane folds once the user moves on.
 */
function isWorkRowSeen(session: TerminalSessionSummary, seenAt: string | null | undefined): boolean {
  if (!seenAt) return false;
  const seenMs = Date.parse(seenAt);
  return Number.isFinite(seenMs) && seenMs >= finishedAtMs(session);
}

/**
 * One row's place in its lane's focus, or null for a snoozed/settled row.
 *
 * `laneWaiting` is the lane's PR wait (CI running or a review requested). It
 * parks a running row in Waiting exactly as the board does.
 */
function workRowFocus(args: {
  session: TerminalSessionSummary;
  filingBucket: SessionFilingBucket | null | undefined;
  laneWaiting: boolean;
  seen: boolean;
  nowMs?: number;
}): WorkRowFocus | null {
  if (args.filingBucket === "snoozed" || args.filingBucket === "settled") return null;
  const phase = sessionCanonicalUiState(canonicalInputFromSummary(args.session)).phase;
  switch (phase) {
    case "needs_you":
      return { status: "needs_you", holdsOut: true };
    case "starting":
    case "running":
      // A live turn that went silent with no open work may be stuck. It stays
      // filed as running, but like a stale run it holds its lane out of the
      // fold, so the user sees it instead of trusting a dead "Working".
      if (sessionTurnStallMs(args.session, args.nowMs) !== null) return { status: "working", holdsOut: true };
      return { status: args.laneWaiting ? "waiting" : "working", holdsOut: false };
    case "stale":
      // Still filed as running, but a run that stopped producing output may be
      // stuck. Hiding it is the one way this mode could make things worse.
      return { status: "working", holdsOut: true };
    case "settled":
      return null;
    case "ready":
    case "idle": {
      const wake = scheduledWakeState(args.session.nextWakeAt, args.nowMs);
      if (wake === "pending") return { status: "waiting", holdsOut: false };
      if (wake === "overdue") return { status: "done", holdsOut: true, missedWake: true };
      return { status: "done", holdsOut: !args.seen, resting: true };
    }
    default:
      // failed / stopped / ended: the turn is over. It holds the
      // lane out until the user has looked at it since it finished.
      return { status: "done", holdsOut: !args.seen };
  }
}

/** Agent chats and tracked agent CLIs; plain shells are not agents. */
function isAgentSession(session: TerminalSessionSummary): boolean {
  return isChatToolType(session.toolType) || isTrackedAgentCliToolType(session.toolType);
}

/**
 * The chat that launched a row: its nesting parent, else the agent that started
 * it with `--no-parent`. A peer carries only the parent id and is not nested, but
 * the agent still launched it.
 */
function launcherSessionId(session: TerminalSessionSummary): string | null {
  return session.orchestrationParentSessionId?.trim() || session.launchedBySessionId?.trim() || null;
}

type LaneFocusInputs = {
  filingBuckets: ReadonlyMap<string, SessionFilingBucket>;
  laneWaiting: boolean;
  busySubagentParentIds?: ReadonlySet<string>;
  nowMs?: number;
};

/**
 * One row's focus inside its lane, or null when it takes no part. A finished
 * nested row is null; a resting parent that a busy subagent keeps busy is Waiting.
 * A missed wake is never dropped.
 */
function laneRowFocus(
  session: TerminalSessionSummary,
  nested: boolean,
  seen: boolean,
  inputs: LaneFocusInputs,
): WorkRowFocus | null {
  const row = workRowFocus({
    session,
    filingBucket: inputs.filingBuckets.get(session.id),
    laneWaiting: inputs.laneWaiting,
    seen,
    nowMs: inputs.nowMs,
  });
  if (!row || row.status !== "done" || row.missedWake) return row;
  if (nested) return null;
  if (row.resting && inputs.busySubagentParentIds?.has(session.id)) return { status: "waiting", holdsOut: false };
  return row;
}

/**
 * Pass one of the launcher rule over a lane's roster: the ids of its busy agent
 * rows. Busy is Working or Waiting, not holding out, and an agent chat or CLI.
 * Busy never depends on `seen`, and a busy row is never finished, so this set is
 * the same whether or not the pass-two skip has run.
 */
function busyAgentSessionIds(
  sessions: readonly TerminalSessionSummary[],
  nestedSessionIds: ReadonlySet<string>,
  inputs: LaneFocusInputs,
): Set<string> {
  const busy = new Set<string>();
  for (const session of sessions) {
    const row = laneRowFocus(session, nestedSessionIds.has(session.id), false, inputs);
    if (row && !row.holdsOut && (row.status === "working" || row.status === "waiting") && isAgentSession(session)) {
      busy.add(session.id);
    }
  }
  return busy;
}

/**
 * A finished row (not a missed wake) whose launcher is a different busy agent in
 * the same lane. Such a helper is skipped the way a finished nested row is: the
 * launcher still owns the lane's focus.
 */
function deferredToBusyLauncher(
  session: TerminalSessionSummary,
  row: WorkRowFocus,
  busyIds: ReadonlySet<string>,
): boolean {
  if (row.status !== "done" || row.missedWake) return false;
  const launcher = launcherSessionId(session);
  return launcher !== null && launcher !== session.id && busyIds.has(launcher);
}

export type WorkLaneFocus = {
  /** Highest-priority status among the lane's live rows; null when it has none. */
  status: WorkLaneFocusStatus | null;
  /** Whether the lane belongs in the Working shelf (pins and primary aside). */
  folds: boolean;
};

export const EMPTY_WORK_SEEN_AT: Readonly<Record<string, string>> = {};

/**
 * One lane's focus from its full roster.
 *
 * It folds when every live row is busy (Working/Waiting) or already-seen Done,
 * and at least one is actually busy: a lane holding only finished rows is not
 * working, it is waiting to be settled. Only agent rows count as busy: a plain
 * shell (a dev server, an App Control shell) can run forever, so it must not
 * keep a lane folded once its chat is done. `launching` counts launches with
 * no session row yet, which are busy by definition.
 *
 * Nested rows (attached shells, subagents) can raise a hand and so hold their
 * lane out, but a finished nested row cannot: nobody opens a helper to mark it
 * seen, so it would pin the lane open forever. A missed wake is the exception.
 *
 * A finished helper the agent launched (`launcherSessionId`) is skipped the same
 * way while that launcher is a busy agent in this lane. A raised hand, a stale
 * run, or a missed wake from a helper still holds the lane out; a chat the user
 * started has no launcher and is unaffected; a launcher in another lane does not
 * count. The launcher is checked one level up only.
 *
 * `busySubagentParentIds` names the chats a nested subagent still keeps busy
 * (`parentsWithBusySubagents`, the same set the row label reads). Such a
 * finished parent is Waiting rather than Done: the subagent wakes it when its
 * turn ends, so its real Done is still to come.
 */
export function summarizeLaneFocus(args: {
  sessions: readonly TerminalSessionSummary[];
  filingBuckets: ReadonlyMap<string, SessionFilingBucket>;
  laneWaiting: boolean;
  seenAtBySessionId: Readonly<Record<string, string>>;
  nestedSessionIds: ReadonlySet<string>;
  busySubagentParentIds?: ReadonlySet<string>;
  launching?: number;
  /** The clock for the stall and wake rules; the caller re-runs this when a deadline passes. */
  nowMs?: number;
}): WorkLaneFocus {
  const launching = args.launching ?? 0;
  let status: WorkLaneFocusStatus | null = launching > 0 ? "working" : null;
  let busy = launching;
  let heldOut = false;
  const inputs: LaneFocusInputs = {
    filingBuckets: args.filingBuckets,
    laneWaiting: args.laneWaiting,
    busySubagentParentIds: args.busySubagentParentIds,
    nowMs: args.nowMs,
  };
  // Pass one finds the busy agents; pass two skips the helpers they launched.
  const busyIds = busyAgentSessionIds(args.sessions, args.nestedSessionIds, inputs);
  for (const session of args.sessions) {
    const row = laneRowFocus(
      session,
      args.nestedSessionIds.has(session.id),
      isWorkRowSeen(session, args.seenAtBySessionId[session.id]),
      inputs,
    );
    if (!row) continue;
    if (deferredToBusyLauncher(session, row, busyIds)) continue;
    if (status === null || STATUS_RANK[row.status] < STATUS_RANK[status]) status = row.status;
    if (row.holdsOut) heldOut = true;
    else if ((row.status === "working" || row.status === "waiting") && isAgentSession(session)) busy += 1;
  }
  return { status, folds: !heldOut && busy > 0 };
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

/**
 * The chats the Focus grid shows: every agent chat that waits for the user,
 * from every lane Focus left unfolded.
 *
 * Built from the same per-row rule as the fold, so the grid and the sidebar
 * cannot disagree: a lane is unfolded exactly because one of these rows holds
 * it out. A Working or Waiting row stays out of the grid even when its lane is
 * unfolded; the sidebar still shows it, which is where the user sees why it is
 * not a tile. Plain shells are not agents and never get a tile. A nested row
 * (subagent, attached shell) gets a tile only while it asks for the user; a
 * finished one is the parent's business. A finished helper whose launcher is
 * busy in its lane (`summarizeLaneFocus`) gets no tile either, so the grid and
 * the sidebar agree.
 */
export function workFocusQueue(args: {
  sessions: readonly TerminalSessionSummary[];
  filingBuckets: ReadonlyMap<string, SessionFilingBucket>;
  foldedLaneIds: ReadonlySet<string>;
  laneWaiting: (laneId: string) => boolean;
  nestedSessionIds: ReadonlySet<string>;
  /** Same set as `summarizeLaneFocus`: a parent kept busy by a subagent gets no tile. */
  busySubagentParentIds?: ReadonlySet<string>;
  nowMs?: number;
}): string[] {
  const busyIdsByLane = new Map<string, ReadonlySet<string>>();
  const busyIdsForLane = (laneId: string): ReadonlySet<string> => {
    let busyIds = busyIdsByLane.get(laneId);
    if (!busyIds) {
      busyIds = busyAgentSessionIds(
        args.sessions.filter((session) => session.laneId === laneId),
        args.nestedSessionIds,
        {
          filingBuckets: args.filingBuckets,
          laneWaiting: args.laneWaiting(laneId),
          busySubagentParentIds: args.busySubagentParentIds,
          nowMs: args.nowMs,
        },
      );
      busyIdsByLane.set(laneId, busyIds);
    }
    return busyIds;
  };
  const ids: string[] = [];
  for (const session of args.sessions) {
    if (args.foldedLaneIds.has(session.laneId)) continue;
    if (!isAgentSession(session)) continue;
    const nested = args.nestedSessionIds.has(session.id);
    const row = laneRowFocus(session, nested, false, {
      filingBuckets: args.filingBuckets,
      laneWaiting: args.laneWaiting(session.laneId),
      busySubagentParentIds: args.busySubagentParentIds,
      nowMs: args.nowMs,
    });
    if (!row) continue;
    if (row.status === "needs_you") {
      ids.push(session.id);
      continue;
    }
    if (row.missedWake) {
      ids.push(session.id);
      continue;
    }
    if (nested) continue;
    if (deferredToBusyLauncher(session, row, busyIdsForLane(session.laneId))) continue;
    // A stale or stalled run is filed as working but holds its lane out: it
    // may be stuck, so the user is the one who has to look.
    if (row.status === "done" || (row.status === "working" && row.holdsOut)) ids.push(session.id);
  }
  return ids;
}
