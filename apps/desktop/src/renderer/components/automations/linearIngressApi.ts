import { isAdeAvailable } from "../../lib/adeAvailability";
import { navigateToAppTarget } from "../../lib/openExternal";
import { LINEAR_NOT_CONNECTED_MESSAGE } from "../../../shared/types/automations";
import type { OpenProjectBinding } from "../../../shared/types";
import { chatSettingsMachineId } from "../chat/chatDeeplinks";

export type LinearIngressApi = typeof window.ade.automations.linearIngress;

/**
 * The Linear ingress IPC is part of the preload contract, but a remote runtime
 * on an older build may not expose it — probe defensively so callers degrade
 * (hide the row, fall back to a settings link) rather than throwing.
 */
export function linearIngressApi(): Partial<LinearIngressApi> | null {
  const api = window.ade?.automations?.linearIngress;
  return isAdeAvailable(api) ? api : null;
}

/** Setup refused because Linear itself is not connected on that machine (IPC keeps only the message). */
export function isLinearNotConnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(LINEAR_NOT_CONNECTED_MESSAGE);
}

/**
 * Set up Linear ingress on the machine `pin` names. With no pin (no computer
 * with this project is online) it sends nothing. When Linear itself is not
 * connected there, open THAT machine's Linear settings, since connecting it
 * comes first; any other failure is the caller's to handle.
 */
export async function setupLinearIngressOrOpenSettings(pin: OpenProjectBinding | null): Promise<void> {
  const api = linearIngressApi();
  if (!api?.setup || !pin) return;
  try {
    await api.setup(pin);
  } catch (error) {
    if (!isLinearNotConnectedError(error)) throw error;
    openLinearSettings(pin);
  }
}

/** Linear settings for the machine `pin` names, or the tab's own machine. */
export function openLinearSettings(pin: OpenProjectBinding | null): void {
  navigateToAppTarget({ kind: "settings", entryId: "integrations.linear", machineId: chatSettingsMachineId({ pin }) });
}
