import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { SignInCard } from "../account/AccountPage";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { useAccountStatus } from "../../lib/account";
import { isWebClientMode } from "../../lib/webClientMode";
import { WelcomeVideoGate } from "./WelcomeVideoGate";

type LaunchGateProps = { children: ReactNode };

export function LaunchGate({ children }: LaunchGateProps) {
  const webClient = isWebClientMode();
  if (webClient) return <WebLaunchGate>{children}</WebLaunchGate>;
  return <DesktopLaunchGate>{children}</DesktopLaunchGate>;
}

/**
 * The hosted client's gate is mandatory: every byte it can show comes through
 * ADE Relay, and the relay only routes for a signed-in account. There is
 * nothing to "continue without an account" into, so there is no skip.
 */
function WebLaunchGate({ children }: LaunchGateProps) {
  const { status, loading } = useAccountStatus();

  if (status.signedIn) return children;

  return (
    <div
      data-testid="launch-gate"
      data-mode="web"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "auto",
        padding: 24,
        background: COLORS.pageBg,
        color: COLORS.textPrimary,
      }}
    >
      <style>{WEB_GATE_KEYFRAMES}</style>
      <div
        style={{
          width: "min(440px, 100%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          animation: "ade-launch-gate-rise 420ms cubic-bezier(0.16, 1, 0.3, 1) both",
        }}
      >
        {loading ? (
          <div
            role="status"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              fontFamily: SANS_FONT,
              fontSize: 12.5,
              color: COLORS.textSecondary,
            }}
          >
            <img
              src="./logo.png"
              alt="ADE"
              draggable={false}
              style={{
                height: 34,
                opacity: 0.95,
                animation: "ade-launch-gate-pulse 1.8s ease-in-out infinite",
              }}
            />
            Checking your ADE account…
          </div>
        ) : (
          <SignInCard configured={status.configured !== false} onSignedIn={() => undefined} />
        )}
      </div>
    </div>
  );
}

/**
 * Motion is decoration here, so it yields entirely to a reduced-motion
 * preference rather than being merely slowed down.
 */
const WEB_GATE_KEYFRAMES = `
@keyframes ade-launch-gate-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}
@keyframes ade-launch-gate-pulse {
  0%, 100% { opacity: 0.95; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.97); }
}
@media (prefers-reduced-motion: reduce) {
  [data-testid="launch-gate"][data-mode="web"] *,
  [data-testid="launch-gate"][data-mode="web"] {
    animation: none !important;
  }
}
`;

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
    <div
      data-testid="launch-gate"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "auto",
        padding: 24,
        background: COLORS.pageBg,
        color: COLORS.textPrimary,
      }}
    >
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
        <div
          style={{
            width: "min(440px, 100%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
          }}
        >
          <SignInCard configured={status.configured !== false} onSignedIn={enterAde} />
          <button
            type="button"
            onClick={enterAde}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: 0,
              padding: "7px 10px",
              background: "transparent",
              color: COLORS.textSecondary,
              cursor: "pointer",
              fontFamily: SANS_FONT,
              fontSize: 12.5,
              WebkitAppRegion: "no-drag",
            } as CSSProperties}
          >
            Continue without an account
            <ArrowRight size={13} weight="bold" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
