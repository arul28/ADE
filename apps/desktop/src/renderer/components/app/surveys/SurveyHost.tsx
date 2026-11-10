import { lazy, Suspense, useEffect, useState } from "react";
import type { ProductSurvey } from "../../../../shared/types/productSurveys";
import { onboardingSettledBeforeThisLaunch } from "../../../onboarding/onboardingProgress";

const SurveyCard = lazy(() => import("./SurveyCard"));

/**
 * How long the window must have been in use (focused) before a survey may
 * appear. A minute after opening, the first design, put the card in front of
 * people 15 seconds after their project opened, as they started to work: two
 * of the first seven hid it within half a minute and one called ADE "in your
 * face" (2026-11-05). Ten minutes of use is a session that is under way.
 */
const ASK_AFTER_USE_MS = 10 * 60_000;

/**
 * Asks the main process once per window, after ten minutes of use, whether
 * this install should see an in-app survey (`surveyService.ts` decides from
 * local history, analytics consent and PostHog's real-user flag; at most one
 * window gets one per launch). Use is time with the window focused, counted
 * with one timer that runs only while it is: no poll, no subscription, and
 * the card's code loads only when there is a survey to show. Never during the
 * first session's onboarding.
 *
 * Desktop only: the hosted web client has no `surveys` bridge.
 */
export function SurveyHost(): JSX.Element | null {
  const [survey, setSurvey] = useState<ProductSurvey | null>(null);

  useEffect(() => {
    const bridge = window.ade?.analytics?.surveys;
    if (!bridge || !onboardingSettledBeforeThisLaunch()) return undefined;
    let cancelled = false;
    let asked = false;
    let usedMs = 0;
    let focusedAt: number | null = null;
    let timer: number | null = null;
    const ask = () => {
      timer = null;
      asked = true;
      stop();
      bridge.getEligible().then(
        (next) => {
          if (!cancelled && next && onboardingSettledBeforeThisLaunch()) setSurvey(next);
        },
        () => undefined,
      );
    };
    const start = () => {
      if (asked || focusedAt != null) return;
      focusedAt = performance.now();
      timer = window.setTimeout(ask, Math.max(0, ASK_AFTER_USE_MS - usedMs));
    };
    function stop() {
      if (focusedAt != null) usedMs += performance.now() - focusedAt;
      focusedAt = null;
      if (timer != null) window.clearTimeout(timer);
      timer = null;
    }
    window.addEventListener("focus", start);
    window.addEventListener("blur", stop);
    if (document.hasFocus()) start();
    return () => {
      cancelled = true;
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", stop);
      stop();
    };
  }, []);

  if (!survey) return null;
  return (
    <Suspense fallback={null}>
      <SurveyCard survey={survey} onDone={() => setSurvey(null)} />
    </Suspense>
  );
}
