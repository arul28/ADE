import { randomUUID } from "node:crypto";
import type {
  SessionAttentionSource,
  SessionBoardMoveResult,
  SessionBoardMoveUndoResult,
  SessionSettleOverride,
  TerminalSessionSummary,
} from "../../../shared/types";
import {
  WORK_BOARD_MOVE_TARGETS,
  isWorkBoardMoveTarget,
  type AgentChatBoardMoveMetadata,
  type WorkBoardColumn,
  type WorkBoardMoveTarget,
} from "../../../shared/types/chat";
import {
  backgroundWorkFromSummary,
  canonicalSessionState,
  canonicalStatusBucket,
  isSessionFiledAsSnoozed,
} from "../../../shared/sessionCanonicalState";
import { isChatToolType } from "../sessions/chatSessionProjection";
import type { createSessionService } from "../sessions/sessionService";
import { getErrorMessage } from "../shared/utils";
import { readObjectActionArg, requireNonEmptyString } from "./actionArgs";

/* ──────────────────────────────────────────────────────────────────────────
   WORK BOARD MOVES

   A drag on the Work board is two writes that must never come apart: the
   lifecycle columns that decide which column the card sits in, and a message
   telling the agent what the user just did. A status write with no message is
   a card that moved while the agent kept doing what it was doing; a message
   with no status write is a nudge about a move that did not happen.

   So both are staged together and both land together. `moveOnBoard` applies
   the status write and stages the message for BOARD_MOVE_STAGE_MS; within that
   window `undoBoardMove` cancels the message and reverses the status write.
   After it, the message is dispatched — and if the dispatch fails, the status
   write is reversed with it.

   The bound on that, stated honestly: the staging map is in-process, and the
   drain is guaranteed on exactly TWO paths — a graceful shutdown, where the
   desktop host awaits `flushStagedBoardMoves` in its shutdown sequence, and a
   project close, where it awaits the same drain SCOPED to that project's
   session service before the context's chat service and database go away.
   Staging a second move for the same session also drains the first. Every
   other exit only ATTEMPTS it: the desktop host fires the drain without
   awaiting it from its synchronous cleanup, so the send starts against a live
   service but can be cut off mid-flight by `process.exit`, a signal-driven
   fast kill, the shutdown force timer, or Electron's `will-quit`. When it is
   cut off the status write survives without its message — nothing in a single
   process can prevent that — and `undoBoardMove` says `unknown_move` for the
   orphan rather than claiming it dispatched.

   The undo is narrowed, not blind. A move stages what the row looked like
   BEFORE it and what the write left behind AFTER it; the reversal restores
   only the fields the row still carries from the move. Five seconds is long
   enough for the agent to raise a hand, for activity to change the settle
   tier, or for the user to snooze the row, and a full-snapshot restore would
   silently overwrite whichever of those landed first.

   Waiting is not here on purpose. A row sits in Waiting because it is snoozed
   or because its PR is mid-CI; a drag cannot assert either, so the column is
   not a target and this refuses it by type and at runtime.
   ────────────────────────────────────────────────────────────────────────── */

/** How long a board move stays reversible, and how long its message waits. */
export const BOARD_MOVE_STAGE_MS = 5_000;

export const BOARD_MOVE_DONE_TO_WORKING_TEXT =
  "You moved this chat from Done to Working. Continue the work, or ask me what you need if the next step is unclear.";
export const BOARD_MOVE_TO_NEEDS_YOU_TEXT =
  "The user parked this for their input. Stop, summarize where you are, and list what you need from them.";

/**
 * The message a move sends, or null when it sends none.
 *
 * Only two moves say anything, and both say something the agent has to act on.
 * A move to Done is the user filing finished work — there is nothing to ask
 * for, and a "you were moved to Done" message would start a turn on a chat the
 * user just quieted, which is the opposite of what the drag meant. A move to
 * Working from anywhere except Done is the user un-parking a chat that was
 * never stopped, so it has nothing new to be told either.
 */
