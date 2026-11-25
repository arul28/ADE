/**
 * A move of this ADE Cloud computer to a new one, as its ADE sees it.
 *
 * The account server runs the move (`moves.ts`) and marks this computer from
 * the making of the new one (`moveOutMarkCommand`,
 * `$ADE_HOME/cloud/moving.json`, `{ until }`): the move stops this ADE and
 * would cut a turn started then. Meanwhile what starts a turn from another
 * device (`CHAT_TURN_STARTS` below, the one list both channels read) is
 * refused with `computer_moving`: on the paired channel (`cli.ts`, the
 * desktop) and over sync (`syncRemoteCommandService.ts`, ADE Web and the
 * phone). A chat made with no turn (`chat.create`) is not refused. The
 * desktop and ADE Web then send a message to a chat that exists to the
 * account's queue, which the move holds and hands to the new computer. A new
 * chat has no queue: the sender shows the sentence (a first message stays in
 * the composer; a launch fails with it). The queue's own sends
 * (`ade cloud messages drain`) reach the chats directly and are never
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

/**
 * What starts a turn from another device: each chat action by its paired
 * channel name (an `ade/actions/call` `chat.<action>`) and, where ADE Web and
 * the phone have it, its sync command. `kickoff`: only with a first message.
 */
const CHAT_TURN_STARTS: ReadonlyArray<{ action: string; sync?: string; kickoff?: true }> = [
  { action: "sendMessage", sync: "chat.send" }, // a person's message to a chat it has
  { action: "messageSession" }, // `ade chat send --machine`
  { action: "sendDraftNow", sync: "chat.sendDraftNow" },
  { action: "createSessionAndSend" }, // a new chat with its first message
  { action: "launchHeadless", sync: "chat.launch", kickoff: true },
  { action: "startLaunch", sync: "chat.startLaunch" }, // a new-lane launch
  { action: "retryLaunch", sync: "chat.retryLaunch" },
  { action: "startLaunchNow", sync: "chat.startLaunchNow" },
  { action: "launchCli", sync: "chat.launchCli" }, // a CLI with its first turn
];

/** The sync commands of `CHAT_TURN_STARTS` (`chat.launch` always has its kickoff). */
export const CLOUD_MOVE_SYNC_TURN_STARTS: ReadonlySet<string> = new Set(
  CHAT_TURN_STARTS.flatMap((entry) => (entry.sync ? [entry.sync] : [])),
);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a paired channel `ade/actions/call` (its params) starts a turn (`CHAT_TURN_STARTS`). */
export function isRemoteChatTurnStart(params: unknown): boolean {
  if (!isObject(params) || params.name !== "run_ade_action" || !isObject(params.arguments)) return false;
  const { domain, action, args } = params.arguments;
  if (typeof domain !== "string" || domain.trim() !== "chat" || typeof action !== "string") return false;
  const entry = CHAT_TURN_STARTS.find((candidate) => candidate.action === action.trim());
  if (!entry) return false;
  return !entry.kickoff || (isObject(args) && typeof args.kickoffText === "string" && args.kickoffText.trim().length > 0);
}

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
