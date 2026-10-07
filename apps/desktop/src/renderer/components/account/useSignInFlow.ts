import { accountSessionNotice, fetchAccountStatus, type AdeAccountSessionState } from "../../lib/account";
import { useAccountLogin } from "../../lib/accountLogin";
import { useBrainRepair } from "../../hooks/useBrainRepair";

/**
 * The sign-in state every sign-in surface shares: the browser login, the
 * session-state words, and the brain repair offered when a stored session
 * cannot be read. `SignInCard` (the Account page) and `GlassSignInCard` (the
 * launch gate) each draw it their own way.
 */
export function useSignInFlow({
  onSignedIn,
  sessionState,
}: {
  onSignedIn: () => void;
  sessionState: AdeAccountSessionState;
}) {
  const { phase, error, beginLogin, cancel } = useAccountLogin({
    onSignedIn: () => onSignedIn(),
  });
  const busy = phase === "starting" || phase === "awaiting";
  const unreadable = sessionState === "unreadable";
  const expired = sessionState === "expired";
  const notice = accountSessionNotice(sessionState);
  const repair = useBrainRepair(() => {
    void fetchAccountStatus({ force: true });
  });
  const signInLabel = expired ? "Sign in" : "Sign in or create account";
  return { phase, error, beginLogin, cancel, busy, unreadable, expired, notice, repair, signInLabel };
}