export function boardMoveMessageText(
  from: WorkBoardColumn,
  to: WorkBoardMoveTarget,
): string | null {
  if (to === "needs_you") return BOARD_MOVE_TO_NEEDS_YOU_TEXT;
  if (to === "working" && from === "done") return BOARD_MOVE_DONE_TO_WORKING_TEXT;
  return null;
}

/**
 * Which column a row is in RIGHT NOW, derived on the host.
 *
 * `from` is host-derived rather than caller-supplied for the same reason every
 * other entry in `HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS` is: the message says
 * "you moved this chat from Done", and a caller that could choose `from` could
 * make that sentence say anything.
 *
 * It is NOT the whole of the board's bucketing, and the difference is load-
 * bearing. This derives `waiting` from the snooze alone; the renderer's
 * `buildWorkBoardModel` ALSO files a running row in Waiting when its lane's PR
 * has CI in flight or a review outstanding, which is PR state this registry
 * deliberately does not reach for. So a card the user sees parked in Waiting
 * by a pending check derives as `working` here, and dragging it to Working is
 * a legitimate no-op — `moveOnBoard` returns the derived `from` so the caller
 * can say so instead of appearing to do nothing.
 */
export function deriveWorkBoardColumn(
  session: TerminalSessionSummary,
  nowMs: number = Date.now(),
): WorkBoardColumn {
  const phase = canonicalSessionState({
    status: session.status,
    runtimeState: session.runtimeState ?? null,
    toolType: session.toolType ?? null,
    pendingInputItemId: session.pendingInputItemId ?? null,
    attentionSource: session.attentionSource ?? null,
    lastOutputPreview: session.lastOutputPreview,
    lastActivityAt: session.lastActivityAt ?? null,
    exitCode: session.exitCode ?? null,
    settledAt: session.settledAt ?? null,
    settleOverride: session.settleOverride ?? null,
    attentionRequestedAt: session.attentionRequestedAt ?? null,
    lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    backgroundWork: backgroundWorkFromSummary(session),
    nowMs,
    isChatTool: isChatToolType,
  }).phase;
  if (isSessionFiledAsSnoozed(session, phase, nowMs)) return "waiting";
  const bucket = canonicalStatusBucket(phase);
  if (bucket === "running") return "working";
  if (bucket === "awaiting-input") return "needs_you";
  return "done";
}

/**
 * Everything a move overwrites, captured before it writes, so an undo restores
 * the row rather than guessing at it.
 *
 * `settledAt` is restored as "settled again", not as the original instant —
 * `settleSession` stamps now and there is no write path that backdates it. The
 * tier is what the board reads, so the tier is what undo owes.
 */
type BoardMoveSnapshot = {
  settledAt: string | null;
  settleOverride: SessionSettleOverride | null;
  snoozedUntil: string | null;
  attentionRequestedAt: string | null;
  attentionMessage: string | null;
  attentionSource: SessionAttentionSource | null;
};

/**
 * What the move's own write left on the row, so a reversal can tell "still
 * mine" from "something newer happened here".
 *
 * The attention triple is the same one the rest of this branch reads —
 * `pendingInputItemId | attentionRequestedAt | attentionSource` — because those
 * three are what `canonicalSessionState` derives Needs you from, and any one of
 * them changing means the hand on the row is no longer the one the move put
 * there (or took away). `pendingInputItemId` is projection-only today, so it
 * reads null off a raw row; it is compared anyway because a projected row
 * carries it and a comparison that silently ignores a field is the bug this
 * type exists to prevent.
 */
type BoardMoveLifecycleIdentity = {
  settledAt: string | null;
  settleOverride: SessionSettleOverride | null;
  snoozedUntil: string | null;
  attentionRequestedAt: string | null;
  attentionSource: SessionAttentionSource | null;
  pendingInputItemId: string | null;
};

