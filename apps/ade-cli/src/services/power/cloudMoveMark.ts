/**
 * A move of this ADE Cloud computer to a new one, as its ADE sees it.
 *
 * The account server runs the move (`moves.ts`) and marks this computer from
 * the making of the new one (`moveOutMarkCommand`,
 * `$ADE_HOME/cloud/moving.json`, `{ until }`): the move stops this ADE and
 * would cut a turn started then. Meanwhile what starts a turn from another
 * device is refused with `computer_moving`, exactly:
 * - on the paired channel (`cli.ts`, the desktop): `chat.sendMessage`,
 *   `chat.sendDraftNow`, `chat.createSessionAndSend`, `chat.startLaunch`,
 *   `chat.launchCli`, and `chat.launchHeadless` with a kickoff;
 * - over sync (`syncRemoteCommandService.ts`, ADE Web and the phone):
 *   `chat.send` and `chat.launch`.
 * A chat made with no turn (`chat.create`) is not refused. The desktop and
 * ADE Web then send a message to a chat that exists to the account's queue,
 * which the move holds and hands to the new computer. A new chat has no
 * queue: the sender shows the sentence (a first message stays in the
 * composer; a launch fails with it). The queue's own
 * sends (`ade cloud messages drain`) reach the chats directly and are never
 * refused: the server lists none while the move holds them.
 *
 * The move's undo clears the mark (the old computer goes on as before), and
 * it goes with this computer when the move lands. A mark the undo missed
 * expires with the move's hold; until then a refused send only takes the
 * queue's way to the same chat. Read per send, never polled.
 */

import fs from "node:fs";
import path from "node:path";
import { CLOUD_MOVING_MARK_FILE } from "../../../../account-directory/src/cloud/computerCommands";
import { CLOUD_COMPUTER_MOVING_CODE, CLOUD_COMPUTER_MOVING_SENTENCE } from "../../../../account-directory/src/cloud/contract";
import { isAdeCloudComputer } from "../../../../desktop/src/main/services/adeCloud/cloudComputerRules";
import { codedError } from "../../../../desktop/src/shared/codedError";
import { markExpected } from "../../../../desktop/src/shared/expectedError";

/** Whether a move holds this computer now. A stale mark is removed. */
export function cloudMovingOut(adeHome: string, now: number = Date.now()): boolean {
  const file = path.join(adeHome, "cloud", CLOUD_MOVING_MARK_FILE);
  try {
    const mark = JSON.parse(fs.readFileSync(file, "utf8")) as { until?: unknown };
    if (typeof mark.until === "number" && mark.until > now) return true;
    fs.rmSync(file, { force: true });
  } catch {
    // No mark (the usual case), or one ADE can't read: sends go on as before.
  }
  return false;
}

/**
 * The refusal of a person's chat send from another device while a move holds
 * this ADE Cloud computer, coded `computer_moving`; null when none holds it,
 * and always on any other machine.
 */
export function cloudMoveSendRefusal(adeHome: string): (Error & { code: string }) | null {
  if (!isAdeCloudComputer() || !cloudMovingOut(adeHome)) return null;
  // An answer, not a failure: the sender queues the message or tells the person.
  return markExpected(codedError(CLOUD_COMPUTER_MOVING_SENTENCE, CLOUD_COMPUTER_MOVING_CODE), "user");
}
