import type { AccountProjectMainResult } from "./accountProjectSync";

/**
 * "Use for new lanes": the folder of a project that new lanes on this
 * computer start from. Two doors lead here from another device:
 *
 * - the sync command `projects.setMainCheckout` (the phone's Location
 *   screen and Start on picker use it);
 * - the runtime method `projects.setMainCheckout`, advertised as the
 *   `projects.setMainCheckout` capability for another computer's window. No
 *   desktop or CLI caller uses it yet.
 *
 * Only the brain that publishes this computer's projects to the account (the
 * one that holds the sync-host lease) can change it, because the choice lives
 * in that brain's account project state and goes out with its next publish.
 * That brain provides the handler; every other process answers
 * `not_publishing`.
 */

type MainCheckoutHandler = (checkoutId: string) => Promise<AccountProjectMainResult>;

let handler: MainCheckoutHandler | null = null;

/** The publishing brain sets the handler; it clears it when it stops publishing. */
export function provideAccountProjectMainHandler(next: MainCheckoutHandler | null): void {
  handler = next;
}

export async function setAccountProjectMainCheckout(checkoutId: unknown): Promise<AccountProjectMainResult> {
  const id = typeof checkoutId === "string" ? checkoutId.trim() : "";
  if (!id) return { ok: false, code: "not_a_copy", message: "Name the folder to use for new lanes." };
  if (!handler) {
    return { ok: false, code: "not_publishing", message: "This computer is not sending its projects to your ADE account right now." };
  }
  return await handler(id);
}
