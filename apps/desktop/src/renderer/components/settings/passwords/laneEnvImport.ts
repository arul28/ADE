import type { OpenProjectBinding } from "../../../../shared/types";

/**
 * A `.env` file in a project's main checkout that the `.env` tip asked
 * Settings › Passwords & Secrets to import. The page reads it when it opens,
 * previews the file on the pin's machine (names and lengths only), and the
 * import runs there: no value reaches this window.
 */
export type LaneEnvImportRequest = { path: string; pin: OpenProjectBinding };

let pending: LaneEnvImportRequest | null = null;
const listeners = new Set<() => void>();

export function requestLaneEnvImport(request: LaneEnvImportRequest): void {
  pending = request;
  for (const listener of listeners) listener();
}

/** Takes the request once; null when there is none. */
export function takeLaneEnvImport(): LaneEnvImportRequest | null {
  const next = pending;
  pending = null;
  return next;
}

export function subscribeLaneEnvImport(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
