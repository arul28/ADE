/**
 * A move of this ADE Cloud computer to a new one, as its ADE sees it.
 *
 * The account server runs the move (`moves.ts`) and marks this computer from
 * the making of the new one (`moveOutMarkCommand`,
 * `$ADE_HOME/cloud/moving.json`, `{ until }`): the move stops this ADE and
 * would cut a turn started then. Meanwhile what starts a turn from another
 * device (`REMOTE_TURN_STARTS` below, the one list both channels read) is
 * refused with `computer_moving`: on the paired channel (`cli.ts`, the
 * desktop) and over sync (`syncRemoteCommandService.ts`, ADE Web and the
 * phone). That includes text typed into a CLI and a CLI started with its
 * first input: a CLI's process does not survive the move, so the text would
 * be lost. A chat made with no turn (`chat.create`) and a terminal started
 * with no first input are not refused. The desktop and ADE Web then send a
 * message to a chat that exists to the account's queue, which the move holds
 * and hands to the new computer. A new
 * chat has no queue: the sender shows the sentence (a first message stays in
 * the composer; a launch fails with it; `ade chat create --prompt --machine`
 * deletes the chat it made, `isCloudMoveRefusal`). The queue's own sends
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
import { codedError, isCodedError } from "../../../../desktop/src/shared/codedError";
import { markExpected } from "../../../../desktop/src/shared/expectedError";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

/**
 * What starts a turn from another device: each action by its paired channel
 * name (an `ade/actions/call` `<domain>.<action>`) and, where ADE Web and the
 * phone have it, its sync command. `kickoff`: only when its args (on either
 * channel) carry a first message or first input.
 */
type TurnStart = {
  domain: "chat" | "pty";
  action: string;
  sync?: string;
  kickoff?: (args: Record<string, unknown>) => boolean;
};

const REMOTE_TURN_STARTS: ReadonlyArray<TurnStart> = [
  { domain: "chat", action: "sendMessage", sync: "chat.send" }, // a person's message to a chat it has
  { domain: "chat", action: "messageSession" }, // `ade chat send --machine`
  { domain: "chat", action: "sendDraftNow", sync: "chat.sendDraftNow" },
  { domain: "chat", action: "createSessionAndSend" }, // a new chat with its first message
  { domain: "chat", action: "launchHeadless", sync: "chat.launch", kickoff: (args) => hasText(args.kickoffText) },
  { domain: "chat", action: "startLaunch", sync: "chat.startLaunch" }, // a new-lane launch
  { domain: "chat", action: "retryLaunch", sync: "chat.retryLaunch" },
  { domain: "chat", action: "startLaunchNow", sync: "chat.startLaunchNow" },
  { domain: "chat", action: "launchCli", sync: "chat.launchCli" }, // a CLI with its first turn
  { domain: "chat", action: "typeIntoCli", sync: "chat.typeIntoCli" }, // text for a running agent CLI
  // A terminal with its first input (a CLI's prompt, a shell's command). A
  // desktop CLI launch carries its prompt in `runtimeCliLaunch`; ADE Web's
  // and the phone's `work.startCliSession` in `initialInput`.
  {
    domain: "pty",
    action: "create",
    sync: "work.startCliSession",
    kickoff: (args) => hasText(args.initialInput) || (isObject(args.runtimeCliLaunch) && hasText(args.runtimeCliLaunch.initialPrompt)),
  },
  { domain: "pty", action: "sendToSession", sync: "work.sendToSession" }, // text for a CLI, resumed if it ended
];

const startsTurn = (entry: TurnStart | undefined, args: unknown): boolean =>
  entry !== undefined && (!entry.kickoff || (isObject(args) && entry.kickoff(args)));

/** Whether a paired channel `ade/actions/call` (its params) starts a turn (`REMOTE_TURN_STARTS`). */
export function isRemoteTurnStart(params: unknown): boolean {
  if (!isObject(params) || params.name !== "run_ade_action" || !isObject(params.arguments)) return false;
  const { domain, action, args } = params.arguments;
  if (typeof domain !== "string" || typeof action !== "string") return false;
  const entry = REMOTE_TURN_STARTS.find((candidate) => candidate.domain === domain.trim() && candidate.action === action.trim());
  return startsTurn(entry, args);
}

/** Whether a sync command (its action and args) starts a turn (`REMOTE_TURN_STARTS`). */
export function isSyncTurnStart(action: string, args: unknown): boolean {
  return startsTurn(REMOTE_TURN_STARTS.find((candidate) => candidate.sync === action), args);
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
 * The refusal of a turn start from another device (`REMOTE_TURN_STARTS`)
 * while a move holds this ADE Cloud computer, coded `computer_moving`; null
 * when none holds it, and always on any other machine.
 */
export function cloudMoveSendRefusal(adeHome: string): (Error & { code: string }) | null {
  if (!isAdeCloudComputer() || !cloudMovingOut(adeHome)) return null;
  // An answer, not a failure: the sender queues the message or tells the person.
  return markExpected(codedError(CLOUD_COMPUTER_MOVING_SENTENCE, CLOUD_COMPUTER_MOVING_CODE), "user");
}

/**
 * Whether `error` is that refusal, as the caller of another machine gets it:
 * `--machine` (`machines.call`) puts the computer's coded message
 * (`computer_moving: …`) inside its own words, so the code is read from the
 * text as well as from the error.
 */
export function isCloudMoveRefusal(error: unknown): boolean {
  if (isCodedError(error, CLOUD_COMPUTER_MOVING_CODE)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(`${CLOUD_COMPUTER_MOVING_CODE}: `);
}