type StagedBoardMove = {
  moveId: string;
  sessionId: string;
  from: WorkBoardColumn;
  to: WorkBoardMoveTarget;
  at: string;
  text: string | null;
  before: BoardMoveSnapshot;
  /** What the write left behind, re-read from the row it wrote. */
  after: BoardMoveLifecycleIdentity | null;
  /**
   * The service this move writes through, and the only handle on WHICH project
   * staged it: the map is module-level while every project context builds these
   * actions over its own session service, so the instance IS the project scope.
   */
  sessionService: BoardMoveSessionService;
  timer: NodeJS.Timeout | null;
  /** Send the message now and drop the entry. Idempotent — it claims first. */
  dispatch: () => Promise<void>;
};

/**
 * Module-level, not per-runtime: the undo arrives on a different action call
 * than the move, and a registry rebuilt in between (a reconnect, a rebind)
 * must not orphan a staged message with a live timer behind it.
 */
const stagedBoardMoves = new Map<string, StagedBoardMove>();

/**
 * Move ids this process actually dispatched, so a refused undo can tell
 * "too late" from "never heard of it".
 *
 * Capped and FIFO-evicted: it exists to answer an undo that arrives seconds
 * after a 5-second window closed, not to be an audit log. An id that ages out
 * answers `unknown_move`, which is the truthful fallback — this process can no
 * longer say what happened to it.
 */
const DISPATCHED_MOVE_ID_MEMORY = 200;
const dispatchedMoveIds = new Set<string>();

function rememberDispatchedMoveId(moveId: string): void {
  dispatchedMoveIds.add(moveId);
  while (dispatchedMoveIds.size > DISPATCHED_MOVE_ID_MEMORY) {
    const oldest = dispatchedMoveIds.values().next();
    if (oldest.done) break;
    dispatchedMoveIds.delete(oldest.value);
  }
}

/**
 * Which staged moves a drain claims. An empty filter claims all of them.
 *
 * `sessionService` is how a caller says "this project": the map is module-level
 * so a project teardown cannot flush by root, and a global flush on one
 * project's close would dispatch another project's pending move early — killing
 * an undo window the user is still looking at.
 */
export type StagedBoardMoveFilter = {
  sessionId?: string;
  sessionService?: BoardMoveSessionService;
};

/**
 * Dispatch staged moves immediately instead of waiting out their undo windows.
 *
 * Three callers, one reason: the status write has ALREADY landed, so the
 * message must not be lost. `moveOnBoard` drains the session's previous move
 * before staging a new one (at most one per session is ever in flight, so an
 * undo can only ever reverse the most recent), the desktop host awaits this
 * inside its graceful shutdown, and it awaits it again — filtered to the
 * closing project's session service — before a project context is disposed. A
 * hard kill cannot run it; see the header.
 */
export async function flushStagedBoardMoves(filter?: StagedBoardMoveFilter): Promise<void> {
  const pending = [...stagedBoardMoves.values()].filter((staged) => (
    (!filter?.sessionId || staged.sessionId === filter.sessionId)
    && (!filter?.sessionService || staged.sessionService === filter.sessionService)
  ));
  for (const staged of pending) {
    if (staged.timer) clearTimeout(staged.timer);
    staged.timer = null;
    await staged.dispatch();
  }
}

/**
 * A staged move holds no `ref`'d timer, so the loop can empty with one still
 * pending. `beforeExit` catches that for a plain Node host: it fires when the
 * process is about to leave cleanly with work left, and re-fires after the
 * async dispatch it schedules. It does NOT fire for `process.exit`, a signal,
 * or a crash — for those the move is lost, which is what `unknown_move`
 * reports.
 *
 * It also never fires in Electron's main process, whose loop never empties.
 * That host gets its guarantee from `main.ts`, which AWAITS
 * `flushStagedBoardMoves` inside its shutdown sequence, and again — scoped to
 * the closing project's session service — at the top of
 * `disposeContextResources`, both times before it disposes the chat service the
 * dispatch needs. This hook is the non-Electron fallback, not the desktop
 * guarantee.
 */
