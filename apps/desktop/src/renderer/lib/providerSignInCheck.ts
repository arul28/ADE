/**
 * The renderer half of the "login changed" path, and the one way to run a
 * provider's sign-in check.
 *
 * Every sign-in surface calls `checkProviderSignIn` once the sign-in
 * succeeds, and Settings' Re-check calls it on demand. It drops the
 * renderer's status caches (so the page, the card and the model pickers read
 * fresh), runs the provider's own check on the machine `pin` names, and drops
 * them again with the verdict in. The check never fails: an error, a timeout
 * or a remote ADE too old to have it reads "unknown" with a plain reason.
 */
import type { AiProviderSignInCheck, OpenProjectBinding } from "../../shared/types";
import { isUnsupportedAdeActionError } from "../../shared/codedError";
import { invalidateAiDiscoveryCache } from "./aiDiscoveryCache";

function unknownCheck(provider: string, reason: string): AiProviderSignInCheck {
  return { provider, state: "unknown", reason, account: null, checkedAt: new Date().toISOString() };
}

export async function checkProviderSignIn(
  provider: string,
  pin: OpenProjectBinding | null | undefined,
): Promise<AiProviderSignInCheck> {
  invalidateAiDiscoveryCache();
  try {
    const verify = window.ade?.ai?.verifyProviderSignIn;
    if (typeof verify !== "function") {
      return unknownCheck(provider, "This ADE cannot check a sign-in. The status shows what is saved.");
    }
    return await verify({ provider }, pin ?? null);
  } catch (error) {
    // A remote ADE from before the check refuses the action as not callable.
    if (isUnsupportedAdeActionError(error)) {
      return unknownCheck(
        provider,
        "That computer runs an older ADE that cannot check a sign-in. The status shows what is saved there.",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return unknownCheck(provider, message || "The check failed.");
  } finally {
    invalidateAiDiscoveryCache();
  }
}
