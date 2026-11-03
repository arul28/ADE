/**
 * Session replay for the public site, only while website analytics is on
 * (the same preference /privacy sets). posthog-js and its recorder are loaded
 * on demand after the page is idle, never in the first chunk.
 *
 * The pages are public, so their text is recorded. Form values are masked,
 * the live demo frame and media are not recorded, and the /open and /pair
 * pages (which show what their link carries: paths, branch and repository
 * names, pairing data) have all of their text masked. Page addresses keep
 * only origin, path and `utm_*`, as the site's own events do. It sends
 * recordings only (`$snapshot`); the site's events keep their own transport.
 */
import type { PostHog, PostHogConfig } from "posthog-js/dist/module.slim.no-external";

import { marketingCurrentUrl } from "./marketingAnalytics";
import { marketingReplayConfig } from "./marketingAnalyticsBrowser";

/** Set on <html> while a page that shows link-carried data is open. */
const MASK_ALL_TEXT_ATTRIBUTE = "data-ade-replay-mask";
const MASK_ALL_TEXT_ROUTES = new Set(["/open", "/pair"]);

type ReplayClient = {
  instance: PostHog;
  allowed: { value: boolean };
  distinctId: string;
};

let client: ReplayClient | null = null;
let loading: Promise<void> | null = null;

function maskedPageUrl(href: string): string {
  return marketingCurrentUrl(href)?.url ?? window.location.origin;
}

/** Marks or unmarks the document for full text masking; call on every route change. */
export function markMarketingReplayRoute(pathname: string): void {
  if (typeof document === "undefined") return;
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (MASK_ALL_TEXT_ROUTES.has(normalized)) {
    document.documentElement.setAttribute(MASK_ALL_TEXT_ATTRIBUTE, "");
  } else {
    document.documentElement.removeAttribute(MASK_ALL_TEXT_ATTRIBUTE);
  }
}

function buildConfig(apiHost: string, distinctId: string, allowed: { value: boolean }): Partial<PostHogConfig> {
  const currentUrl = () => maskedPageUrl(window.location.href);
  return {
    api_host: apiHost,
    bootstrap: { distinctID: distinctId, isIdentifiedID: false },
    persistence: "memory",
    person_profiles: "never",
    autocapture: false,
    rageclick: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    // On only for the project's linked recording flag (`session-replay-real-users`);
    // `before_send` drops the flag-call events.
    advanced_disable_feature_flags: false,
    advanced_disable_feature_flags_on_first_load: false,
    enable_recording_console_log: false,
    save_referrer: false,
    save_campaign_params: false,
    disable_capture_url_hashes: true,
    request_batching: false,
    get_current_url: currentUrl,
    session_recording: {
      maskAllInputs: true,
      maskInputOptions: { password: true },
      maskTextSelector: `[${MASK_ALL_TEXT_ATTRIBUTE}] *`,
      blockSelector: "iframe, video, canvas, [data-ph-block]",
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
      captureCanvas: { recordCanvas: false },
      slimDOMOptions: "all",
      maskCapturedNetworkRequestFn: (request) => ({ ...request, name: maskedPageUrl(request.name) }),
    },
    before_send: (event) => {
      if (!allowed.value || !event || event.event !== "$snapshot") return null;
      const properties = event.properties ?? {};
      for (const key of Object.keys(properties)) {
        if (key.startsWith("$initial_") || key.startsWith("$referr") || key.startsWith("utm_")) {
          delete properties[key];
        }
      }
      const page = marketingCurrentUrl(window.location.href);
      if (page) {
        properties.$current_url = page.url;
        properties.$host = page.host;
        properties.$pathname = page.pathname;
      }
      properties.$process_person_profile = false;
      properties.$geoip_disable = true;
      return { ...event, properties };
    },
  };
}

async function createClient(config: { projectToken: string; apiHost: string; distinctId: string }): Promise<void> {
  await import("posthog-js/dist/posthog-recorder");
  const [{ posthog }, { SessionReplayExtensions }] = await Promise.all([
    import("posthog-js/dist/module.slim.no-external"),
    import("posthog-js/dist/extension-bundles"),
  ]);
  // The preference can turn off while the chunks load.
  const latest = marketingReplayConfig();
  if (!latest) return;
  const allowed = { value: true };
  const instance = posthog.init(
    config.projectToken,
    {
      ...buildConfig(config.apiHost, latest.distinctId, allowed),
      __extensionClasses: { ...SessionReplayExtensions },
    } as Partial<PostHogConfig>,
    "ade_marketing_replay",
  );
  if (instance) client = { instance, allowed, distinctId: latest.distinctId };
}

function stop(): void {
  if (!client || !client.allowed.value) return;
  client.allowed.value = false;
  try {
    client.instance.stopSessionRecording();
  } catch {
    // The gate is closed either way.
  }
}

/** Starts, resumes or stops the recording to match the analytics preference. */
export function syncMarketingReplay(): void {
  if (typeof window === "undefined") return;
  const config = marketingReplayConfig();
  if (!config) {
    stop();
    return;
  }
  if (!client) {
    if (!loading) {
      loading = createClient(config)
        .catch(() => undefined)
        .finally(() => {
          loading = null;
        });
    }
    return;
  }
  if (client.distinctId !== config.distinctId) {
    // Opting out rotated the anonymous id: a new recording under the new id.
    stop();
    client.instance.reset();
    client.instance.register({ distinct_id: config.distinctId, $device_id: config.distinctId });
    client.distinctId = config.distinctId;
  }
  if (!client.allowed.value) {
    client.allowed.value = true;
    client.instance.startSessionRecording();
  }
}