let beforeExitHookInstalled = false;
function ensureBeforeExitDrain(): void {
  if (beforeExitHookInstalled) return;
  beforeExitHookInstalled = true;
  process.on("beforeExit", () => {
    if (stagedBoardMoves.size === 0) return;
    void flushStagedBoardMoves();
  });
}

/** Test seam: drop every staged move without dispatching or reversing it. */
export function __resetStagedBoardMovesForTest(): void {
  for (const staged of stagedBoardMoves.values()) {
    if (staged.timer) clearTimeout(staged.timer);
  }
  stagedBoardMoves.clear();
  dispatchedMoveIds.clear();
}

export function stagedBoardMoveCountForTest(): number {
  return stagedBoardMoves.size;
}


const BOARD_MOVE_ATTENTION_MESSAGE = "Parked for your input.";

function captureBoardMoveSnapshot(row: TerminalSessionSummary): BoardMoveSnapshot {
  return {
    settledAt: row.settledAt ?? null,
    settleOverride: row.settleOverride ?? null,
    snoozedUntil: row.snoozedUntil ?? null,
    attentionRequestedAt: row.attentionRequestedAt ?? null,
    attentionMessage: row.attentionMessage ?? null,
    attentionSource: row.attentionSource ?? null,
  };
}

function captureLifecycleIdentity(
  row: TerminalSessionSummary | null | undefined,
): BoardMoveLifecycleIdentity | null {
  if (!row) return null;
  return {
    settledAt: row.settledAt ?? null,
    settleOverride: row.settleOverride ?? null,
    snoozedUntil: row.snoozedUntil ?? null,
    attentionRequestedAt: row.attentionRequestedAt ?? null,
    attentionSource: row.attentionSource ?? null,
    pendingInputItemId: row.pendingInputItemId ?? null,
  };
}

/**
 * The slice of the real session service a board move writes through.
 *
 * DERIVED from `createSessionService` rather than re-declared: a hand-written
 * shape of the same methods drifts from the service the instant one of them
 * gains an argument, and the drift shows up as a cast at every call site rather
 * than as a type error here. All three consumers — the action registry, desktop
 * IPC and the sync command table — hold the real service, so `Pick` is what
 * lets them hand it over as-is.
 *
 * Still a narrow `Pick` and not the whole service: a board move calls these
 * eight methods and nothing else, and the type is what says so.
 */
export type BoardMoveSessionService = Pick<
  ReturnType<typeof createSessionService>,
  | "get"
  | "unsettleSession"
  | "setSettleOverride"
  | "snoozeSession"
  | "wakeSession"
  | "requestAttention"
  | "clearAttentionRequest"
  | "settleSession"
>;

/**
 * Put the row where the column says it is.
 *
 * Every branch wakes the row first. A snooze is what files a card in Waiting,
 * and `isSessionFiledAsSnoozed` keeps filing it there even once it is settled —
 * so a Done branch that left `snoozed_until` standing would report a move that
 * never happened, which is worse than Done meaning "woken and settled".
 *
 * After the wake, each branch writes the columns the board actually reads, and
 * nothing else:
 *
 *   done       drop the attention hand and any keep-active pin, then settle —
 *              Done IS the settled tier.
 *   working    lift everything else that mutes a row (settle, attention) and
 *              pin it active, so it does not fall straight back into Done on the
 *              next idle tick.
 *   needs_you  lift the mutes too, then raise the hand as the USER (`source:
 *              "user"`), because that is who raised it. Not `agent_explicit`:
 *              the row's attention source is auditable and must not claim the
 *              agent asked for something it never asked for.
 */
