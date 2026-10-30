import {
  FIRST_TOUCH_STORAGE_KEY,
  firstTouchProperties,
  MarketingAnalytics,
  marketingCurrentUrl,
  marketingLandingProperties,
  readMarketingLanding,
  MARKETING_ERROR_KINDS,
  type MarketingErrorKind,
  type MarketingFeature,
  type MarketingCtaLabel,
  type MarketingCtaPosition,
  type MarketingScreen,
  normalizeMarketingScreen,
  type PostHogCapturePayload,
  type StorageLike,
} from "./marketingAnalytics";

const PREFERENCE_STORAGE_KEY = "ade.analytics.enabled.v1";
const PREFERENCE_EVENT = "ade:analytics-preference-changed";
const LANDING_STORAGE_KEY = "ade.analytics.marketing.landing.v1";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

type AnalyticsPreferenceDetail = { enabled: boolean };

let preferenceOverride: boolean | undefined;
let preferenceApiInstalled = false;

declare global {
  interface Window {
    adeAnalytics?: Readonly<{
      isEnabled: () => boolean;
      setEnabled: (enabled: boolean) => void;
    }>;
  }

  interface WindowEventMap {
    "ade:analytics-preference-changed": CustomEvent<AnalyticsPreferenceDetail>;
  }
}

// Analytics are on unless the visitor has explicitly opted out on /privacy.
function safePreferenceRead(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_STORAGE_KEY) !== "false";
  } catch {
    return preferenceOverride ?? true;
  }
}

function browserStorage(): StorageLike | null {
  try {
    const storage = window.localStorage;
    storage.getItem(PREFERENCE_STORAGE_KEY);
    return storage;
  } catch {
    return null;
  }
}

function captureUrlFromEnv(): string | null {
  const token = (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined)?.trim();
  if (!token || !/^phc_[A-Za-z0-9_-]{8,}$/.test(token)) return null;
  const rawHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined)?.trim() || DEFAULT_POSTHOG_HOST;
  try {
    const host = new URL(rawHost);
    if (host.protocol !== "https:" || host.username || host.password || host.search || host.hash) return null;
    host.pathname = `${host.pathname.replace(/\/+$/, "")}/i/v0/e/`;
    return host.toString();
  } catch {
    return null;
  }
}

function projectTokenFromEnv(): string {
  return (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined)?.trim() ?? "";
}

async function sendToPostHog(captureUrl: string, payload: PostHogCapturePayload): Promise<void> {
  const response = await fetch(captureUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "omit",
    keepalive: true,
    mode: "cors",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`PostHog capture failed with ${response.status}`);
}

/**
 * The visit's landing, read once per browser tab session (sessionStorage), so
 * moving between pages keeps the referrer and campaign the visit arrived with.
 * The first landing this browser ever had is kept in localStorage.
 */
function landingContext(): (() => Record<string, string>) | undefined {
  if (typeof window === "undefined") return undefined;
  let landing: Record<string, string> | null = null;
  try {
    const stored = window.sessionStorage.getItem(LANDING_STORAGE_KEY);
    if (stored) landing = JSON.parse(stored) as Record<string, string>;
  } catch {
    landing = null;
  }
  const arrival = readMarketingLanding(window.location.href, document.referrer);
  if (!landing) {
    landing = marketingLandingProperties(arrival);
    try {
      window.sessionStorage.setItem(LANDING_STORAGE_KEY, JSON.stringify(landing));
    } catch {
      // Without session storage the landing lives for this page load only.
    }
  }
  const sessionLanding = landing;
  // This page load's arrival can be the first touch once. After an opt-out
  // clears it, a later opt-in on the same page does not bring it back.
  let arrivalSeen = false;
  return () => {
    let firstTouch: Record<string, string> | null = null;
    try {
      const stored = window.localStorage.getItem(FIRST_TOUCH_STORAGE_KEY);
      if (stored) {
        firstTouch = JSON.parse(stored) as Record<string, string>;
      } else if (!arrivalSeen) {
        firstTouch = firstTouchProperties(arrival);
        window.localStorage.setItem(FIRST_TOUCH_STORAGE_KEY, JSON.stringify(firstTouch));
      }
      arrivalSeen = true;
    } catch {
      firstTouch = null;
    }
    const page = marketingCurrentUrl(window.location.href);
    return {
      ...(firstTouch ?? {}),
      ...sessionLanding,
      ...(page ? { $current_url: page.url, $host: page.host, $pathname: page.pathname } : {}),
    };
  };
}

const captureUrl = typeof window === "undefined" ? null : captureUrlFromEnv();
const analyticsStorage = typeof window === "undefined" ? null : browserStorage();
const analytics =
  typeof window !== "undefined" && captureUrl && analyticsStorage
    ? new MarketingAnalytics({
        projectToken: projectTokenFromEnv(),
        storage: analyticsStorage,
        isEnabled: safePreferenceRead,
        context: landingContext(),
        transport: (payload) => sendToPostHog(captureUrl, payload),
      })
    : null;

export function isMarketingAnalyticsEnabled(): boolean {
  return typeof window === "undefined" ? false : safePreferenceRead();
}

export function isMarketingAnalyticsConfigured(): boolean {
  return analytics !== null;
}

export function setMarketingAnalyticsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERENCE_STORAGE_KEY, enabled ? "true" : "false");
    preferenceOverride = undefined;
  } catch {
    // Keep the in-page API stable when storage is unavailable.
    preferenceOverride = enabled;
  }
  if (!enabled) analytics?.reset();
  window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: { enabled } }));
  if (enabled) {
    analytics?.captureAppOpened();
    const screen = normalizeMarketingScreen(window.location.pathname);
    if (screen) analytics?.captureScreen(screen);
  }
}

export function installMarketingAnalyticsPreferenceApi(): void {
  if (typeof window === "undefined") return;
  Object.defineProperty(window, "adeAnalytics", {
    configurable: true,
    value: Object.freeze({
      isEnabled: isMarketingAnalyticsEnabled,
      setEnabled: setMarketingAnalyticsEnabled,
    }),
  });
  if (preferenceApiInstalled) return;
  preferenceApiInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== PREFERENCE_STORAGE_KEY) return;
    preferenceOverride = undefined;
    const enabled = safePreferenceRead();
    if (!enabled) analytics?.reset();
    window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: { enabled } }));
  });
}

export function captureMarketingAppOpened(): void {
  analytics?.captureAppOpened();
}

export function captureMarketingScreen(screen: MarketingScreen): void {
  analytics?.captureScreen(screen);
}

export function captureMarketingFeature(feature: MarketingFeature, screen?: MarketingScreen): void {
  analytics?.captureFeature(feature, screen);
}

export function captureMarketingCta(
  ctaLabel: MarketingCtaLabel,
  screen: MarketingScreen,
  position: MarketingCtaPosition,
): void {
  analytics?.captureCta(ctaLabel, screen, position);
}

export function captureMarketingError(errorKind: MarketingErrorKind): void {
  analytics?.captureError(errorKind);
}

export function captureWindowError(): void {
  captureMarketingError(MARKETING_ERROR_KINDS.WINDOW_ERROR);
}

export function captureUnhandledRejection(): void {
  captureMarketingError(MARKETING_ERROR_KINDS.UNHANDLED_REJECTION);
}

export function onMarketingAnalyticsPreferenceChange(listener: (enabled: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: CustomEvent<AnalyticsPreferenceDetail>) => listener(event.detail.enabled);
  window.addEventListener(PREFERENCE_EVENT, handler);
  return () => window.removeEventListener(PREFERENCE_EVENT, handler);
}
