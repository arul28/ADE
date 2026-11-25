import { cloudLaneJobHoldsSends, type CloudLaneJobSnapshot, type CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import { PENDING_INPUT_SEND_BLOCKED_MESSAGE } from "../../../shared/pendingInputAnswers";
import {
  CHAT_MOVE_HOLDS_FILES_MESSAGE,
  SAVED_CHAT_COMPUTER_GONE_MESSAGE,
  type SavedChatLocation,
} from "../../state/cloudSavedChats";

/** The message stays in the box, with a line why. */
export type ChatQueueStay = { kind: "stay"; message: string; tone: "hint" | "status" };

/**
 * Where Send goes for an ADE Cloud chat whose computer can't take it now:
 * - `stay`: nowhere; the message stays in the box with a line why.
 * - `queue`: the account's queue, by the chat's computer's account key
 *   (account level, no pin). `unsupported` is what a server or client
 *   without the queue does instead.
 */
export type ChatAccountQueueRoute =
  | ChatQueueStay
  | { kind: "queue"; machineKey: string | null; unsupported: ChatQueueStay | { kind: "freed_lane"; lane: CloudLaneWithoutComputer } };

const stay = (message: string, tone: ChatQueueStay["tone"]): ChatQueueStay => ({ kind: "stay", message, tone });

/**
 * The account-queue route of one Send in an open chat, or null to send as
 * usual (`AgentChatPane` submit).
 *
 * - The chat's lane is moving to a new computer or changing size
 *   (`laneJob` running): its ADE stops for minutes. The queue takes the text
 *   and holds it until the change is done (`cloudLaneJobHoldsSends`), then
 *   the chat's computer sends it (a move's new one, or the same one after
 *   its restart). Files and thread comments go with a live send only; a size
 *   change before its resize was asked still answers, but its restart would
 *   cut the turn: both stay in the box.
 * - The chat's computer is gone (a lane kept without a computer, or a
 *   deleted computer's saved chat): the queue takes it and a new computer
 *   continues this same chat. Without the queue, a freed lane starts a new
 *   chat on a new computer.
 */
export function chatAccountQueueRoute(input: {
  /** The chat lane's job that shows now (`useChatCloudLaneJob`). */
  laneJob: CloudLaneJobSnapshot | null;
  /** Files, context or thread comments ride with this send. */
  carriesFiles: boolean;
  /** An input the chat waits for blocks every send. */
  pendingInput: boolean;
  /** The chat's saved copy on ADE Cloud, when its machine is offline or gone (`savedChatLocation`). */
  savedLocation: SavedChatLocation | null;
  /**
   * The queue's address of the chat: its computer's account key, as its saved
   * copy or its connection names it (`chatQueueMachineKey`); null when neither does.
   */
  queueMachineKey: string | null;
  /** The lane kept without a computer the chat ran on. */
  freedLane: CloudLaneWithoutComputer | null;
}): ChatAccountQueueRoute | null {
  const { laneJob, savedLocation, freedLane } = input;
  if (laneJob?.phase === "running") {
    const move = laneJob.kind === "move";
    const staysHere = stay(move
      ? "This chat's computer is moving. Your message stays here; send it once the move is done."
      : "This chat's computer is changing size. Your message stays here; send it once it is back.", "hint");
    if (input.carriesFiles) {
      return stay(move
        ? CHAT_MOVE_HOLDS_FILES_MESSAGE
        : "Files and comments can't go while this chat's computer changes size. They stay here; send them once it is back.", "hint");
    }
    if (!cloudLaneJobHoldsSends(laneJob)) return staysHere;
    if (input.pendingInput) return stay(PENDING_INPUT_SEND_BLOCKED_MESSAGE, "status");
    // Else the job's own computer.
    return { kind: "queue", machineKey: input.queueMachineKey ?? laneJob.machineKey, unsupported: staysHere };
  }
  if (freedLane || savedLocation?.computerGone) {
    if (input.pendingInput) return stay(PENDING_INPUT_SEND_BLOCKED_MESSAGE, "status");
    return {
      kind: "queue",
      machineKey: savedLocation?.machineKey ?? freedLane?.formerMachineKey ?? null,
      unsupported: freedLane ? { kind: "freed_lane", lane: freedLane } : stay(SAVED_CHAT_COMPUTER_GONE_MESSAGE, "status"),
    };
  }
  return null;
}
