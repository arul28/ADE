import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

import { normalizeMarketingScreen, routeMarketingAnalyticsClick } from "../lib/marketingAnalytics";
import {
  captureMarketingAppOpened,
  captureMarketingCta,
  captureMarketingFeature,
  captureMarketingScreen,
  captureUnhandledRejection,
  captureWindowError,
  installMarketingAnalyticsPreferenceApi,
  onMarketingAnalyticsPreferenceChange,
} from "../lib/marketingAnalyticsBrowser";
import { isDownloadClick, loadFreebuffPixel, reportFreebuffDownload } from "../lib/freebuffPixel";
import { markMarketingReplayRoute, syncMarketingReplay } from "../lib/marketingReplay";

/** Session replay starts once the page is idle, so the SDK never competes with first paint. */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 5_000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 2_000);
  return () => window.clearTimeout(id);
}

export function MarketingAnalyticsBridge() {
  const location = useLocation();

  useEffect(() => {
    installMarketingAnalyticsPreferenceApi();
    captureMarketingAppOpened();
    loadFreebuffPixel();
    const cancelReplayStart = whenIdle(syncMarketingReplay);
    const offPreference = onMarketingAnalyticsPreferenceChange((enabled) => {
      if (enabled) loadFreebuffPixel();
      syncMarketingReplay();
    });

    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      routeMarketingAnalyticsClick(event.target, window.location.pathname, {
        captureCta: captureMarketingCta,
        captureFeature: captureMarketingFeature,
      });
      if (isDownloadClick(event.target)) reportFreebuffDownload();
    };
    const onError = () => captureWindowError();
    const onUnhandledRejection = () => captureUnhandledRejection();

    document.addEventListener("click", onClick, { capture: true });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      cancelReplayStart();
      offPreference();
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  // A layout effect, so /open and /pair are marked for text masking before the
  // recorder sees their content.
  useLayoutEffect(() => {
    markMarketingReplayRoute(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    const screen = normalizeMarketingScreen(location.pathname);
    if (screen) captureMarketingScreen(screen);
  }, [location.pathname]);

  return null;
}
