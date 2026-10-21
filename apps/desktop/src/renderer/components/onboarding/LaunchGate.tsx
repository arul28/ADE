import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { GlassSignInCard } from "./GlassSignInCard";
import { GateBackdrop } from "./GateBackdrop";
import { WebSignInGate } from "./WebSignInGate";
import { accountGateMode, accountSessionState, useAccountStatus } from "../../lib/account";
import { isWebClientMode } from "../../lib/webClientMode";
import { markOnboardingStarted, skipOnboarding } from "../../onboarding/onboardingProgress";
import { FirstRunAgents } from "./FirstRunAgents";
import { FirstRunProjects, FirstRunWelcome, showFirstRunProjects, type FirstRunResult } from "./FirstRunFlow";
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
  const { status } = useAccountStatus();

  if (status.signedIn) return children;

  return <WebSignInGate />;
}

type FirstRunPhase = "checking" | "welcome" | "agents" | "projects" | "done";

/**
 * The desktop gate, in order: the welcome card (first run on this computer),
 * sign-in (until signed in), "Connect your agents" and "Bring your projects
 * in" (first run), then ADE.
 * A computer that finished or skipped setup before only ever sees sign-in.
 */
function DesktopLaunchGate({ children }: LaunchGateProps) {
  const { status, loading: accountLoading } = useAccountStatus();
  const [launchStateLoading, setLaunchStateLoading] = useState(true);
  const [resolved, setResolved] = useState(false);
  const [firstRun, setFirstRun] = useState<FirstRunPhase>("checking");
  const firstRunRef = useRef(firstRun);
  firstRunRef.current = firstRun;
  const setupResultRef = useRef<FirstRunResult | null>(null);

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
    // First run on this computer: the welcome state was never completed or skipped.
    void Promise.resolve()
      .then(() => window.ade.app.getWelcomeVideoState())
      .then((state) => {
        if (cancelled) return;
        const fresh = !state.completedAt && !state.dismissedAt;
        if (fresh) markOnboardingStarted();
        setFirstRun(fresh ? "welcome" : "done");
      })
      .catch(() => {
        if (!cancelled) setFirstRun("done");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enterAde = useCallback(() => {
    setResolved(true);
    void window.ade.app.resolveLaunchGate().catch(() => undefined);
    const setupResult = setupResultRef.current;
    setupResultRef.current = null;
    // ADE opens on Home, where the projects setup added are in the recent
    // list; none opens by itself, and each one's first open brings its chats in.
    if (setupResult) showFirstRunProjects(setupResult);
  }, []);

  const skipSetup = useCallback(() => {
    skipOnboarding();
    setFirstRun("done");
    void window.ade.app.markWelcomeVideoSeen("dismissed").catch(() => undefined);
  }, []);

  const finishSetup = useCallback((result: FirstRunResult) => {
    setupResultRef.current = result;
    setFirstRun("done");
    void window.ade.app.markWelcomeVideoSeen("completed").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (
      !resolved &&
      !launchStateLoading &&
      firstRun === "done" &&
      !accountLoading &&
      status.signedIn
    ) {
      enterAde();
    }
  }, [accountLoading, enterAde, firstRun, launchStateLoading, resolved, status.signedIn]);

  const checking = launchStateLoading || firstRun === "checking" || accountLoading;
  const step: "welcome" | "sign-in" | "agents" | "projects" | null = checking
    ? null
    : firstRun === "welcome"
      ? "welcome"
      : !status.signedIn
        ? "sign-in"
        : firstRun === "agents" || firstRun === "projects"
          ? firstRun
          : null;
  const gateMode = accountGateMode(status);

  useEffect(() => {
    if (step !== "sign-in" || resolved) return;
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
  }, [resolved, step]);

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
      {step === "welcome" ? (
        <div className="ade-gate-stack" data-step="welcome" key="welcome">
          <FirstRunWelcome onStart={() => setFirstRun("agents")} onSkip={skipSetup} />
        </div>
      ) : null}
      {step === "agents" ? (
        <div className="ade-gate-stack" data-step="agents" key="agents">
          <FirstRunAgents onDone={() => setFirstRun("projects")} />
        </div>
      ) : null}
      {step === "projects" ? (
        <div className="ade-gate-stack" data-step="projects" key="projects">
          {/* Skipping the projects only skips adding them; the first-chat hints still follow. */}
          <FirstRunProjects onDone={finishSetup} onSkip={() => finishSetup({ rootPaths: [] })} />
        </div>
      ) : null}
      {step === "sign-in" ? (
        <div className="ade-gate-stack" key="sign-in">
          <GlassSignInCard
            configured={status.configured !== false}
            // During first run, signing in moves on to "Connect your agents";
            // the gate opens when setup is done.
            onSignedIn={() => {
              if (firstRunRef.current === "done") enterAde();
            }}
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
