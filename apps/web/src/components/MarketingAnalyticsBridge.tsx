import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import {
  ANALYTICS_FEATURE_ATTRIBUTE,
  ANALYTICS_CTA_ATTRIBUTE,
  ANALYTICS_CTA_POSITION_ATTRIBUTE,
  isMarketingCtaLabel,
  isMarketingCtaPosition,
  isMarketingFeature,
  normalizeMarketingScreen,
} from "../lib/marketingAnalytics";
import {
  captureMarketingAppOpened,
  captureMarketingCta,
  captureMarketingFeature,
  captureMarketingScreen,
  captureUnhandledRejection,
  captureWindowError,
  hasMarketingAnalyticsPreference,
  installMarketingAnalyticsPreferenceApi,
  isMarketingAnalyticsConfigured,
  setMarketingAnalyticsEnabled,
} from "../lib/marketingAnalyticsBrowser";

export function MarketingAnalyticsBridge() {
  const location = useLocation();
  const [consentRequired, setConsentRequired] = useState(
    () => isMarketingAnalyticsConfigured() && !hasMarketingAnalyticsPreference(),
  );

  useEffect(() => {
    installMarketingAnalyticsPreferenceApi();
    captureMarketingAppOpened();

    const onClick = (event: MouseEvent) => {
      const ctaTarget = event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${ANALYTICS_CTA_ATTRIBUTE}]`)
        : null;
      const ctaLabel = ctaTarget?.getAttribute(ANALYTICS_CTA_ATTRIBUTE);
      const ctaPosition = ctaTarget?.getAttribute(ANALYTICS_CTA_POSITION_ATTRIBUTE);
      const screen = normalizeMarketingScreen(window.location.pathname) ?? undefined;
      if (isMarketingCtaLabel(ctaLabel) && isMarketingCtaPosition(ctaPosition) && screen) {
        captureMarketingCta(ctaLabel, screen, ctaPosition);
        return;
      }
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${ANALYTICS_FEATURE_ATTRIBUTE}]`)
        : null;
      const feature = target?.getAttribute(ANALYTICS_FEATURE_ATTRIBUTE);
      if (!isMarketingFeature(feature)) return;
      captureMarketingFeature(feature, screen);
    };
    const onError = () => captureWindowError();
    const onUnhandledRejection = () => captureUnhandledRejection();

    document.addEventListener("click", onClick, { capture: true });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    const screen = normalizeMarketingScreen(location.pathname);
    if (screen) captureMarketingScreen(screen);
  }, [location.pathname]);

  if (!consentRequired) return null;

  const choose = (enabled: boolean) => {
    setMarketingAnalyticsEnabled(enabled);
    setConsentRequired(false);
  };

  return (
    <aside
      aria-label="Anonymous analytics choice"
      className="fixed inset-x-4 bottom-4 z-[100] mx-auto max-w-3xl rounded-2xl border border-border bg-card/95 p-4 shadow-2xl backdrop-blur-xl sm:flex sm:items-center sm:gap-5"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">Help improve ADE?</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-fg">
          Allow anonymous, daily-capped page and feature analytics. No URLs, referrers, prompts, code, raw errors,
          or recordings are sent. Read the <a className="underline underline-offset-2" href="/privacy">privacy policy</a>.
        </p>
      </div>
      <div className="mt-3 flex shrink-0 gap-2 sm:mt-0">
        <button
          type="button"
          className="focus-ring rounded-lg border border-border bg-bg px-3 py-2 text-xs font-semibold text-fg hover:bg-muted/70"
          onClick={() => choose(false)}
        >
          Not now
        </button>
        <button
          type="button"
          className="focus-ring rounded-lg bg-fg px-3 py-2 text-xs font-semibold text-bg hover:opacity-90"
          onClick={() => choose(true)}
        >
          Allow analytics
        </button>
      </div>
    </aside>
  );
}
