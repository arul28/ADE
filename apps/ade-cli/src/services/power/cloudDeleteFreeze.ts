/**
 * The write freeze before a server delete of an awake ADE Cloud computer.
 *
 * A plan change, the end of an automation run or a project delete removes a
 * computer that may be awake. The server first runs
 * `ade cloud prepare-stop --for-delete`: ADE stops the agents and saves the
 * chats, then the server saves each lane's backup and deletes the computer.
 * Work that starts after that save is lost with the computer. So from the
 * start of that prepare, this brain refuses new chat turns, new terminals and
 * agent CLIs, and remote work, with one clear sentence.
 *
 * The freeze ends when the computer is deleted (the process goes with it),
 * when the prepare is not confirmed (the server then keeps the computer),
 * when the server says it keeps the computer (`ade cloud unfreeze`), or after
 * `CLOUD_DELETE_FREEZE_MS` on its own, so a computer the server never
 * deletes always recovers. One freeze per brain process: every project
 * runtime in it reads the same state.
 *
 * The person's Sleep freezes the same way, for less time
 * (`freezeCloudComputerForSleep`): from the start of its prepare until the
 * sleep, so no work lands after the lanes' backups and the computer can rest
 * saved. It holds for the prepare and `CLOUD_SLEEP_FREEZE_AFTER_PREPARE_MS`
 * after it (the server sleeps the computer as soon as the prepare answers).
 * It ends at the next wake (`liftCloudSleepFreeze`), when the server keeps
 * the computer awake (`ade cloud unfreeze`), or when that time runs out. A
 * delete's freeze always wins over a sleep's.
 */

/** The longest freeze: the server's prepare (40 s), its save for rest (4 min) and the delete, with room to spare. */
export const CLOUD_DELETE_FREEZE_MS = 10 * 60_000;

/** Said to a person or an agent whose work reaches the computer during the freeze. */
export const CLOUD_COMPUTER_REMOVING_SENTENCE =
  "This ADE Cloud computer is being removed. Its work is saved. Send again in a few minutes: ADE then continues the lane on a new computer.";

/**
 * How long the Sleep freeze holds after its prepare answered: the server's
 * sleep call, with room to spare. The server counts the save only when its
 * sleep landed sooner than this (`SLEEP_MARK_WITHIN_MS` in routes.ts).
 */
export const CLOUD_SLEEP_FREEZE_AFTER_PREPARE_MS = 30_000;

/** Said to a person or an agent whose work reaches the computer while it goes to sleep. */
export const CLOUD_COMPUTER_SLEEPING_SENTENCE =
  "This ADE Cloud computer is going to sleep, and its work is saved. Send again in a moment: ADE wakes it for your message.";

let frozenUntil = 0;
let sleepFrozenUntil = 0;

/** Starts (or extends) the freeze, from `now` for `ms`. */
export function freezeCloudComputerForDelete(now: number = Date.now(), ms: number = CLOUD_DELETE_FREEZE_MS): void {
  frozenUntil = Math.max(frozenUntil, now + Math.max(0, ms));
}

/** Starts (or extends) the person's Sleep freeze, from `now` for `ms`. */
export function freezeCloudComputerForSleep(now: number = Date.now(), ms: number = CLOUD_SLEEP_FREEZE_AFTER_PREPARE_MS): void {
  sleepFrozenUntil = Math.max(sleepFrozenUntil, now + Math.max(0, ms));
}

/** Ends every freeze (the server keeps the computer). True when one was in force. */
export function liftCloudDeleteFreeze(now: number = Date.now()): boolean {
  const wasFrozen = frozenUntil > now || sleepFrozenUntil > now;
  frozenUntil = 0;
  sleepFrozenUntil = 0;
  return wasFrozen;
}

/** Ends the Sleep freeze only (the computer woke, or its prepare was not confirmed). True when one was in force. */
export function liftCloudSleepFreeze(now: number = Date.now()): boolean {
  const wasFrozen = sleepFrozenUntil > now;
  sleepFrozenUntil = 0;
  return wasFrozen;
}

/** Whether the delete's or the Sleep's own freeze is still in force at `now` (it ran out, or the server lifted it). */
export function cloudFreezeHolds(kind: "delete" | "sleep", now: number = Date.now()): boolean {
  return (kind === "delete" ? frozenUntil : sleepFrozenUntil) > now;
}

/** The refusal sentence while a freeze is in force, else null. */
export function cloudDeleteFreezeRefusal(now: number = Date.now()): string | null {
  if (frozenUntil > now) return CLOUD_COMPUTER_REMOVING_SENTENCE;
  return sleepFrozenUntil > now ? CLOUD_COMPUTER_SLEEPING_SENTENCE : null;
}
