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
 * Folding is a different question from the badge. A lane folds when it has live
 * work and no row that actually needs the user. A raised hand, a stale run, a
 * missed wake, or a failure nobody has acknowledged keeps the whole lane out,
 * with every row still visible, so the user sees the context of the thing
 * asking for them. A clean finish does not: Done is not a request, so it neither
 * holds its lane open nor claims a Focus tile.
 *
 * A finished helper that an agent launched (its nesting parent, or the
 * `launchedBySessionId` of a `--no-parent` chat) is the launcher's business while
 * the launcher is busy in the same lane: it takes no part in the fold, just like a
 * finished nested row. A clean finish takes no part anywhere; the one finish that
 * still asks is a failure, and while the launcher works that failure is deferred
 * too. Once the launcher finishes, an unacknowledged failure holds the lane out
 * again until the user looks.
 *
 * A finished chat with a scheduled wake still to come is Waiting, not Done: it
 * will start again on its own (a subagent polling CI, a /loop). A parent whose
 * subagent is still busy is Waiting too, because that subagent reports back and
 * wakes it. A wake that came due and never started is Done again and holds its
 * lane out, so a dead scheduler cannot leave a lane folded forever.
 *
 * A finished chat whose last reply said it waits on its own work
 * (`awaitingOwnWorkAt`, read by Jev at turn end) is Waiting too, but only
 * while a chat it launched is still busy in the same lane. The verdict alone
 * never folds a lane: when that work ends, the chat is Done again. (Live
 * background work needs no verdict: it already reads as running.)
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
  /** The row's last turn failed (it files under Done, but the lane dot turns red). */
  failed?: boolean;
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
   * may be lifted to Waiting by a busy subagent: a failed parent still needs the
   * user, whatever its subagents are doing; a stopped one is plain Done.
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
 * Has the user left this row since it last failed? Seen comes only from the
 * leave stamp (`useWorkSessions`), never from the row being open: a failure
 * clicked in the inbox must not fold its lane out from under the cursor. Its
 * lane folds once the user moves on.
 *
 * Only an unacknowledged failure asks this. A clean finish does not consult the
 * stamp at all: Done is not a request, so its lane folds whether or not the
 * user ever opened it.
 */
function isWorkRowSeen(session: TerminalSessionSummary, seenAt: string | null | undefined): boolean {
  if (!seenAt) return false;
  const seenMs = Date.parse(seenAt);
  return Number.isFinite(seenMs) && seenMs >= finishedAtMs(session);
}

/**
 * One row's place in its lane's focus, or null for a snoozed/settled row.
 *
 * `laneWaiting` is the lane's PR wait (CI running or a review requested). A
 * live turn stays Working regardless, exactly as the board files it.
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
      // Working, as the row's own status says; a lane PR wait does not
      // override a live turn (same rule as the board).
      return { status: "working", holdsOut: false };
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
      // A clean finish is Done, not a request. It never holds its lane out and
      // never claims a Focus tile: there is nothing here for a person to answer.
      return { status: "done", holdsOut: false, resting: true };
    }
    case "failed":
      // A failure is an error nobody has acknowledged yet. It keeps its lane
      // open, and gets a tile, until the user has left it since it failed.
      return { status: "done", holdsOut: !args.seen, failed: true };
    case "stopped":
    case "ended":
      // The turn is over by the user's own choice or the runtime's own exit.
      // Nothing is waiting on a person, so it rides along like a clean finish.
      return { status: "done", holdsOut: false };
    default: {
      // A phase added later must decide here: the compiler stops on the `never`
      // assignment until it does, instead of letting it go quietly unseen.
      const _exhaustive: never = phase;
      return { status: "done", holdsOut: false };
    }
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
  nestedSessionIds: ReadonlySet<string>;
  busySubagentParentIds?: ReadonlySet<string>;
  nowMs?: number;
};

/**
 * One row's focus inside its lane, or null when it takes no part. A finished
 * nested row is null; a resting parent that a busy subagent keeps busy is Waiting.
 * A missed wake is never dropped.
 */
