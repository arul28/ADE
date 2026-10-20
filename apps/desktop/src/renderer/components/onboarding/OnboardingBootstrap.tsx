import { useCallback, useEffect, useState } from "react";
import { ADE_WELCOME_VIDEO_REPLAY_EVENT } from "../../../shared/welcomeVideo";
import { isWebClientMode } from "../../lib/webClientMode";
import { markOnboardingStarted } from "../../onboarding/onboardingProgress";
import { ViewportOverlayPortal } from "../ui/ViewportOverlayHost";
import { GateBackdrop } from "./GateBackdrop";
import { FirstRunProjects, FirstRunWelcome, openFirstRunProjects, type FirstRunResult } from "./FirstRunFlow";
import "./launchGateGlass.css";

type Step = "welcome" | "projects";

/**
 * First-run setup inside the running app. The launch gate runs it on a fresh
 * computer; this shows it again when:
 *
 * - the user picks "Show me around again" in the help menu, or
 * - the gate was already open when the app loaded (a reload during setup), so
 *   setup never finished here.
 *
 * Desktop only: the hosted web client controls other computers, and setup is
 * about the one it runs on.
 */
export function OnboardingBootstrap() {
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    if (isWebClientMode()) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => window.ade.app.getWelcomeVideoState())
      .then((state) => {
        if (cancelled || state.completedAt || state.dismissedAt) return;
        markOnboardingStarted();
        setStep("welcome");
      })
      .catch(() => undefined);
    const replay = () => setStep("welcome");
    window.addEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
    return () => {
      cancelled = true;
      window.removeEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
    };
  }, []);

  const close = useCallback((reason: "completed" | "dismissed") => {
    setStep(null);
    void window.ade.app.markWelcomeVideoSeen(reason).catch(() => undefined);
  }, []);

  const finish = useCallback((result: FirstRunResult) => {
    close("completed");
    openFirstRunProjects(result);
  }, [close]);

  useEffect(() => {
    if (!step) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close("dismissed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, step]);

  if (!step) return null;

  return (
    <ViewportOverlayPortal layer="dialog">
      <div className="ade-gate" role="dialog" aria-modal="true" aria-label="Set up ADE" style={{ pointerEvents: "auto" }}>
        <GateBackdrop />
        {step === "welcome" ? (
          <div className="ade-gate-stack" data-step="welcome" key="welcome">
            <FirstRunWelcome onStart={() => setStep("projects")} onSkip={() => close("dismissed")} />
          </div>
        ) : (
          <div className="ade-gate-stack" data-step="projects" key="projects">
            <FirstRunProjects onDone={finish} onSkip={() => close("dismissed")} />
          </div>
        )}
      </div>
    </ViewportOverlayPortal>
  );
}
