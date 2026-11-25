import type { AgentChatFileRef, OpenProjectBinding } from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { chatSendReach } from "../../state/cloudSavedChats";
import type { AgentChatApi } from "./agentChatApi";
import { withChatPin } from "./chatMachinePin";
import { hasHeldAttachments, stageHeldAttachments } from "./heldChatAttachments";
import { threadCommentsHeldOnDevice } from "./threadCommentsHeldOnDevice";
import { handOverHeldThreadComments } from "./threadCommentsStore";

function notReached(what: "files" | "comments", error: unknown): Error {
  const reason = stripElectronErrorWrapper(error instanceof Error ? error.message : String(error));
  return new Error(`Your ${what} didn't reach the chat's machine, so nothing was sent. ${reason}`);
}

/**
 * What a send carries that this device kept while the chat's ADE Cloud
 * computer rested goes to that computer now, right before the message (the
 * send wakes it anyway), the way the send reaches it (`chatSendReach`):
 *
 * - Files kept here (`heldChatAttachments.ts`) are copied there, in order,
 *   and come back named by their paths there. A file already copied for an
 *   earlier try of this send is not copied again.
 * - Comments kept here, and edits, ticks and deletes of the host's comments
 *   (`threadCommentsHeldOnDevice.ts`), are handed to its host, so it builds
 *   the same review block as for any comment, before the send's exclusion
 *   list is read, which names what stays here. A send that carries the
 *   chat's comments always hands them over. Any other send does too while
 *   the computer is awake, so a delete or untick of the last comment reaches
 *   the host and every other device; while it rests such a send goes to the
 *   account's queue without waiting for the wake, and they go with the first
 *   send once it is awake.
 *
 * Throws a sentence when either can't reach the machine: nothing is sent,
 * and each file and comment that did not go stays here. `stagedHeldPaths`
 * are the stand-in paths of the files copied (empty when none was held), for
 * `releaseSentHeldAttachments`. `commentsHandedOver` says the store's
 * comments changed, so the send reads them again.
 */
export async function prepareDeviceHeldForSend(args: {
  api: AgentChatApi;
  /** The chat the send goes to; null for a draft's first send. */
  sessionId: string | null;
  /** The send's pin: the chat's, or the draft's machine. */
  pin: OpenProjectBinding | null;
  attachments: AgentChatFileRef[];
  /** The send carries the chat's thread comments. */
  carriesComments: boolean;
  /** The chat's ADE Cloud computer rests now (`ChatRuntimeScope.machineRests`). */
  machineRests: boolean;
}): Promise<{ attachments: AgentChatFileRef[]; stagedHeldPaths: string[]; commentsHandedOver: boolean }> {
  const { api, sessionId, pin } = args;
  const reach = sessionId ? chatSendReach(api) : null;
  const onSendMachine = <T>(write: (pin: OpenProjectBinding) => Promise<T>): Promise<T> =>
    withChatPin(pin, (chatPin) => (reach && sessionId ? reach(sessionId, chatPin, write) : write(chatPin)));

  let attachments = args.attachments;
  let stagedHeldPaths: string[] = [];
  if (hasHeldAttachments(attachments)) {
    try {
      ({ attachments, stagedHeldPaths } = await stageHeldAttachments(attachments, {
        machineKey: pin?.key ?? "",
        save: (file) => onSendMachine((callPin) => api.saveTempAttachment(file, callPin)),
      }));
    } catch (error) {
      throw notReached("files", error);
    }
  }

  const commentsHandedOver = Boolean(
    sessionId && (args.carriesComments || !args.machineRests) && threadCommentsHeldOnDevice(sessionId),
  );
  if (sessionId && commentsHandedOver) {
    try {
      await handOverHeldThreadComments(sessionId, pin, api.threadComments, onSendMachine);
    } catch (error) {
      throw notReached("comments", error);
    }
  }
  return { attachments, stagedHeldPaths, commentsHandedOver };
}
