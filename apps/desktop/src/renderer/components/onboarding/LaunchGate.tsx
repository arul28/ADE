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
  const { status, loading: accountLoading } = useAccountStatus();
  const [launchStateLoading, setLaunchStateLoading] = useState(!webClient);
  const [resolved, setResolved] = useState(webClient);
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeChecking, setWelcomeChecking] = useState(!webClient);

  useEffect(() => {
    if (webClient) return;
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
  }, [webClient]);

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
    if (!showAccountChoice || webClient || resolved) return;
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
  }, [resolved, showAccountChoice, webClient]);

  if (resolved || webClient) return children;

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
