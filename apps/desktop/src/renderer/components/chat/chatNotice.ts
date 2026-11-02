import type { NoticeKind } from "../ui/notice";
import { isRemoteRuntimeConnectionError } from "../../../shared/runtimeErrors";

/**
 * The one line a chat pane shows above its composer. Its kind (see
 * `NoticeKind`) decides how it looks: a caught error is a `failure`; an
 * offline machine or a slow send is a `status`; a missing model is a `hint`.
 */
export type ChatNotice = { message: string; kind: NoticeKind };

/**
 * What a pane's `setError` takes: a message (a failure), a notice of another
 * kind, `null` to clear, or a function of the current message — which is what
 * "clear it if it is still mine" needs. Shaped so a hook that only knows
 * `(message: string | null) => void` can be handed the pane's dispatch.
 */
export type ChatNoticeAction =
  | string
  | ChatNotice
  | null
  | ((current: string | null) => string | null);

/**
 * Said instead of "Error invoking remote method 'ade.remoteRuntime.callAction':
 * Error: Remote ADE service connection closed." The pane's own call to the
 * chat's machine lost its connection; the chat itself keeps running there.
 */
export const CHAT_MACHINE_CONNECTION_DROPPED_NOTICE =
  "The connection to this chat's machine dropped for a moment. The chat keeps running there, and ADE reconnects by itself. If something you just did is missing, do it again.";

/** A caught message as a notice: a dropped connection is a status, anything else a failure. */
function noticeFromMessage(message: string): ChatNotice {
  return isRemoteRuntimeConnectionError(message)
    ? { message: CHAT_MACHINE_CONNECTION_DROPPED_NOTICE, kind: "status" }
    : { message, kind: "failure" };
}

/** `useReducer(chatNoticeReducer, null)`: its dispatch is stable, like a state setter. */
export function chatNoticeReducer(current: ChatNotice | null, action: ChatNoticeAction): ChatNotice | null {
  if (typeof action === "function") {
    const message = action(current?.message ?? null);
    if (!message) return null;
    return message === current?.message ? current : noticeFromMessage(message);
  }
  if (!action) return null;
  return typeof action === "string" ? noticeFromMessage(action) : action;
}
