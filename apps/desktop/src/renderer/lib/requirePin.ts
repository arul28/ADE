import type { OpenProjectBinding } from "../../shared/types";

/** What a user action says when the computer it needs is not online. */
export const NO_PROJECT_COMPUTER_ONLINE = "No computer with this project is online.";

/**
 * The pin a user action calls through, or an error with `message` when there
 * is none. Use it inside an action's try block, so the person reads why
 * nothing happened and no call takes the tab's default route.
 */
export function requirePin(
  pin: OpenProjectBinding | null | undefined,
  message: string = NO_PROJECT_COMPUTER_ONLINE,
): OpenProjectBinding {
  if (!pin) throw new Error(message);
  return pin;
}
