import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { GlassSignInCard } from "./GlassSignInCard";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { useAppStore } from "../../state/appStore";
import { accountGateMode, accountSessionState, useAccountStatus } from "../../lib/account";
import { isWebClientMode } from "../../lib/webClientMode";
import { WelcomeVideoGate } from "./WelcomeVideoGate";
import "./launchGateGlass.css";

type LaunchGateProps = { children: ReactNode };

export function LaunchGate({ children }: LaunchGateProps) {
  const webClient = isWebClientMode();
  if (webClient) return <WebLaunchGate>{children}</WebLaunchGate>;
  return <DesktopLaunchGate>{children}</DesktopLaunchGate>;
}

/**
 * The hosted client's gate is absolute: every byte it can show comes through
 * ADE Relay, and the relay only routes for a signed-in account. A signed-out
 * browser has nothing to pass through to, so it never offers one — not even in
 * the `recoverable` case the desktop gate handles.
 */
function WebLaunchGate({ children }: LaunchGateProps) {
  const { status, loading } = useAccountStatus();

  if (status.signedIn) return children;

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
 * ADE's mesh, drawn as one window-sized field behind the glass card, with a
 * vignette that keeps the card's edges legible. Follows the theme and any
 * image scene on its own.
 */
function GateBackdrop() {
  const theme = useAppStore((s) => s.theme);
  return (
    <>
      <WorkToolPickerBackdrop theme={theme} field="window" />
      <div className="ade-gate-vignette" aria-hidden="true" />
    </>
  );
}

function DesktopLaunchGate({ children }: LaunchGateProps) {
  const { status, loading: accountLoading } = useAccountStatus();
  const [launchStateLoading, setLaunchStateLoading] = useState(true);
  const [resolved, setResolved] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeChecking, setWelcomeChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void window.ade.app.getLaunchGateState()
      .then((state) => {
        if (!cancelled) setResolved(state.resolved);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLaunchStateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enterAde = useCallback(() => {
    setResolved(true);
    void window.ade.app.resolveLaunchGate().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (
      !resolved &&
      !launchStateLoading &&
      !welcomeChecking &&
      !welcomeVisible &&
      !accountLoading &&
      status.signedIn
    ) {
      enterAde();
    }
  }, [
    accountLoading,
    enterAde,
    launchStateLoading,
    resolved,
    status.signedIn,
    welcomeChecking,
    welcomeVisible,
  ]);

  const checking = launchStateLoading || welcomeChecking || accountLoading;
  const showAccountChoice = !checking && !welcomeVisible && !status.signedIn;
  const gateMode = accountGateMode(status);

  useEffect(() => {
    if (!showAccountChoice || resolved) return;
    void window.ade.analytics?.capture({
      event: "ade_screen_viewed",
      properties: {
        screen: "onboarding",
        route_kind: "desktop",
        source: "renderer_startup",
      },
      dedupeKey: "desktop_launch_account_choice",
      minimumIntervalMs: 60 * 60_000,
    }).catch(() => undefined);
  }, [resolved, showAccountChoice]);

  if (resolved) return children;

  return (
    <div data-testid="launch-gate" className="ade-gate">
      <GateBackdrop />
      <div
        data-testid="launch-gate-drag-region"
        data-app-region="drag"
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: "0 0 auto",
          height: 44,
          WebkitAppRegion: "drag",
        } as CSSProperties}
      />
      <WelcomeVideoGate
        onVisibilityChange={(visible, nextChecking) => {
          setWelcomeVisible(visible);
          setWelcomeChecking(nextChecking);
        }}
      />
      {showAccountChoice ? (
        <div className="ade-gate-stack">
          <GlassSignInCard
            configured={status.configured !== false}
            onSignedIn={enterAde}
            sessionState={accountSessionState(status)}
          />
          {/*
            ADE requires an account, so `required` — no session has ever existed
            on this computer — has nothing to pass through to.

            `recoverable` is the opposite case: the user already signed in, and
            something took the session away. Their work is on this disk and
            blocking it would be a brick. They get one full screen, then the
            permanent shell bar nags on every surface until they sign in.
          */}
          {gateMode === "recoverable" ? (
            <button type="button" className="ade-gate-continue" onClick={enterAde}>
              Continue to your work
              <ArrowRight size={13} weight="bold" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
