import { backgroundWorkFromSummary, isSessionFiledAsSnoozed, totalBackgroundWork } from "../../shared/sessionCanonicalState";
import {
  WORK_BOARD_WAITING_REASON_LABEL,
  type WorkBoardMoveTarget,
  type WorkBoardWaitingReason,
} from "../../shared/types/chat";
import type { TerminalSessionSummary } from "../../shared/types/sessions";
import { isChatToolType } from "../../shared/sessionSpawnNesting";
import { canonicalInputFromSummary, sessionCanonicalUiState } from "./terminalAttention";

/**
 * One model for the "Change status" menu, shared by every row surface.
 *
 * The Work board's four columns are not four equal states, and a menu that
 * pretends they are is how a row ends up claiming something untrue:
 *
 *   • `needs_you` is writable — a hand the person raises.
 *   • `done` is writable — a settle is a declaration.
 *   • `waiting` is NOT a target. A row sits there because it is snoozed, its PR
 *     is mid-CI, a review is outstanding, a wake is armed, or a subagent is
 *     still working. Only the snooze is the person's to set, so the menu offers
 *     snooze presets instead of a "Waiting" entry.
 *   • `working` cannot be ASSERTED. Nothing parks a row there; it is what is
 *     left when every other reason is gone. A status change cannot start a
 *     model, so Working is offered only for a session that is already live and
 *     is merely being held elsewhere (a stale ask, a snooze, a settle). An idle
 *     row is told "Nothing is running — send a message to start it" instead of
 *     being moved somewhere it will not stay.
 *
 * Every disabled entry carries the reason, because a menu line that silently
 * does nothing reads as a bug.
 */
export type SessionStatusTarget = WorkBoardMoveTarget | "snoozed";

export type SessionStatusOption = {
  target: SessionStatusTarget;
  label: string;
  enabled: boolean;
  /** The row is already here (a checkmark, not a write). */
  current: boolean;
  /** Why the entry is disabled; null when it can be chosen. */
  reason: string | null;
};

export type SessionStatusChangeModel = {
  options: SessionStatusOption[];
  /** The row is filed under Snoozed right now (the menu offers "Wake now"). */
  snoozed: boolean;
  /** "Working", "Needs you", "Waiting · CI running", "Done" — used as the submenu hint. */
  currentLabel: string;
};

/** Reasons that park a row in Waiting without the person asking. */
function derivedWaitLabel(reason: WorkBoardWaitingReason | null | undefined): string | null {
  if (!reason || reason === "snoozed") return null;
  return WORK_BOARD_WAITING_REASON_LABEL[reason];
}

/**
 * What the status menu may offer for one row.
 *
 * `waitingReason` is the fold's own verdict (`WorkBoardWaitingReason`), passed
 * in so the menu disables Working with the same words the board's Waiting
 * column shows rather than re-deriving PR state here.
 */
export function sessionStatusChangeModel(args: {
  session: TerminalSessionSummary;
  nowMs?: number;
  waitingReason?: WorkBoardWaitingReason | null;
}): SessionStatusChangeModel {
  const { session } = args;
  const nowMs = args.nowMs ?? Date.now();
  const phase = sessionCanonicalUiState(canonicalInputFromSummary(session)).phase;
  const snoozed = isSessionFiledAsSnoozed(session, phase, nowMs);
  /** The live projection is the honest "is anything happening" signal. */
  const live = session.runtimeState === "running"
    || totalBackgroundWork(backgroundWorkFromSummary(session)) > 0;
  const ended = session.status === "detached"
    || session.status === "disposed"
    || phase === "ended"
    || phase === "stopped";
  const failed = phase === "failed";
  /** A live provider card outranks every status write: it can only be answered. */
  const pendingCard = Boolean(session.pendingInputItemId)
    || session.attentionSource === "provider_structured";
  /**
   * A tracked CLI waiting at its own prompt with no recorded hand: the terminal
   * owns that question, so settling it would not answer it. The old menu's
   * rule, kept: a hand ADE recorded (an idle-prompt guess included) can be
   * dismissed, since it may be a false alarm.
   */
  const nativePrompt = phase === "needs_you"
    && !isChatToolType(session.toolType)
    && !session.attentionRequestedAt;
  const derivedWait = derivedWaitLabel(args.waitingReason);

  const workingBlockedReason = pendingCard
    ? "Answer the open question first"
    : failed
      ? "The last turn failed — send a message to retry"
      : ended
        ? "The session has ended"
        : !live
          ? "Nothing is running — send a message to start it"
          : derivedWait
            ? `${derivedWait} — it files back here until that clears`
            : null;

  const doneBlockedReason = nativePrompt
    ? "Resolve the prompt in the terminal first"
    : pendingCard
      ? "Answer the open question first"
      : null;

  const currentColumn = snoozed
    ? "snoozed"
    : phase === "settled"
      ? "done"
      : derivedWait
        ? "waiting"
        : phase === "needs_you"
          ? "needs_you"
          : phase === "running" || phase === "starting" ? "working" : "done";

  const currentLabel = currentColumn === "waiting"
    ? `Waiting · ${derivedWait}`
    : currentColumn === "needs_you"
      ? "Needs you"
      : currentColumn === "snoozed"
        ? "Snoozed"
        : currentColumn === "working"
          ? "Working"
          : "Done";

  const options: SessionStatusOption[] = [
    {
      target: "working",
      label: "Working",
      enabled: workingBlockedReason == null,
      current: currentColumn === "working",
      reason: workingBlockedReason,
    },
    {
      target: "needs_you",
      // Always available: parking a row for yourself is never a lie, even on a
      // row that is mid-turn (the write asks the agent to stop and check in).
      label: "Needs you",
      enabled: true,
      current: currentColumn === "needs_you",
      reason: null,
    },
    {
      target: "snoozed",
      // Snooze is a visibility overlay, so it is always safe.
      label: "Snoozed",
      enabled: true,
      current: snoozed,
      reason: null,
    },
    {
      target: "done",
      label: "Done",
      enabled: doneBlockedReason == null,
      current: currentColumn === "done" && phase === "settled",
      reason: doneBlockedReason,
    },
  ];

  return { options, snoozed, currentLabel };
}
