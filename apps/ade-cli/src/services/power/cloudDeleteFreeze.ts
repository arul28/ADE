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
 */

/** The longest freeze: the server's prepare (40 s), its save for rest (4 min) and the delete, with room to spare. */
export const CLOUD_DELETE_FREEZE_MS = 10 * 60_000;

/** Said to a person or an agent whose work reaches the computer during the freeze. */
export const CLOUD_COMPUTER_REMOVING_SENTENCE =
  "This ADE Cloud computer is being removed. Its work is saved. Send again in a few minutes: ADE then continues the lane on a new computer.";

let frozenUntil = 0;

/** Starts (or extends) the freeze, from `now` for `ms`. */
export function freezeCloudComputerForDelete(now: number = Date.now(), ms: number = CLOUD_DELETE_FREEZE_MS): void {
  frozenUntil = Math.max(frozenUntil, now + Math.max(0, ms));
}

/** Ends the freeze. True when one was in force. */
export function liftCloudDeleteFreeze(now: number = Date.now()): boolean {
  const wasFrozen = frozenUntil > now;
  frozenUntil = 0;
  return wasFrozen;
}

/** The refusal sentence while the freeze is in force, else null. */
export function cloudDeleteFreezeRefusal(now: number = Date.now()): string | null {
  return frozenUntil > now ? CLOUD_COMPUTER_REMOVING_SENTENCE : null;
}