async function applyBoardMoveStatusWrite(
  sessionService: BoardMoveSessionService,
  sessionId: string,
  from: WorkBoardColumn,
  to: WorkBoardMoveTarget,
): Promise<void> {
  sessionService.wakeSession(sessionId, "manual");
  if (to === "done") {
    sessionService.clearAttentionRequest(sessionId);
    sessionService.setSettleOverride(sessionId, null);
    await sessionService.settleSession(sessionId, { source: "user" });
    return;
  }
  sessionService.unsettleSession(sessionId);
  if (to === "working") {
    sessionService.clearAttentionRequest(sessionId);
    sessionService.setSettleOverride(sessionId, "active");
    return;
  }
  sessionService.setSettleOverride(sessionId, null);
  sessionService.requestAttention(sessionId, BOARD_MOVE_ATTENTION_MESSAGE, "user");
  void from;
}

/** What a reversal actually put back, group by group. */
type BoardMoveRestoreOutcome = {
  settle: boolean;
  attention: boolean;
  snooze: boolean;
};

const RESTORED_NOTHING: BoardMoveRestoreOutcome = { settle: false, attention: false, snooze: false };

function restoredSomething(outcome: BoardMoveRestoreOutcome): boolean {
  return outcome.settle || outcome.attention || outcome.snooze;
}

/**
 * Undo the status write from the snapshot taken before it — but only where the
 * row still carries what the move wrote.
 *
 * A move is reversible for five seconds, and five seconds is long enough for
 * the agent to raise a hand, for a turn to change the settle tier, or for the
 * user to snooze the row. Restoring the whole snapshot over any of those puts
 * back state the user can see is stale, silently, which is worse than an undo
 * that puts back less than everything. So each group is compared against what
 * the move LEFT (`after`) and skipped when the live row has moved on:
 *
 *   settle     `settled_at` + the override, which the move wrote together.
 *   attention  the hand: `attention_requested_at`, its source, and the
 *              provider's pending item id.
 *   snooze     the move woke the row, so restoring a snooze is only safe while
 *              the row is still awake.
 *
 * With no `after` (a move staged before this existed, or a row that has since
 * been deleted) there is nothing to compare, and the old unconditional restore
 * is the honest fallback — it is still the state the move overwrote.
 *
 * Order matters within a restore: settling clears the attention columns (see
 * `settleSessions`), so attention is restored last and wins when a snapshot
 * somehow carries both. That is also the canonical precedence — needs_you
 * outranks settled — so the restored row reads the way the original one did.
 */
async function restoreBoardMoveSnapshot(
  sessionService: BoardMoveSessionService,
  sessionId: string,
  before: BoardMoveSnapshot,
  after: BoardMoveLifecycleIdentity | null,
  nowMs: number = Date.now(),
): Promise<BoardMoveRestoreOutcome> {
  const live = captureLifecycleIdentity(sessionService.get(sessionId));
  // A row that vanished has nothing to restore; a move with no `after` has
  // nothing to compare, so every group is still "mine".
  if (after && !live) return RESTORED_NOTHING;
  const stillOurs = (...fields: Array<keyof BoardMoveLifecycleIdentity>): boolean =>
    !after || !live || fields.every((field) => live[field] === after[field]);

  const outcome: BoardMoveRestoreOutcome = {
    settle: stillOurs("settledAt", "settleOverride"),
    attention: stillOurs("attentionRequestedAt", "attentionSource", "pendingInputItemId"),
    snooze: stillOurs("snoozedUntil"),
  };
  // The two lifecycle writes clear each other (a settle drops the attention
  // columns, an attention request drops the settle), so a group that is still
  // "ours" can still reach a newer fact through the other one's side door. The
  // newer fact wins in both directions:
  if (outcome.settle && before.settledAt && !outcome.attention && live?.attentionRequestedAt) {
    // Re-settling would take away a hand the move never raised. Needs you
    // outranks settled, so the hand stays and the settle goes with it.
    outcome.settle = false;
  }
  if (outcome.attention && before.attentionRequestedAt && !outcome.settle && live?.settledAt) {
    // And restoring the move's old question would un-settle a row that has
    // since declared itself done.
    outcome.attention = false;
  }

  if (outcome.settle) {
    sessionService.setSettleOverride(sessionId, before.settleOverride ?? null);
    if (before.settledAt) {
      await sessionService.settleSession(sessionId, { source: "user" });
    } else {
      sessionService.unsettleSession(sessionId);
    }
  }
  if (outcome.attention) {
    if (before.attentionRequestedAt) {
      sessionService.requestAttention(
        sessionId,
        before.attentionMessage,
        before.attentionSource ?? "agent_explicit",
      );
    } else {
      sessionService.clearAttentionRequest(sessionId);
    }
  }
  // A snooze whose deadline has already passed is not worth restoring: it would
  // be re-filed out of the board on the next tick for a window that is over.
  const until = before.snoozedUntil ? Date.parse(before.snoozedUntil) : Number.NaN;
  if (outcome.snooze && Number.isFinite(until) && until > nowMs) {
    sessionService.snoozeSession(sessionId, before.snoozedUntil!);
  } else {
    outcome.snooze = false;
  }
  return outcome;
}


