import type { NoticeKind } from "../ui/notice";
import { SAVED_CHAT_COMPUTER_GONE_MESSAGE } from "../../state/cloudSavedChats";

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

/**
 * The remote runtime client's words for a lost connection: "Error invoking
 * remote method 'ade.remoteRuntime.callAction': Error: Remote ADE service
 * connection closed." The local brain's socket raises them too, which is why
 * the pane asks only for a chat on another machine.
 */
const MACHINE_CONNECTION_DROPPED = /remote (?:runtime|ADE service) connection (?:(?:was )?interrupted|closed|failed)/i;

/** The paired transport's words for a machine it cannot reach: "Can't reach <name> — it may be asleep…". */
const MACHINE_UNREACHABLE = /^Can't reach (.+?)\s*[—-]+\s*it may be asleep/i;

/** An ADE Cloud computer's raw instance id ("ccgojg7vw5"), as a machine name the person never chose. */
const CLOUD_INSTANCE_ID = /^[a-z0-9]{8,12}$/;

const CHAT_MACHINE_CONNECTION_DROPPED_NOTICE =
  "The connection to this chat's machine dropped for a moment. The chat keeps running there, and ADE reconnects by itself. If something you just did is missing, do it again.";

/**
 * The notice as a pane on another machine's chat shows it: its own call to
 * that machine losing the connection is a status, not a failure, since the
 * chat keeps running there. The stored notice keeps the raw message, so
 * "clear it if it is still mine" and the draft-restore match still find it.
 */
export function shownChatNotice(
  notice: ChatNotice | null,
  chatOnAnotherMachine: boolean,
  /** The chat's cloud computer was deleted (its saved copy says so): no reconnect is coming. */
  computerGone = false,
  /** The chat's ADE Cloud lane name, only when its machine is an ADE Cloud lane computer: it is called by its lane, never by its raw id. */
  laneName: string | null = null,
): ChatNotice | null {
  if (!notice || !chatOnAnotherMachine || notice.kind !== "failure") return notice;
  const unreachable = MACHINE_UNREACHABLE.exec(notice.message);
  if (unreachable && laneName?.trim() && !computerGone && CLOUD_INSTANCE_ID.test(unreachable[1] ?? "")) {
    return { ...notice, message: notice.message.replace(unreachable[1]!, laneName.trim()) };
  }
  // A call to a deleted computer fails as a dropped or unreachable link; the
  // truth is one sentence, not "ADE reconnects by itself".
  if (computerGone && (MACHINE_CONNECTION_DROPPED.test(notice.message) || MACHINE_UNREACHABLE.test(notice.message))) {
    return { message: SAVED_CHAT_COMPUTER_GONE_MESSAGE, kind: "failure" };
  }
  return MACHINE_CONNECTION_DROPPED.test(notice.message)
    ? { message: CHAT_MACHINE_CONNECTION_DROPPED_NOTICE, kind: "status" }
    : notice;
}
