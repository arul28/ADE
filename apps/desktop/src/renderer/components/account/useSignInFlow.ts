import type { AdeAccountStatus } from "../../../shared/types";
import { accountSessionNotice, fetchAccountStatus, type AdeAccountSessionState } from "../../lib/account";
import {
  accountDeviceLoginAvailable,
  useAccountDeviceLogin,
  useAccountLogin,
} from "../../lib/accountLogin";
import { useBrainRepair } from "../../hooks/useBrainRepair";

/**
 * The sign-in state every sign-in surface shares: the browser login, the
 * sign-in from another device, the session-state words, and the brain repair
 * offered when a stored session cannot be read. `SignInCard` (the Account page) and `GlassSignInCard` (the
 * launch gate) each draw it their own way.
 */
export function useSignInFlow({
  onSignedIn,
  sessionState,
}: {
  onSignedIn: (status: AdeAccountStatus) => void;
  sessionState: AdeAccountSessionState;
}) {
  const { phase, error, beginLogin, cancel } = useAccountLogin({ onSignedIn });
  const otherDevice = useAccountDeviceLogin({ onSignedIn });
  const otherDeviceActive = otherDevice.phase === "starting" || otherDevice.phase === "awaiting";
  const busy = phase === "starting" || phase === "awaiting" || otherDeviceActive;
  const unreadable = sessionState === "unreadable";
  const expired = sessionState === "expired";
  const notice = accountSessionNotice(sessionState);
  const repair = useBrainRepair(() => {
    void fetchAccountStatus({ force: true });
  });
  const signInLabel = expired ? "Sign in" : "Sign in or create account";
  return {
    phase,
    // One error line: only one of the two sign-ins runs at a time.
    error: error ?? otherDevice.error,
    beginLogin: async () => {
      otherDevice.cancel();
      await beginLogin();
    },
    cancel,
    busy,
    unreadable,
    expired,
    notice,
    repair,
    signInLabel,
    otherDevice: {
      available: accountDeviceLoginAvailable(),
      starting: otherDevice.phase === "starting",
      prompt: otherDevice.prompt,
      begin: async () => {
        cancel();
        await otherDevice.begin();
      },
      cancel: otherDevice.cancel,
    },
  };
}