/**
 * Method shorthand, not an arrow property: TypeScript checks method parameters
 * bivariantly, which is what lets the real `messageSession` — whose argument
 * type is the full `AgentChatMessageSessionArgs` — satisfy this narrow view of
 * it without a cast at every call site.
 */
export type BoardMoveChatService = {
  messageSession?(args: {
    sessionId: string;
    text: string;
    kind: "auto";
    metadata: { boardMove: AgentChatBoardMoveMetadata };
  }): Promise<unknown> | unknown;
  /**
   * The live chat behind this row, for the one question a move has to ask it:
   * is a structured provider card still waiting on an answer.
   *
   * It cannot be asked of the session row. `pendingInputItemId` is projected
   * onto a row from the chat summary and is never a column, so
   * `sessionService.get` reads it as null for a chat that is visibly parked in
   * Needs you — which is exactly how a move to Working could report success
   * over a live card. `awaitingInput` is the chat service's own
   * `hasLivePendingInput`, the same check `chat.sendMessage` refuses on.
   */
  getSessionSummary?(sessionId: string): Promise<{ awaitingInput?: boolean } | null>;
};

/**
 * Whether the provider is still blocked on a structured card nobody answered.
 *
 * Best effort by design: a host with no chat service, an older one with no
 * summary reader, or a summary read that throws all answer "no" and let the
 * move through. A board move must not fail because the question could not be
 * asked — the refusal it feeds exists to stop a move that would LIE, and a
 * thrown probe is not evidence of one.
 */
async function hasLiveStructuredCard(
  chat: BoardMoveChatService | null | undefined,
  sessionId: string,
): Promise<boolean> {
  if (typeof chat?.getSessionSummary !== "function") return false;
  try {
    const summary = await chat.getSessionSummary(sessionId);
    return summary?.awaitingInput === true;
  } catch {
    return false;
  }
}

/**
 * The two board-move actions, built once and shared by every caller that can
 * reach them: the `ade actions` registry, desktop IPC, and the paired-runtime
 * sync command table the phone and the web client use.
 *
 * Shared rather than reimplemented per surface because the staging map is what
 * makes the move and its message atomic. A second implementation would be a
 * second staging map, and an undo sent from the phone would not find a move
 * made on the desktop.
 */
