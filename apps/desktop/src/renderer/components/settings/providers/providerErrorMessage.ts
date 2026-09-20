import { stripElectronErrorWrapper } from "../../../lib/codedError";

/**
 * The sentence a provider account / API key panel shows when a write is
 * refused.
 *
 * The store is the authority on what is allowed — it refuses a 61-character
 * label, a duplicate key id, an unsafe custom-provider id — so its own words
 * are what the panel shows. What the panel must not show is the Electron IPC
 * plumbing those words travel through: `ade.localRuntime.callAction` is not a
 * fact about the account you just tried to rename.
 */
export function providerActionMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return stripElectronErrorWrapper(raw) || fallback;
}
