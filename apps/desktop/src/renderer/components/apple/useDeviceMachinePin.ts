import type { OpenProjectBinding } from "../../../shared/types/core";
import { effectiveRuntimeBinding } from "../../lib/chatMachineRouting";
import { useTabCopyPin } from "../../state/repositoryScope";

/**
 * The machine a lane's device (simulator, emulator) lives on, as a pin.
 *
 * The host passes the lane's or session's pin. Work passes null when it knows
 * no session yet (a draft chat on a lane of the tab's copy); today that means
 * the tab's copy, so this names that copy explicitly, the same rule as
 * `effectiveRuntimeBinding`. Null only when there is no copy at all (no
 * computer online for this project): the pane shows its empty state and makes
 * no call.
 */
export function useDeviceMachinePin(runtimePin: OpenProjectBinding | null | undefined): OpenProjectBinding | null {
  const tabCopyPin = useTabCopyPin();
  return effectiveRuntimeBinding(runtimePin, tabCopyPin);
}
