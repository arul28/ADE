import { accountSessionState, useAccountStatus } from "../../lib/account";
import { AppearanceRoot } from "../app/AppearanceRoot";
import { GlassSignInCard } from "./GlassSignInCard";
import { GateBackdrop } from "./GateBackdrop";
import "./launchGateGlass.css";
import { AdeWordmark } from "../ui/AdeWordmark";
import type { ClerkSignInSetup } from "../../webclient/account/useClerkSignIn";

/** The hosted client's sign-in card over the mesh backdrop. `LaunchGate` renders it inside the app shell. */
export function WebSignInGate({
  linkWaiting = false,
  clerk,
  subtitle,
}: {
  linkWaiting?: boolean;
  /** ADE's own Clerk sign-in; without it the card shows one button that opens Clerk's page. */
  clerk?: ClerkSignInSetup;
  subtitle?: string;
} = {}) {
  const { status, loading } = useAccountStatus();

  return (
    <div data-testid="launch-gate" data-mode="web" className="ade-gate">
      <GateBackdrop />
      <div className="ade-gate-stack">
        {loading ? (
          <div role="status" className="ade-gate-loading">
            <span className="ade-glass-mark">
              <AdeWordmark draggable={false} />
            </span>
            Checking your ADE account…
          </div>
        ) : (
          <GlassSignInCard
            configured={status.configured !== false}
            onSignedIn={() => undefined}
            sessionState={accountSessionState(status)}
            subtitle={subtitle ?? (linkWaiting ? "Your link opens after you sign in." : undefined)}
            clerk={clerk}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The sign-in card for the shell's own boot path, which renders it before the
 * app shell exists. It mounts the same appearance root as the app shell, so a
 * signed-out visitor sees the same theme, motion, and system colour scheme.
 */
export function WebSignInScreen({
  linkWaiting = false,
  clerk,
  subtitle,
}: {
  linkWaiting?: boolean;
  clerk?: ClerkSignInSetup;
  subtitle?: string;
} = {}) {
  return (
    <AppearanceRoot>
      <WebSignInGate linkWaiting={linkWaiting} clerk={clerk} subtitle={subtitle} />
    </AppearanceRoot>
  );
}
