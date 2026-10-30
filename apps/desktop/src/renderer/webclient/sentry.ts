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
import { resolveReleaseChannel } from "../../shared/packageChannel";
import { SENTRY_DATA_COLLECTION, SENTRY_DSNS, sentryCommonTags, sentryReleaseName } from "../../shared/sentry/config";
import { createSentryEventHooks, setSentryUserResolver } from "../../shared/sentry/eventFilter";
import { isAdeUnavailableError } from "../lib/adeAvailability";

declare const __ADE_WEB_VERSION__: string | undefined;

export function initWebClientSentry(): void {
  const devOptIn = new URLSearchParams(window.location.search).get("ade_sentry_dev") === "1";
  if (!import.meta.env.PROD && !devOptIn) return;
  if (navigator.doNotTrack === "1") return;
  // An analytics opt-out recorded in an earlier build covers error tracking too.
  if (window.localStorage?.getItem("ade:web-product-analytics-enabled") === "false") return;
  const hooks = createSentryEventHooks();
  const version = typeof __ADE_WEB_VERSION__ === "string" ? __ADE_WEB_VERSION__ : null;
  Sentry.init({
    dsn: SENTRY_DSNS.web,
    release: sentryReleaseName(version),
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
  // No `is_internal`: a browser has no team-install marker. No `arch`: a
  // browser does not say it reliably.
  Sentry.setTags({
    ...sentryCommonTags({
      surface: "web",
      client: "web",
      releaseChannel: resolveReleaseChannel({ env: {}, packaged: import.meta.env.PROD, version }),
    }),
    process: "web-client",
  });
  setSentryUserResolver(webAccountUserHash);
  void refreshAccountHash();
}

/**
 * The Sentry user, as on desktop: the same one-way account hash PostHog uses
 * (`ade_user_` + the first 32 hex of SHA-256 over
 * `ade-product-analytics-account-v1:<account id>`), never the account id.
 * Read at send time; hashing is async in a browser, so each send refreshes the
 * cached hash for the next one, and the first error after a sign-in goes
 * without a user. Signed out, events carry no user.
 */
let cachedAccountHash: { userId: string; hash: string } | null = null;

function webAccountUserHash(): string | null {
  void refreshAccountHash();
  return cachedAccountHash?.hash ?? null;
}

async function refreshAccountHash(): Promise<void> {
  try {
    const status = await window.ade?.account?.status?.();
    const userId = status?.signedIn ? status.userId?.trim() || "" : "";
    if (!userId) {
      cachedAccountHash = null;
      return;
    }
    if (cachedAccountHash?.userId === userId) return;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`ade-product-analytics-account-v1:${userId}`),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    cachedAccountHash = { userId, hash: `ade_user_${hex.slice(0, 32)}` };
  } catch {
    // No user is better than a wrong one.
  }
}

function isTranslationDomError(error: unknown): boolean {
  return error instanceof Error
    && error.name === "NotFoundError"
    && /\b(?:insertBefore|removeChild)\b/.test(error.message)
    && /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement.className);
}
