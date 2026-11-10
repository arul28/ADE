import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { GlassSignInCard } from "./GlassSignInCard";
import { GateBackdrop } from "./GateBackdrop";
import { WebSignInGate } from "./WebSignInGate";
import { accountGateMode, accountSessionState, useAccountStatus } from "../../lib/account";
import { isWebClientMode } from "../../lib/webClientMode";
import type { FirstRunResult } from "./FirstRunFlow";
import { showFirstRunProjects } from "./firstRunActions";
import { FirstRunStep, useFirstRunSteps, type FirstRunPhase, type FirstRunStepId } from "./FirstRunSteps";
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

type GateStep = FirstRunStepId | "sign-in";

type OnboardingFact =
  | { action: "onboarding_welcome_shown" | "onboarding_sign_in_shown" | "onboarding_agents_shown" | "onboarding_projects_shown"; outcome: "opened" }
  | { action: "onboarding_completed"; outcome: "completed" }
  | { action: "onboarding_skipped"; outcome: "cancelled" };

const STEP_SHOWN: Record<GateStep, OnboardingFact> = {
  welcome: { action: "onboarding_welcome_shown", outcome: "opened" },
  "sign-in": { action: "onboarding_sign_in_shown", outcome: "opened" },
  agents: { action: "onboarding_agents_shown", outcome: "opened" },
  projects: { action: "onboarding_projects_shown", outcome: "opened" },
};

/**
 * One fact per first-run card, so the funnel says which card people leave on.
 * Until 2026-11 only the sign-in card was reported (as the `onboarding`
 * screen), and "left during onboarding" could not be split further. At most
 * one of each a day per install; analytics never changes what the gate does.
 */
function captureOnboarding(fact: OnboardingFact): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "onboarding", ...fact, source: "renderer_route" },
      dedupeKey: `onboarding:${fact.action}`,
      minimumIntervalMs: 24 * 60 * 60_000,
    }).catch(() => undefined);
  } catch {
    // Reporting must never block setup.
  }
}

/** What the gate shows: the welcome before sign-in, then sign-in until signed in, then the rest of setup. */
function gateStep(checking: boolean, firstRun: FirstRunPhase, signedIn: boolean): GateStep | null {
  if (checking) return null;
  if (firstRun === "welcome") return "welcome";
  if (!signedIn) return "sign-in";
  return firstRun === "agents" || firstRun === "projects" ? firstRun : null;
}

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
  const setupResultRef = useRef<FirstRunResult | null>(null);
  // The projects setup added open from Home once the gate opens.
  const keepSetupResult = useCallback((result: FirstRunResult) => {
    setupResultRef.current = result;
  }, []);
  const rawSteps = useFirstRunSteps({ onFinish: keepSetupResult });
  // The same machine, with the two ways setup ends reported.
  const steps = useMemo(() => ({
    ...rawSteps,
    skip: () => {
      captureOnboarding({ action: "onboarding_skipped", outcome: "cancelled" });
      rawSteps.skip();
    },
    finish: (result: FirstRunResult) => {
      captureOnboarding({ action: "onboarding_completed", outcome: "completed" });
      rawSteps.finish(result);
    },
  }), [rawSteps]);
  const firstRun = steps.phase;
  /** Whether this launch showed a first-run card: a computer set up before reports no onboarding. */
  const firstRunSeenRef = useRef(false);
  const firstRunRef = useRef(firstRun);
  firstRunRef.current = firstRun;

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
    const setupResult = setupResultRef.current;
    setupResultRef.current = null;
    // ADE opens on Home, where the projects setup added are in the recent
    // list; none opens by itself, and each one's first open brings its chats in.
    if (setupResult) showFirstRunProjects(setupResult);
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
  const step = gateStep(checking, firstRun, status.signedIn);
  const gateMode = accountGateMode(status);

  useEffect(() => {
    if (!step || resolved) return;
    if (step !== "sign-in") firstRunSeenRef.current = true;
    // Sign-in alone is a signed-out return, not first run.
    if (step !== "sign-in" || firstRunSeenRef.current) captureOnboarding(STEP_SHOWN[step]);
  }, [resolved, step]);

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
      {step && step !== "sign-in" ? <FirstRunStep key={step} step={step} steps={steps} /> : null}
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