function laneRowFocus(session: TerminalSessionSummary, seen: boolean, inputs: LaneFocusInputs): WorkRowFocus | null {
  const row = workRowFocus({
    session,
    filingBucket: inputs.filingBuckets.get(session.id),
    laneWaiting: inputs.laneWaiting,
    seen,
    nowMs: inputs.nowMs,
  });
  if (!row || row.status !== "done" || row.missedWake) return row;
  if (inputs.nestedSessionIds.has(session.id)) return null;
  if (row.resting && inputs.busySubagentParentIds?.has(session.id)) return { status: "waiting", holdsOut: false };
  return row;
}

/** A busy agent row: Working or Waiting, not holding its lane out, and an agent chat or CLI. */
function isBusyAgentRow(session: TerminalSessionSummary, row: WorkRowFocus): boolean {
  return !row.holdsOut && (row.status === "working" || row.status === "waiting") && isAgentSession(session);
}

type LaneFocusRows = {
  rowBySessionId: ReadonlyMap<string, WorkRowFocus | null>;
  busyIds: ReadonlySet<string>;
};

/** Every row of one lane, computed once, and the ids of the lane's busy agent rows. */
function laneFocusRows(
  sessions: readonly TerminalSessionSummary[],
  seenOf: (session: TerminalSessionSummary) => boolean,
  inputs: LaneFocusInputs,
): LaneFocusRows {
  const rowBySessionId = new Map<string, WorkRowFocus | null>();
  const busyIds = new Set<string>();
  for (const session of sessions) {
    const row = laneRowFocus(session, seenOf(session), inputs);
    rowBySessionId.set(session.id, row);
    if (row && isBusyAgentRow(session, row)) busyIds.add(session.id);
  }
  const busyLauncherIds = new Set<string>();
  for (const session of sessions) {
    const launcher = busyIds.has(session.id) ? launcherSessionId(session) : null;
    if (launcher && launcher !== session.id) busyLauncherIds.add(launcher);
  }
  for (const session of sessions) {
    if (!session.awaitingOwnWorkAt || !busyLauncherIds.has(session.id)) continue;
    if (!rowBySessionId.get(session.id)?.resting) continue;
    const waiting: WorkRowFocus = { status: "waiting", holdsOut: false };
    rowBySessionId.set(session.id, waiting);
    if (isBusyAgentRow(session, waiting)) busyIds.add(session.id);
  }
  return { rowBySessionId, busyIds };
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
  /** Whether the lane belongs in the Working shelf (pins aside). */
  folds: boolean;
  /** A live row in the lane failed; the collapsed lane's dot says so in red. */
  failed: boolean;
};

export const EMPTY_WORK_SEEN_AT: Readonly<Record<string, string>> = {};

/**
 * One lane's focus from its full roster.
 *
 * It folds when it has at least one busy agent row and no row that needs the
 * user. A lane holding only finished rows is not working, it is waiting to be
 * settled, so it never folds and stays in the inbox with its rows visible. Only
 * agent rows count as busy: a plain shell (a dev server, an App Control shell)
 * can run forever, so it must not keep a lane folded once its chat is done.
 * `launching` counts launches with no session row yet, which are busy by
 * definition.
 *
 * What holds a lane out: a raised hand, a stale or stalled run, a scheduled wake
 * that came due and never ran, or a failure the user has not left since. A
 * clean finish, a stopped chat, and an ended one do not: Done is not a request,
 * and counting it as one let an unopened chat block a lane that had live work.
 *
 * Nested rows (attached shells, subagents) can raise a hand and so hold their
 * lane out, but a finished nested row cannot: nobody opens a helper to mark it
 * seen, so an unacknowledged failure there would pin the lane open forever. A
 * missed wake is the exception.
 *
 * A finished helper the agent launched (`launcherSessionId`) is skipped the same
 * way while that launcher is a busy agent in this lane. A raised hand, a stale
 * run, or a missed wake from a helper still holds the lane out; a chat the user
 * started has no launcher and is unaffected; a launcher in another lane does not
 * count. Only the direct launcher counts, not its own launcher.
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
  let failed = false;
  const lane = laneFocusRows(
    args.sessions,
    (session) => isWorkRowSeen(session, args.seenAtBySessionId[session.id]),
    {
      filingBuckets: args.filingBuckets,
      laneWaiting: args.laneWaiting,
      nestedSessionIds: args.nestedSessionIds,
      busySubagentParentIds: args.busySubagentParentIds,
      nowMs: args.nowMs,
    },
  );
  for (const session of args.sessions) {
    const row = lane.rowBySessionId.get(session.id);
    if (!row) continue;
    if (deferredToBusyLauncher(session, row, lane.busyIds)) continue;
    if (status === null || STATUS_RANK[row.status] < STATUS_RANK[status]) status = row.status;
    if (row.failed) failed = true;
    if (row.holdsOut) heldOut = true;
    else if (isBusyAgentRow(session, row)) busy += 1;
  }
  return { status, folds: !heldOut && busy > 0, failed };
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
 * The chats the Focus grid shows: the rows that actually need the user, from
 * every lane Focus left unfolded.
 *
 * Built from the same `holdsOut` flag as the fold, so the grid and the sidebar
 * cannot disagree: every tile holds its lane out, and no row gets a tile without
 * one. The reverse is not exact — a nested row or a plain shell can hold a lane
 * out with no tile, which is the sidebar's business, not a request on this desk.
 * A clean finish is Done, not a request, so it never claims a Focus slot — the
 * sidebar's inbox already shows it, and a lane that has only finished rows never
 * folds. A Working or Waiting row stays out of the grid even when its lane is
 * unfolded; the sidebar still shows it, which is where the user sees why it is
 * not a tile. Plain shells are
 * not agents and never get a tile. A nested row (subagent, attached shell) gets
 * a tile only while it asks for the user or a wake it promised came due; a
 * finished one is the parent's business. A finished helper whose launcher is
 * busy in its lane (`summarizeLaneFocus`) gets no tile either, so the grid and
 * the sidebar agree.
 */
