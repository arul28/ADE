import type { OpenProjectBinding } from "../../shared/types";
import { cacheScopePin } from "../lib/tabBindingKey";

/**
 * Stable identity for a pin, for keying caches. `bound` for the tab's binding,
 * whether the caller names the tab's copy or passes no pin. In a file of its
 * own: `projectMachines.ts` imports the app store, and the link opener needs
 * only this.
 */
export function pinKey(rawPin: OpenProjectBinding | null | undefined): string {
  const pin = cacheScopePin(rawPin);
  return pin ? pin.key : "bound";
}
