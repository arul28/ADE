import { machineIdForBinding } from "../../../../shared/machineIdentity";
import type { DeletedLaneSnapshot, OpenProjectBinding, RestoreDeletedLaneResult } from "../../../../shared/types";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { READABLE_TOAST_DURATION_MS, type ToastInput } from "./toastStore";

/**
 * Opens a chat in Work on the machine it lives on. The chat can be seconds
 * old, so Work's list may not hold it yet: the select event loads it first (a
 * `?sessionId=` link would be dropped as unknown), the route the command
 * palette takes.
 */
export function openChatInWork(chat: { chatSessionId: string; laneId: string }, pin: OpenProjectBinding | null): void {
  window.dispatchEvent(new CustomEvent("ade:work:select-session", {
    detail: { sessionId: chat.chatSessionId, laneId: chat.laneId, ...(pin ? { binding: pin } : {}) },
  }));
  navigateToAppTarget({ kind: "work" });
}

/** The toast's buttons for a restore that ran on `pin`'s machine: the lane, and its newest chat. */
export function restoredLaneOpeners(
  result: Pick<RestoreDeletedLaneResult, "lane" | "reopenedChats">,
  pin: OpenProjectBinding | null,
): { lane: () => void; chat?: () => void } {
  const newest = result.reopenedChats?.[result.reopenedChats.length - 1] ?? null;
  return {
    lane: () => navigateToAppTarget({ kind: "lane", laneId: result.lane.id, machineId: machineIdForBinding(pin) }),
    ...(newest ? { chat: () => openChatInWork({ chatSessionId: newest.chatSessionId, laneId: result.lane.id }, pin) } : {}),
  };
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
 * What a finished lane restore says, wherever it was started. `open` adds the
 * buttons: the lane, and the newest chat that came back with it.
 */
export function restoredLaneToast(
  lane: Pick<DeletedLaneSnapshot, "laneName" | "uncommitted" | "kind">,
  result: RestoreDeletedLaneResult,
  open?: { lane?: () => void; chat?: () => void },
): Pick<ToastInput, "tone" | "title" | "message" | "durationMs" | "replayMask" | "actions"> {
  const onBranch = `On branch ${result.branchName}`;
  const body = !result.restoredUncommitted
    ? `${onBranch}. Its uncommitted files did not apply and stay saved: ${result.warning ?? "unknown error"}`
    : `${onBranch}${lane.uncommitted ? ", with its uncommitted files" : ""}.`;
  const other = result.extraBranches.length > 0 ? ` Other commits it kept are on ${result.extraBranches.join(", ")}.` : "";
  const chats = chatsSentence(result);
  const actions: NonNullable<ToastInput["actions"]> = [];
  if (open?.lane) actions.push({ label: "Open lane", onClick: open.lane });
  if (open?.chat && (result.reopenedChats?.length ?? 0) > 0) actions.push({ label: "Open chat", onClick: open.chat });
  return {
    tone: result.restoredUncommitted && !(result.chatsNotReopened ?? 0) ? "success" : "warning",
    title: lane.kind === "freed" ? `${lane.laneName}'s files are back` : `${lane.laneName} is back`,
    message: `${body}${other}${chats ? ` ${chats}` : ""}`,
    durationMs: READABLE_TOAST_DURATION_MS,
    replayMask: { title: true, message: true },
    ...(actions.length > 0 ? { actions } : {}),
  };
}
