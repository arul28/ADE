import { useEffect } from "react";
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

export function MarketingAnalyticsBridge() {
  const location = useLocation();

  useEffect(() => {
    installMarketingAnalyticsPreferenceApi();
    captureMarketingAppOpened();
    loadFreebuffPixel();
    const offPreference = onMarketingAnalyticsPreferenceChange((enabled) => {
      if (enabled) loadFreebuffPixel();
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
      offPreference();
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    const screen = normalizeMarketingScreen(location.pathname);
    if (screen) captureMarketingScreen(screen);
  }, [location.pathname]);

  return null;
}
