import { accountSessionState, useAccountStatus } from "../../lib/account";
import { AppearanceRoot } from "../app/AppearanceRoot";
import { GlassSignInCard } from "./GlassSignInCard";
import { GateBackdrop } from "./GateBackdrop";
import "./launchGateGlass.css";

/** The hosted client's sign-in card over the mesh backdrop. `LaunchGate` renders it inside the app shell. */
export function WebSignInGate() {
  const { status, loading } = useAccountStatus();

  return (
    <div data-testid="launch-gate" data-mode="web" className="ade-gate">
      <GateBackdrop />
      <div className="ade-gate-stack">
        {loading ? (
          <div role="status" className="ade-gate-loading">
            <span className="ade-glass-mark">
              <img src="./logo.png" alt="ADE" draggable={false} />
            </span>
            Checking your ADE account…
          </div>
        ) : (
          <GlassSignInCard
            configured={status.configured !== false}
            onSignedIn={() => undefined}
            sessionState={accountSessionState(status)}
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
export function WebSignInScreen() {
  return (
    <AppearanceRoot>
      <WebSignInGate />
    </AppearanceRoot>
  );
}
