import type { NoticeKind } from "../ui/notice";

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

/** `useReducer(chatNoticeReducer, null)`: its dispatch is stable, like a state setter. */
export function chatNoticeReducer(current: ChatNotice | null, action: ChatNoticeAction): ChatNotice | null {
  if (typeof action === "function") {
    const message = action(current?.message ?? null);
    if (!message) return null;
    return message === current?.message ? current : { message, kind: "failure" };
  }
  if (!action) return null;
  return typeof action === "string" ? { message: action, kind: "failure" } : action;
}
