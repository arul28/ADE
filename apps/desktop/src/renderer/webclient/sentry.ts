/**
 * Sentry in the hosted web client (Cloudflare Pages), project `ade-web`.
 *
 * Loaded as its own chunk after the first paint, so the first paint in
 * `docs/perf/macos-baseline.md` ("Hosted web client") does not pay for it;
 * an error in the first few hundred milliseconds is the price. Production
 * builds only, unless `?ade_sentry_dev=1` is on the URL for testing the
 * wiring. The browser's Do Not Track setting is honoured.
 */
import * as Sentry from "@sentry/react";
import { connectSentry } from "../../shared/sentry/capture";
import { SENTRY_DATA_COLLECTION, SENTRY_DSNS, sentryReleaseName } from "../../shared/sentry/config";
import { createSentryEventHooks } from "../../shared/sentry/eventFilter";
import { isAdeUnavailableError } from "../lib/adeAvailability";

declare const __ADE_WEB_VERSION__: string | undefined;

export function initWebClientSentry(): void {
  const devOptIn = new URLSearchParams(window.location.search).get("ade_sentry_dev") === "1";
  if (!import.meta.env.PROD && !devOptIn) return;
  if (navigator.doNotTrack === "1") return;
  // An analytics opt-out recorded in an earlier build covers error tracking too.
  if (window.localStorage?.getItem("ade:web-product-analytics-enabled") === "false") return;
  const hooks = createSentryEventHooks();
  Sentry.init({
    dsn: SENTRY_DSNS.web,
    release: sentryReleaseName(typeof __ADE_WEB_VERSION__ === "string" ? __ADE_WEB_VERSION__ : null),
    environment: import.meta.env.PROD ? "production" : "development",
    dist: "web",
    // Errors only. Browser tracing would add about a third to this chunk, and
    // the cold-load budget counts it; no trace headers go anywhere.
    tracePropagationTargets: [],
    dataCollection: SENTRY_DATA_COLLECTION,
    // A desktop-only member called on web is expected, not a crash.
    // A page the browser translated has had its text nodes swapped under
    // React, which then fails to insert or remove them: not ADE's DOM.
    beforeSend: (event, hint) => (isAdeUnavailableError(hint?.originalException) || isTranslationDomError(hint?.originalException)
      ? null
      : hooks.beforeSend(event, hint)),
    beforeBreadcrumb: hooks.beforeBreadcrumb,
    beforeSendSpan: hooks.beforeSendSpan,
    beforeSendLog: hooks.beforeSendLog,
  });
  connectSentry(Sentry);
  Sentry.setTags({ process: "web-client", surface: "web-client" });
}

function isTranslationDomError(error: unknown): boolean {
  return error instanceof Error
    && error.name === "NotFoundError"
    && /\b(?:insertBefore|removeChild)\b/.test(error.message)
    && /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement.className);
}
