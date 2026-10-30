import { lazy, Suspense, useEffect, useState } from "react";
import type { ProductSurvey } from "../../../../shared/types/productSurveys";
import { onboardingSettledBeforeThisLaunch } from "../../../onboarding/onboardingProgress";

const SurveyCard = lazy(() => import("./SurveyCard"));

/** Long enough that a survey never competes with startup or the first thing the person opens. */
const ASK_AFTER_MS = 60_000;

/**
 * Asks the main process once per window, a minute after it opens, whether
 * this install should see an in-app survey (`surveyService.ts` decides from
 * local history and analytics consent; at most one window gets one per
 * launch). Nothing else runs: no poll, no subscription, and the card's code
 * loads only when there is a survey to show. Never during the first session's
 * onboarding.
 *
 * Desktop only: the hosted web client has no `surveys` bridge.
 */
export function SurveyHost(): JSX.Element | null {
  const [survey, setSurvey] = useState<ProductSurvey | null>(null);

  useEffect(() => {
    const bridge = window.ade?.analytics?.surveys;
    if (!bridge || !onboardingSettledBeforeThisLaunch()) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      bridge.getEligible().then(
        (next) => {
          if (!cancelled && next && onboardingSettledBeforeThisLaunch()) setSurvey(next);
        },
        () => undefined,
      );
    }, ASK_AFTER_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (!survey) return null;
  return (
    <Suspense fallback={null}>
      <SurveyCard survey={survey} onDone={() => setSurvey(null)} />
    </Suspense>
  );
}
