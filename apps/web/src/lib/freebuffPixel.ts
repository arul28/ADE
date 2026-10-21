import {
  ANALYTICS_CTA_ATTRIBUTE,
  ANALYTICS_FEATURE_ATTRIBUTE,
  MARKETING_CTA_LABELS,
  MARKETING_FEATURES,
  type MarketingAnalyticsClickTarget,
} from "./marketingAnalytics";
import { isMarketingAnalyticsEnabled } from "./marketingAnalyticsBrowser";

// Freebuff ad pixel. Public tag id only; this integration needs no API key.
const FREEBUFF_SCRIPT_ID = "freebuff-tag";
const FREEBUFF_SCRIPT_SRC = "https://freebuff.com/freebuff-tag.v2.js?t=fbt_GaSWcNOrQ4aFq1NlXpWS7A";

type FreebuffQueue = ((...args: unknown[]) => void) & { q?: unknown[][] };

declare global {
  interface Window {
    freebuff?: FreebuffQueue;
  }
}

// Every control that starts a download or hands out an install command. The
// Mac/Windows triggers open the install dialog, which is the download step on
// this site, so they count too.
const DOWNLOAD_CTAS = new Set<string>([
  MARKETING_CTA_LABELS.DOWNLOAD_MAC,
  MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS,
  MARKETING_CTA_LABELS.DOWNLOAD_IOS,
  MARKETING_CTA_LABELS.DOWNLOAD_MAC_ARM64,
  MARKETING_CTA_LABELS.DOWNLOAD_MAC_X64,
  MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS_X64,
]);
const DOWNLOAD_FEATURES = new Set<string>([
  MARKETING_FEATURES.DOWNLOAD_IOS,
  MARKETING_FEATURES.COPY_INSTALL_COMMAND_MAC,
  MARKETING_FEATURES.COPY_INSTALL_COMMAND_WINDOWS,
  MARKETING_FEATURES.COPY_INSTALL_COMMAND_LINUX,
  MARKETING_FEATURES.COPY_BREW_COMMAND,
]);

/** Loads the pixel once, only while the visitor has not opted out of website analytics. */
export function loadFreebuffPixel(): void {
  if (typeof window === "undefined" || !isMarketingAnalyticsEnabled()) return;
  if (document.getElementById(FREEBUFF_SCRIPT_ID)) return;
  // Queue stub first, so calls made before the async script arrives are kept.
  window.freebuff =
    window.freebuff ||
    function (...args: unknown[]) {
      (window.freebuff!.q = window.freebuff!.q || []).push(args);
    };
  const script = document.createElement("script");
  script.id = FREEBUFF_SCRIPT_ID;
  script.async = true;
  script.src = FREEBUFF_SCRIPT_SRC;
  document.head.appendChild(script);
}

export function isDownloadClick(target: MarketingAnalyticsClickTarget): boolean {
  const cta = target.closest(`[${ANALYTICS_CTA_ATTRIBUTE}]`)?.getAttribute(ANALYTICS_CTA_ATTRIBUTE);
  if (cta && DOWNLOAD_CTAS.has(cta)) return true;
  const feature = target
    .closest(`[${ANALYTICS_FEATURE_ATTRIBUTE}]`)
    ?.getAttribute(ANALYTICS_FEATURE_ATTRIBUTE);
  return Boolean(feature && DOWNLOAD_FEATURES.has(feature));
}

/**
 * Reports a download click as the campaign's installation_completed goal. No
 * eventId on purpose: Freebuff then keeps one such conversion per ad click, so
 * a visitor who presses several download buttons counts once.
 */
export function reportFreebuffDownload(): void {
  if (!isMarketingAnalyticsEnabled() || !document.getElementById(FREEBUFF_SCRIPT_ID)) return;
  window.freebuff?.("conversion", "installation_completed");
}
