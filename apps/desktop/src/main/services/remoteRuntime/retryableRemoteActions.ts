import { isReplaySafeAdeAction } from "../../../shared/adeActionAccess";

/** Whether a remote runtime action may run again after its connection dropped. */
export function isRetryableRemoteAction(domain: string, action: string): boolean {
  return isReplaySafeAdeAction(domain, action);
}
