import type { OpenProjectBinding } from "../../shared/types";

/**
 * Stable identity for a pin, for keying caches. `bound` for the tab's binding.
 * In a file of its own: `projectMachines.ts` imports the app store, and the
 * link opener needs only this.
 */
export function pinKey(pin: OpenProjectBinding | null | undefined): string {
  return pin ? pin.key : "bound";
}
