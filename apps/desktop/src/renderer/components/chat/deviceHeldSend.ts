import type { AgentChatFileRef, OpenProjectBinding } from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { chatSendReach } from "../../state/cloudSavedChats";
import type { AgentChatApi } from "./agentChatApi";
import { withChatPin } from "./chatMachinePin";
import { hasHeldAttachments, stageHeldAttachments } from "./heldChatAttachments";
import { threadCommentsHeldOnDevice } from "./threadCommentsHeldOnDevice";
import { handOverHeldThreadComments } from "./threadCommentsStore";

/**
 * The sentence a send shows when what this device kept could not go: what
 * happened, on which machine, and that everything is still here to try again.
 * The transport's own reason goes to the log, not to the person: it named a
 * connection, not something they can act on.
 */
function notReached(what: "files" | "comments", machineName: string | null | undefined, error: unknown): Error {
  const reason = stripElectronErrorWrapper(error instanceof Error ? error.message : String(error));
  console.warn(`[chat] held ${what} did not reach the chat's machine`, reason);
  const machine = machineName?.trim() || "the chat's computer";
  return new Error(what === "files"
    ? `Not sent. ADE couldn't copy your files to ${machine}. Your message and files are still in the box, so press Send to try again.`
    : `Not sent. ADE couldn't hand your comments to ${machine}. Your message and comments are still here, so press Send to try again.`);
}

/**
 * What a send carries that this device kept while the chat's ADE Cloud
 * computer rested goes to that computer now, right before the message (the
 * send wakes it anyway), the way the send reaches it (`chatSendReach`) while
 * it still rests, else straight through the chat's own pin:
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
  /** The chat's machine as the pane names it, for the sentence a failure shows. */
  machineName?: string | null;
}): Promise<{ attachments: AgentChatFileRef[]; stagedHeldPaths: string[]; commentsHandedOver: boolean }> {
  const { api, sessionId, pin } = args;
  // Only a resting computer is reached another way (its machine key, a wake).
  // A chat whose machine is up gets what was kept here straight through its
  // own pin, even a file kept while it rested: nothing may send it elsewhere.
  const reach = sessionId && args.machineRests ? chatSendReach(api) : null;
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
      throw notReached("files", args.machineName, error);
    }
  }

  const commentsHandedOver = Boolean(
    sessionId && (args.carriesComments || !args.machineRests) && threadCommentsHeldOnDevice(sessionId),
  );
  if (sessionId && commentsHandedOver) {
    try {
      await handOverHeldThreadComments(sessionId, pin, api.threadComments, onSendMachine);
    } catch (error) {
      throw notReached("comments", args.machineName, error);
    }
  }
  return { attachments, stagedHeldPaths, commentsHandedOver };
}
