/**
 * The sign-in words every provider tile and page uses: "Signed in", "Not
 * signed in" and "Unknown". One function builds them from the status read,
 * so thirteen providers cannot drift into thirteen vocabularies again.
 */
import type { AiProviderConnectionStatus } from "../../../../shared/types";
import type { ProviderStatusView } from "./types";

export const SIGNED_IN_LABEL = "Signed in";
export const NOT_SIGNED_IN_LABEL = "Not signed in";
export const UNKNOWN_LABEL = "Unknown";

/**
 * The view for a provider once the status has loaded.
 *
 * `connected` is the "can run a chat now" answer (`providerStatusConnected`);
 * it reads "Signed in" unless the host says the sign-in is unknown.
 * Otherwise the host's `signInState` decides. A host from before that field
 * sends none; it then reads as before: not usable means not signed in.
 */
export function signInStatusView(args: {
  connected: boolean;
  connection: AiProviderConnectionStatus | null | undefined;
  /** The provider's runtime (ADE's copy, an SDK) is on the machine. */
  runtimeDetected: boolean;
  message: string;
  errorLine?: string | null;
}): ProviderStatusView {
  const { connection, message } = args;
  const account = connection?.accountEmail?.trim() || null;
  const errorLine = args.errorLine ?? null;
  const word = connection?.signInState ?? "signed-out";
  // Usable but unproven (a key only a helper command makes): chats still run,
  // and the tile says what the read could not tell.
  if (args.connected && word === "unknown") return { state: "unknown", label: UNKNOWN_LABEL, message, errorLine };
  if (args.connected) return { state: "connected", label: SIGNED_IN_LABEL, message, errorLine, account };
  if (!args.runtimeDetected) {
    // Signed in or not, nothing runs until ADE's copy is here.
    return {
      state: "not-installed",
      label: "Not downloaded",
      message,
      errorLine: errorLine ?? connection?.blocker ?? null,
      account: word === "signed-in" ? account : null,
    };
  }
  // A saved sign-in the runtime cannot use yet (a chat failed to start, a
  // key not yet accepted): the sign-in is there, something else is wrong.
  if (word === "signed-in") {
    return { state: "attention", label: "Needs attention", message, errorLine: errorLine ?? connection?.blocker ?? null, account };
  }
  if (word === "unknown") return { state: "unknown", label: UNKNOWN_LABEL, message, errorLine };
  return { state: "sign-in", label: NOT_SIGNED_IN_LABEL, message, errorLine };
}
