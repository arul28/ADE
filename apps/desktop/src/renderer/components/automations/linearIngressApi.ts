import { isAdeAvailable } from "../../lib/adeAvailability";
import { LINEAR_NOT_CONNECTED_MESSAGE } from "../../../shared/types/automations";

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
