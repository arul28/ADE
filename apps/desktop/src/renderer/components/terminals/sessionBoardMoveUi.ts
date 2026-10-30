import { showToast } from "../app/toast/toastStore";
import { WORK_BOARD_COLUMN_LABEL, type WorkBoardMoveTarget } from "../../../shared/types/chat";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";

/**
 * Apply a board move and own its whole user-visible result: the toast, the
 * Undo, and the words for every way the host can refuse.
 *
 * The board's drop handler and the row menu's "Change status" entries are the
 * same act, so they must not each carry their own copy of "why didn't that
 * work" — a second copy is where "Already working" and "The PR is what is
 * waiting" drift apart. `session.moveOnBoard` owns the write and the message;
 * this owns the narration.
 *
 * `onMoved`/`onUndoSettled` are the host surface's local bookkeeping (pulses,
 * a cross-machine refresh). `onMoved` runs only when the write landed;
 * `onUndoSettled` runs once the host answers an undo, refused or not, since
 * either way the host's state may have changed under the card.
 */
export function moveSessionOnBoard(args: {
  session: TerminalSessionSummary;
  to: WorkBoardMoveTarget;
  binding?: OpenProjectBinding | null;
  onMoved?: () => void;
  onUndoSettled?: () => void;
}): void {
  const { session, to, binding } = args;
  const move = window.ade.sessions?.moveOnBoard;
  if (typeof move !== "function") {
    showToast({
      title: "Move failed",
      message: "This window cannot move board cards.",
      tone: "error",
    });
    return;
  }
  void move(session.id, to, binding)
    .then((result) => {
      if (!result?.changed || !result.moveId) {
        // A no-op is ALWAYS a disagreement here: every caller only offers a
        // column the row is not already in, so "it is already there" means the
        // two derived it differently. They can, in exactly one way — the host
        // files Waiting from the snooze alone, while the renderer also parks a
        // running row there for a pending check or an outstanding review,
        // which the host still reads as Working. Say so; a silent snap-back
        // reads as a bug.
        if (result && !result.changed) {
          // A live structured card is a different refusal: the row really is
          // in Needs you, and clearing the attention columns would not answer
          // the provider's question — so the card would sit there while the
          // toast claimed a move. Say what is actually blocking.
          const pendingCard = result.reason === "pending_input";
          const working = result.reason === "turn_running";
          showToast({
            id: `session-board-move:${session.id}`,
            title: pendingCard
              ? "Answer the question first"
              : working
                ? "Still working"
                : `Already ${WORK_BOARD_COLUMN_LABEL[result.from].toLowerCase()}`,
            message: pendingCard
              ? "This chat is waiting on an answer, so moving it would not change what it needs."
              : working
                ? "A chat can be moved to Done once its turn ends."
                : "The PR is what is waiting, not the chat.",
            durationMs: 4_000,
          });
        }
        return;
      }
      const moveId = result.moveId;
      args.onMoved?.();
      showToast({
        id: `session-board-move:${session.id}`,
        title: `Moved to ${WORK_BOARD_COLUMN_LABEL[to]}`,
        message: result.message ? "The agent will be told." : undefined,
        durationMs: 5_000,
        actions: [{
          label: "Undo",
          onClick: () => {
            const undo = window.ade.sessions?.undoBoardMove;
            if (typeof undo !== "function") return;
            void undo(session.id, moveId, binding)
              .then((undone) => {
                args.onUndoSettled?.();
                if (undone?.ok === false) {
                  showToast({
                    title: "Too late to undo",
                    message: undone.reason === "unknown_move"
                      // The host restarted inside the undo window: the columns
                      // are written, the message was never sent, and it no
                      // longer knows what to put back.
                      ? "ADE no longer has this move staged. The card stays where you put it."
                      : undone.reason === "session_advanced"
                        // The chat moved on inside the window — a new hand, a
                        // settle, a snooze. Putting the old state back would
                        // overwrite something newer than the move.
                        ? "This chat has changed since the move, so there is nothing left to take back."
                        : "The agent has already been told about this move.",
                    tone: "error",
                  });
                }
              })
              .catch((error: unknown) => {
                showToast({
                  title: "Undo failed",
                  message: error instanceof Error ? error.message : String(error),
                  tone: "error",
                });
              });
          },
        }],
      });
    })
    .catch((error: unknown) => {
      showToast({
        title: "Move failed",
        // The host reverses its own status write when the move cannot
        // complete, so the card genuinely did not move.
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    });
}
