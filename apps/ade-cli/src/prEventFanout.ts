import type { PrEventPayload } from "../../desktop/src/shared/types/prs";

export function createPrEventFanout(
  ...emitters: Array<(event: PrEventPayload) => void>
): (event: PrEventPayload) => void {
  return (event) => {
    for (const emit of emitters) {
      try {
        emit(event);
      } catch {
        // Keep independent PR event sinks isolated from each other.
      }
    }
  };
}
