import { machineIdForBinding } from "../../../../shared/machineIdentity";
import { captureError } from "../../../../shared/sentry/capture";
import type {
  DeletedChat,
  DeletedLaneSnapshot,
  OpenProjectBinding,
  RestoreDeletedLaneResult,
  RestoredLaneChats,
} from "../../../../shared/types";
import { captureLaneSetupAnalytics } from "../../../lib/laneSetupAnalytics";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { openChatInWork } from "../../../lib/workSessionRequests";
import { READABLE_TOAST_DURATION_MS, type ToastInput } from "./toastStore";

/** What a finished lane restore shows: the toast, less its id. */
export type RestoredLaneToast = Pick<ToastInput, "tone" | "title" | "message" | "durationMs" | "replayMask" | "actions">;

/**
 * Restores a deleted lane on `pin`'s machine and returns what the toast says,
 * wherever the restore started. Its chats come back with it: the machine
 * reopens them. When the machine restores the lane alone (no chat service
 * ran the hook, or it failed), this client reopens `keptChats` there itself.
 * Throws when the lane restore fails.
 */
export async function restoreDeletedLane(
  lane: Pick<DeletedLaneSnapshot, "id" | "laneName" | "uncommitted" | "kind">,
  pin: OpenProjectBinding,
  keptChats: readonly DeletedChat[] = [],
): Promise<RestoredLaneToast> {
  let result: RestoreDeletedLaneResult;
  try {
    result = await window.ade.lanes.restoreDeleted({ id: lane.id }, pin);
  } catch (error) {
    captureLaneSetupAnalytics({ action: "deleted_lane_restored", outcome: "failed" });
    throw error;
  }
  if (result.reopenedChats === undefined && keptChats.length > 0) {
    const chats = await reopenChatsHere(keptChats, result.lane.id, pin);
    result = { ...result, reopenedChats: chats.reopened, chatsNotReopened: chats.failed };
  }
  captureLaneSetupAnalytics({ action: "deleted_lane_restored", outcome: result.restoredUncommitted ? "completed" : "failed" });
  return restoredLaneToast(lane, result, pin);
}

/** Reopens a restored lane's chats from this client. Oldest first, so the newest chat is the newest in the lane again. */
async function reopenChatsHere(
  chats: readonly DeletedChat[],
  laneId: string,
  pin: OpenProjectBinding,
): Promise<RestoredLaneChats> {
  const out: RestoredLaneChats = { reopened: [], failed: 0 };
  for (const chat of [...chats].reverse()) {
    try {
      const result = await window.ade.agentChat.reopenDeleted({ id: chat.id, laneId }, pin);
      out.reopened.push({ chatSessionId: result.chatSessionId, title: chat.title });
    } catch (error) {
      // The chat stays in Recently deleted, and the toast counts it.
      captureError(error, { fingerprint: ["recently-deleted", "restored-lane-chat-reopen"], level: "warning", handled: true });
      out.failed += 1;
    }
  }
  return out;
}

/** What the restored lane's chats did, said in one short sentence; empty when it had none. */
function chatsSentence(result: Pick<RestoreDeletedLaneResult, "reopenedChats" | "chatsNotReopened">): string {
  const back = result.reopenedChats?.length ?? 0;
  const stuck = result.chatsNotReopened ?? 0;
  const parts: string[] = [];
  if (back > 0) parts.push(back === 1 ? "Its chat is back too." : `Its ${back} chats are back too.`);
  if (stuck > 0) {
    parts.push(stuck === 1
      ? "One chat couldn't come back — it's still in Recently deleted."
      : `${stuck} chats couldn't come back — they're still in Recently deleted.`);
  }
  return parts.join(" ");
}

/**
 * What a finished lane restore says, with its buttons: the lane, and the
 * newest chat that came back with it, both on `pin`'s machine.
 */
function restoredLaneToast(
  lane: Pick<DeletedLaneSnapshot, "laneName" | "uncommitted" | "kind">,
  result: RestoreDeletedLaneResult,
  pin: OpenProjectBinding,
): RestoredLaneToast {
  const onBranch = `On branch ${result.branchName}`;
  const body = !result.restoredUncommitted
    ? `${onBranch}. Its uncommitted files did not apply and stay saved: ${result.warning ?? "unknown error"}`
    : `${onBranch}${lane.uncommitted ? ", with its uncommitted files" : ""}.`;
  const other = result.extraBranches.length > 0 ? ` Other commits it kept are on ${result.extraBranches.join(", ")}.` : "";
  const chats = chatsSentence(result);
  const newest = result.reopenedChats?.[result.reopenedChats.length - 1] ?? null;
  const actions: NonNullable<ToastInput["actions"]> = [
    { label: "Open lane", onClick: () => navigateToAppTarget({ kind: "lane", laneId: result.lane.id, machineId: machineIdForBinding(pin) }) },
  ];
  if (newest) {
    actions.push({ label: "Open chat", onClick: () => openChatInWork({ chatSessionId: newest.chatSessionId, laneId: result.lane.id }, pin) });
  }
  return {
    tone: result.restoredUncommitted && !(result.chatsNotReopened ?? 0) ? "success" : "warning",
    title: lane.kind === "freed" ? `${lane.laneName}'s files are back` : `${lane.laneName} is back`,
    message: `${body}${other}${chats ? ` ${chats}` : ""}`,
    durationMs: READABLE_TOAST_DURATION_MS,
    replayMask: { title: true, message: true },
    actions,
  };
}
