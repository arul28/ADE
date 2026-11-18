import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { accountCreatedAtFromUserId } from "../../../shared/announcementsSeen";
import { fetchAccountStatus } from "../../lib/account";
import { isWebClientMode } from "../../lib/webClientMode";
import { markOnboardingStarted, readOnboardingProgress, skipOnboarding } from "../../onboarding/onboardingProgress";
import { onboardingReconciledFor, reconcileOnboardingProgress } from "../../onboarding/onboardingSync";
import type { FirstRunResult } from "./FirstRunFlow";

// The step screens load when setup runs, not with every launch.
const FirstRunAgents = lazy(() => import("./FirstRunAgents").then((module) => ({ default: module.FirstRunAgents })));
const FirstRunProjects = lazy(() => import("./FirstRunFlow").then((module) => ({ default: module.FirstRunProjects })));
const FirstRunWelcome = lazy(() => import("./FirstRunFlow").then((module) => ({ default: module.FirstRunWelcome })));

/**
 * The first-run step machine both hosts run: the launch gate on a fresh
 * computer (`LaunchGate.tsx`, which puts sign-in between the welcome and the
 * agents) and the in-app replay (`OnboardingBootstrap.tsx`, "Show me around
 * again" or a reload during setup).
 *
 * Welcome → Connect your agents → Bring your projects in. Skip leaves the
 * setup cards and marks the welcome dismissed; finishing marks it completed
 * and hands the projects setup added to `onFinish`. Either way the guided
 * tour still waits for the first project, with its own Skip.
 *
 * ADE Web shows only the welcome card (`welcomeOnly`), once per account, to
 * an account made since the web had onboarding (`WEB_WELCOME_SINCE`) that
 * has not started onboarding anywhere: the account's copy decides, not the
 * browser's.
 */

/** Accounts made from this day on get the welcome in ADE Web; older ones already know ADE. */
const WEB_WELCOME_SINCE = Date.UTC(2026, 10, 18);

/** Whether ADE Web should welcome this account: new, and onboarding not started on any copy. */
async function webWelcomeDue(): Promise<boolean> {
  await reconcileOnboardingProgress();
  const status = await fetchAccountStatus().catch(() => null);
  const userId = status?.signedIn ? status.userId?.trim() || null : null;
  // The account's copy was not read: an existing person must not get a welcome by mistake.
  if (!onboardingReconciledFor(userId)) return false;
  const createdAt = accountCreatedAtFromUserId(userId);
  if (createdAt == null || createdAt < WEB_WELCOME_SINCE) return false;
  return !readOnboardingProgress().startedAt;
}

export type FirstRunStepId = "welcome" | "agents" | "projects";

/** `checking` until the welcome state is read; `done` when setup is over or never needed. */
export type FirstRunPhase = "checking" | FirstRunStepId | "done";

export type FirstRunSteps = {
  phase: FirstRunPhase;
  /** Only the welcome card (ADE Web): its skip link skips the tour, as there is no setup to skip. */
  welcomeOnly: boolean;
  /** Start over at the welcome card (the help menu's replay). */
  restart: () => void;
  /** The welcome card's start button. */
  start: () => void;
  /** Continue (or Skip) on the agents card. */
  agentsDone: () => void;
  skip: () => void;
  /** Escape: closes setup like Skip, but never skips the tour (one stray key must not turn it off on every device). */
  dismiss: () => void;
  finish: (result: FirstRunResult) => void;
};

export function useFirstRunSteps({
  enabled = true,
  skipAgents = false,
  welcomeOnly = false,
  onFinish,
  onSkip,
}: {
  /** False: read nothing and stay `done`. */
  enabled?: boolean;
  /** Only the welcome card: its start button finishes setup (ADE Web, which has no computer of its own to set up). */
  welcomeOnly?: boolean;
  /**
   * Go from the welcome straight to the projects. The agents card reads and
   * signs in on the machine the front tab is bound to, so a replay over a
   * project on another machine leaves it out rather than set that one up
   * under this computer's name.
   */
  skipAgents?: boolean;
  onFinish?: (result: FirstRunResult) => void;
  onSkip?: () => void;
} = {}): FirstRunSteps {
  const [phase, setPhase] = useState<FirstRunPhase>(enabled ? "checking" : "done");

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    // First run on this computer: the welcome state was never completed or
    // skipped. ADE Web: the account's first visit (`webWelcomeDue`).
    const due = isWebClientMode()
      ? webWelcomeDue()
      : Promise.resolve()
        .then(() => window.ade.app.getWelcomeVideoState())
        .then((state) => !state.completedAt && !state.dismissedAt);
    void due
      .then((fresh) => {
        if (cancelled) return;
        if (fresh) markOnboardingStarted();
        // A replay that started while the state was being read wins.
        setPhase((current) => (current === "checking" ? (fresh ? "welcome" : "done") : current));
      })
      .catch(() => {
        if (!cancelled) {
          console.warn("[onboarding] welcome state could not be read");
          setPhase((current) => (current === "checking" ? "done" : current));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const restart = useCallback(() => setPhase("welcome"), []);
  const agentsDone = useCallback(() => setPhase("projects"), []);

  const close = useCallback((skipTour: boolean) => {
    if (skipTour) skipOnboarding();
    else markOnboardingStarted();
    setPhase("done");
    void window.ade.app.markWelcomeVideoSeen("dismissed").catch(() => undefined);
    onSkip?.();
  }, [onSkip]);
  // Setup only: the tour still waits for the first project, with its own
  // Skip. With no setup to skip (ADE Web), the link skips the tour.
  const skip = useCallback(() => close(welcomeOnly), [close, welcomeOnly]);
  const dismiss = useCallback(() => close(false), [close]);

  const finish = useCallback((result: FirstRunResult) => {
    setPhase("done");
    void window.ade.app.markWelcomeVideoSeen("completed").catch(() => undefined);
    onFinish?.(result);
  }, [onFinish]);

  const start = useCallback(() => {
    if (welcomeOnly) finish({ rootPaths: [] });
    else setPhase(skipAgents ? "projects" : "agents");
  }, [finish, skipAgents, welcomeOnly]);

  return { phase, welcomeOnly, restart, start, agentsDone, skip, dismiss, finish };
}

/** One first-run card on the gate's glass. Give it `key={step}` so each step mounts fresh. */
export function FirstRunStep({ step, steps }: { step: FirstRunStepId; steps: FirstRunSteps }) {
  return (
    <div className="ade-gate-stack" data-step={step}>
      <Suspense fallback={null}>
      {step === "welcome" ? (
        <FirstRunWelcome
          onStart={steps.start}
          onSkip={steps.skip}
          skipLabel={steps.welcomeOnly ? "Skip the tour" : "Skip setup"}
        />
      ) : null}
      {step === "agents" ? <FirstRunAgents onDone={steps.agentsDone} /> : null}
      {/* Skipping the projects only skips adding them; the tour still follows. */}
      {step === "projects" ? (
        <FirstRunProjects onDone={steps.finish} onSkip={() => steps.finish({ rootPaths: [] })} />
      ) : null}
      </Suspense>
    </div>
  );
}
