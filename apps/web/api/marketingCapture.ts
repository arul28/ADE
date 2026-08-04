/**
 * Server-side PostHog capture for the redirect endpoints.
 *
 * Deliberately dependency-free (Vercel's Node runtime gives us global fetch)
 * and deliberately silent: analytics must never turn a download into an error
 * page. When the env vars are unset — local dev, previews, forks — every call
 * here is a no-op.
 *
 * Naming follows the browser client in src/lib/marketingAnalytics.ts: the
 * `ade_marketing_` event prefix, `surface`/`route_kind` base properties, and
 * `$process_person_profile: false` + `$geoip_disable: true` so these hits stay
 * anonymous events rather than creating person profiles.
 */

const PUBLIC_POSTHOG_TOKEN = /^phc_[A-Za-z0-9_-]{8,}$/;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Bounded so a slow or dead PostHog can never hold up a download. */
export const CAPTURE_TIMEOUT_MS = 400;

export const MARKETING_DOWNLOAD_REDIRECT_EVENT = "ade_marketing_download_redirect";

export type CaptureProperties = Record<string, string | number | boolean>;

/** Shaped so `process.env` satisfies it directly, while naming the two keys
 *  that actually matter. Both must be set in Vercel for capture to happen. */
export type CaptureEnv = Readonly<Record<string, string | undefined>> & {
  ADE_POSTHOG_PROJECT_TOKEN?: string;
  ADE_POSTHOG_HOST?: string;
};

/**
 * Returns the PostHog capture URL, or null when analytics is not configured or
 * is configured with something we refuse to send to (non-https, credentials in
 * the URL, a personal `phx_` key).
 */
export function captureUrlFromEnv(env: CaptureEnv): string | null {
  const token = env.ADE_POSTHOG_PROJECT_TOKEN?.trim();
  if (!token || !PUBLIC_POSTHOG_TOKEN.test(token)) return null;
  const rawHost = env.ADE_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  try {
    const host = new URL(rawHost);
    if (host.protocol !== "https:" || host.username || host.password || host.search || host.hash) {
      return null;
    }
    host.pathname = `${host.pathname.replace(/\/+$/, "")}/i/v0/e/`;
    return host.toString();
  } catch {
    return null;
  }
}

/**
 * Host of the referring page, or "direct". Only the host — never the full URL,
 * which can carry query strings we have no business storing.
 */
export function referrerHost(referer: string | undefined): string {
  if (!referer) return "direct";
  try {
    return new URL(referer).host || "direct";
  } catch {
    return "unknown";
  }
}

export function buildCapturePayload(
  token: string,
  event: string,
  properties: CaptureProperties,
  distinctId: string,
): Record<string, unknown> {
  return {
    api_key: token,
    distinct_id: distinctId,
    event,
    properties: {
      surface: "web",
      route_kind: "marketing",
      $process_person_profile: false,
      $geoip_disable: true,
      ...properties,
    },
  };
}

/**
 * Fire a capture, bounded by CAPTURE_TIMEOUT_MS, never throwing. Awaiting the
 * bounded promise (rather than truly detaching) is what makes delivery
 * reliable on a serverless runtime that may freeze the instance the moment the
 * response ends — while the timeout keeps the worst case negligible next to
 * the redirect the browser is about to follow.
 */
export async function captureMarketingEvent(
  env: CaptureEnv,
  event: string,
  properties: CaptureProperties,
): Promise<void> {
  const url = captureUrlFromEnv(env);
  if (!url) return;
  const token = env.ADE_POSTHOG_PROJECT_TOKEN!.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCapturePayload(token, event, properties, crypto.randomUUID())),
      signal: controller.signal,
    });
  } catch {
    // Analytics is never load-bearing.
  } finally {
    clearTimeout(timeout);
  }
}