export function createSessionBoardMoveActions(deps: {
  sessionService: BoardMoveSessionService;
  agentChatService?: BoardMoveChatService | null;
  logger: { warn(event: string, data: Record<string, unknown>): void };
}) {
  const sessionService = deps.sessionService;
  return {
    /**
     * Move one chat between Work-board columns: a status write plus a message
     * the agent reacts to, staged together so neither can land without the
     * other. See the WORK BOARD MOVES block above for the full contract.
     *
     * Returns `undoExpiresAt`; until then `session.undoBoardMove` reverses
     * both halves. After it the message is dispatched, and a dispatch failure
     * reverses the status write rather than leaving the board asserting a move
     * the agent was never told about.
     */
    moveOnBoard: async (args?: unknown): Promise<SessionBoardMoveResult> => {
      const record = readObjectActionArg(args, "session.moveOnBoard");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const to = record.to;
      if (to === "waiting") {
        throw new Error(
          "Waiting is derived — a row sits there because it is snoozed or its PR is mid-CI — so it is not a board-move target.",
        );
      }
      if (!isWorkBoardMoveTarget(to)) {
        throw new Error(
          `session.moveOnBoard 'to' must be one of ${WORK_BOARD_MOVE_TARGETS.join(", ")}.`,
        );
      }
      const row = sessionService.get(sessionId);
      if (!row) throw new Error(`Session '${sessionId}' was not found.`);
      // A live structured card outranks the drag, and the drag cannot answer
      // it. `clearAttentionRequest` clears the attention columns but not the
      // provider's pending item, so a move to Working or Done over a live card
      // used to report `changed: true` and toast success while the card stayed
      // in Needs you — the same "a move that visibly lies" this branch refuses
      // for a snoozed row dragged to Done. Answering a provider's question on
      // the user's behalf is not something a drag may do, so this refuses with
      // a reason instead, exactly as `chat.sendMessage` refuses a send.
      //
      // Needs you is exempt: that is where the card already is, and raising the
      // user's own hand on top of the provider's asserts nothing false.
      //
      // With no chat service (or an older one with no summary reader) there is
      // nothing to ask, and the move proceeds as it did before.
      if (to !== "needs_you" && (await hasLiveStructuredCard(deps.agentChatService, sessionId))) {
        return {
          ok: false,
          sessionId,
          // Needs you, not the derived column: the card IS parked there on the
          // board the user dragged from, even though the raw row cannot say so.
          from: "needs_you",
          to,
          changed: false,
          moveId: null,
          undoExpiresAt: null,
          reason: "pending_input",
        };
      }
      // Checked BEFORE the flush below, so a duplicate drop event — which
      // arrives as a second call to the column the first one just reached —
      // stays a pure no-op instead of cutting the real move's undo short.
      if (deriveWorkBoardColumn(row) === to) {
        return { ok: true, sessionId, from: to, to, changed: false, moveId: null, undoExpiresAt: null };
      }
      // This session's previous move, if it still has one, goes out NOW. Its
      // status write already landed; keeping it staged behind this one would
      // let an undo of the OLDER moveId restore a snapshot taken before it and
      // silently wipe this move's write. One in flight per session, and undo
      // only ever reaches the latest.
      await flushStagedBoardMoves({ sessionId });
      // Re-read and re-derive: a flushed move whose message could not be
      // delivered restores its own snapshot, so both the row and the column it
      // is in may have moved under us.
      const rowAfterFlush = sessionService.get(sessionId) ?? row;
      const from = deriveWorkBoardColumn(rowAfterFlush);
      if (from === to) {
        return { ok: true, sessionId, from, to, changed: false, moveId: null, undoExpiresAt: null };
      }
      const before = captureBoardMoveSnapshot(rowAfterFlush);
      const moveId = randomUUID();
      const at = new Date().toISOString();
      await applyBoardMoveStatusWrite(sessionService, sessionId, from, to);
      // Re-read rather than predict: the write goes through four session-service
      // methods whose own rules (a settle clearing attention, an attention
      // request clearing a settle) decide what actually landed. A reversal
      // compares against this, so it has to be what the row says, not what the
      // move meant.
      const after = captureLifecycleIdentity(sessionService.get(sessionId));

      const text = boardMoveMessageText(from, to);
      const dispatch = async (): Promise<void> => {
        // Claim the entry first: an undo racing the timer must find it gone.
        if (stagedBoardMoves.get(moveId) !== staged) return;
        stagedBoardMoves.delete(moveId);
        rememberDispatchedMoveId(moveId);
        if (!text) return;
        const chat = deps.agentChatService;
        if (typeof chat?.messageSession !== "function") {
          // No chat service means no message, so the move never completed.
          const restored = await restoreBoardMoveSnapshot(sessionService, sessionId, before, after);
          deps.logger.warn("session.board_move_reverted", {
            sessionId,
            moveId,
            reason: "chat_service_unavailable",
            restored,
          });
          return;
        }
        try {
          await chat.messageSession({
            sessionId,
            text,
            kind: "auto",
            // Host-stamped. `stripHostAuthoredMessageProvenance` deletes any
            // caller-supplied `boardMove`, so this is the only writer.
            metadata: { boardMove: { from, to, at, moveId } },
          });
        } catch (error) {
          const restored = await restoreBoardMoveSnapshot(sessionService, sessionId, before, after);
          deps.logger.warn("session.board_move_reverted", {
            sessionId,
            moveId,
            reason: "message_failed",
            restored,
            error: getErrorMessage(error),
          });
        }
      };
      const staged: StagedBoardMove = {
        moveId, sessionId, from, to, at, text, before, after, sessionService, timer: null, dispatch,
      };
      stagedBoardMoves.set(moveId, staged);
      const timer = setTimeout(() => { void dispatch(); }, BOARD_MOVE_STAGE_MS);
      // Never hold the process open for an undo window nobody is watching —
      // which is why the exit drain below exists.
      timer.unref?.();
      staged.timer = timer;
      ensureBeforeExitDrain();
      return {
        ok: true,
        sessionId,
        from,
        to,
        changed: true,
        moveId,
        message: text,
        // Queue-only providers cannot take a message mid-turn; the delivery is
        // still made, it simply waits at the turn boundary. The caller shows
        // that on the card rather than pretending the agent has read it.
        undoExpiresAt: new Date(Date.now() + BOARD_MOVE_STAGE_MS).toISOString(),
      };
    },
    /**
     * Reverse a board move that is still staged.
     *
     * Refuses once the message has been dispatched — reversing the status write
     * alone would be exactly the divergence the staging exists to prevent, and
     * the agent has already been told. `unknown_move` is the other refusal: the
     * host has no record of this id at all, so it cannot say what to restore.
     *
     * `session_advanced` is the third, and it is a refusal rather than a
     * half-restore: the row no longer carries ANYTHING this move wrote — a new
     * hand, a new settle tier, a fresh snooze got there first — so there is
     * nothing left to take back, and reporting `reversed` would claim a write
     * that did not happen. A row that advanced in only one of those groups is
     * still undone, minus that group; see `restoreBoardMoveSnapshot`.
     */
    undoBoardMove: async (args?: unknown): Promise<SessionBoardMoveUndoResult> => {
      const record = readObjectActionArg(args, "session.undoBoardMove");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const moveId = requireNonEmptyString(record.moveId, "moveId");
      const staged = stagedBoardMoves.get(moveId);
      if (!staged || staged.sessionId !== sessionId) {
        // Only an id this process actually staged can have been dispatched by
        // it. Anything else — a restart in the middle of the undo window, an id
        // from another host — is unknown, and saying "already dispatched" about
        // a message that may never have gone out is a lie the caller repeats.
        const reason = dispatchedMoveIds.has(moveId) ? "already_dispatched" : "unknown_move";
        return { ok: false, sessionId, moveId, reason };
      }
      stagedBoardMoves.delete(moveId);
      if (staged.timer) clearTimeout(staged.timer);
      const restored = await restoreBoardMoveSnapshot(
        sessionService,
        sessionId,
        staged.before,
        staged.after,
      );
      if (!restoredSomething(restored)) {
        deps.logger.warn("session.board_move_undo_refused", {
          sessionId,
          moveId,
          reason: "session_advanced",
        });
        return { ok: false, sessionId, moveId, reason: "session_advanced" };
      }
      return { ok: true, sessionId, moveId, from: staged.from, to: staged.to, reversed: true };
    },
  };
}