export function workFocusQueue(args: {
  sessions: readonly TerminalSessionSummary[];
  filingBuckets: ReadonlyMap<string, SessionFilingBucket>;
  foldedLaneIds: ReadonlySet<string>;
  laneWaiting: (laneId: string) => boolean;
  /** The leave stamps `summarizeLaneFocus` reads, so an acknowledged failure stops asking. */
  seenAtBySessionId: Readonly<Record<string, string>>;
  nestedSessionIds: ReadonlySet<string>;
  /** Same set as `summarizeLaneFocus`: a parent kept busy by a subagent gets no tile. */
  busySubagentParentIds?: ReadonlySet<string>;
  nowMs?: number;
}): string[] {
  const sessionsByLaneId = new Map<string, TerminalSessionSummary[]>();
  for (const session of args.sessions) {
    if (args.foldedLaneIds.has(session.laneId)) continue;
    const laneSessions = sessionsByLaneId.get(session.laneId);
    if (laneSessions) laneSessions.push(session);
    else sessionsByLaneId.set(session.laneId, [session]);
  }
  const laneBySessionId = new Map<string, LaneFocusRows>();
  for (const [laneId, laneSessions] of sessionsByLaneId) {
    const lane = laneFocusRows(
      laneSessions,
      (session) => isWorkRowSeen(session, args.seenAtBySessionId[session.id]),
      {
        filingBuckets: args.filingBuckets,
        laneWaiting: args.laneWaiting(laneId),
        nestedSessionIds: args.nestedSessionIds,
        busySubagentParentIds: args.busySubagentParentIds,
        nowMs: args.nowMs,
      },
    );
    for (const session of laneSessions) laneBySessionId.set(session.id, lane);
  }
  const ids: string[] = [];
  for (const session of args.sessions) {
    const lane = laneBySessionId.get(session.id);
    if (!lane || !isAgentSession(session)) continue;
    const row = lane.rowBySessionId.get(session.id);
    if (!row) continue;
    if (row.status === "needs_you") {
      ids.push(session.id);
      continue;
    }
    if (row.missedWake) {
      ids.push(session.id);
      continue;
    }
    if (args.nestedSessionIds.has(session.id)) continue;
    if (deferredToBusyLauncher(session, row, lane.busyIds)) continue;
    // One rule with the fold: a row that holds its lane out is the row on the
    // user's desk. That covers the stale or stalled run (filed as working but
    // possibly stuck, so the user is the one who has to look) and the failure
    // nobody has left yet. A clean finish holds nothing out and gets no tile.
    if (row.holdsOut) ids.push(session.id);
  }
  return ids;
}
