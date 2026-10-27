import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { markOnboardingStarted, skipOnboarding } from "../../onboarding/onboardingProgress";
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
 * Welcome → Connect your agents → Bring your projects in. Skip ends
 * onboarding (no tour or hints follow) and marks the welcome dismissed;
 * finishing marks it completed and hands the projects setup added to
 * `onFinish`.
 */

export type FirstRunStepId = "welcome" | "agents" | "projects";

/** `checking` until the welcome state is read; `done` when setup is over or never needed. */
export type FirstRunPhase = "checking" | FirstRunStepId | "done";

export type FirstRunSteps = {
  phase: FirstRunPhase;
  /** Start over at the welcome card (the help menu's replay). */
  restart: () => void;
  /** The welcome card's start button. */
  start: () => void;
  /** Continue (or Skip) on the agents card. */
  agentsDone: () => void;
  skip: () => void;
  finish: (result: FirstRunResult) => void;
};

export function useFirstRunSteps({
  enabled = true,
  skipAgents = false,
  onFinish,
}: {
  /** False: read nothing and stay `done` (the hosted web client has no first run). */
  enabled?: boolean;
  /**
   * Go from the welcome straight to the projects. The agents card reads and
   * signs in on the machine the front tab is bound to, so a replay over a
   * project on another machine leaves it out rather than set that one up
   * under this computer's name.
   */
  skipAgents?: boolean;
  onFinish?: (result: FirstRunResult) => void;
} = {}): FirstRunSteps {
  const [phase, setPhase] = useState<FirstRunPhase>(enabled ? "checking" : "done");

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    // First run on this computer: the welcome state was never completed or skipped.
    void Promise.resolve()
      .then(() => window.ade.app.getWelcomeVideoState())
      .then((state) => {
        if (cancelled) return;
        const fresh = !state.completedAt && !state.dismissedAt;
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
  const start = useCallback(() => setPhase(skipAgents ? "projects" : "agents"), [skipAgents]);
  const agentsDone = useCallback(() => setPhase("projects"), []);

  const skip = useCallback(() => {
    skipOnboarding();
    setPhase("done");
    void window.ade.app.markWelcomeVideoSeen("dismissed").catch(() => undefined);
  }, []);

  const finish = useCallback((result: FirstRunResult) => {
    setPhase("done");
    void window.ade.app.markWelcomeVideoSeen("completed").catch(() => undefined);
    onFinish?.(result);
  }, [onFinish]);

  return { phase, restart, start, agentsDone, skip, finish };
}

/** One first-run card on the gate's glass. Give it `key={step}` so each step mounts fresh. */
export function FirstRunStep({ step, steps }: { step: FirstRunStepId; steps: FirstRunSteps }) {
  return (
    <div className="ade-gate-stack" data-step={step}>
      <Suspense fallback={null}>
      {step === "welcome" ? <FirstRunWelcome onStart={steps.start} onSkip={steps.skip} /> : null}
      {step === "agents" ? <FirstRunAgents onDone={steps.agentsDone} /> : null}
      {/* Skipping the projects only skips adding them; the tour still follows. */}
      {step === "projects" ? (
        <FirstRunProjects onDone={steps.finish} onSkip={() => steps.finish({ rootPaths: [] })} />
      ) : null}
      </Suspense>
    </div>
  );
}
