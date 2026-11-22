/**
 * Session replay for the public site, only while website analytics is on
 * (the same preference /privacy sets). posthog-js and its recorder are loaded
 * on demand after the page is idle, never in the first chunk.
 *
 * The pages are public, so their text is recorded. Form values are masked,
 * the live demo frame and media are not recorded, and the /open, /pair and
 * /invite pages (which show what their link carries: paths, branch and
 * repository names, pairing data, an inviter's name) have all of their text masked. Page addresses keep
 * only origin, path and `utm_*`, as the site's own events do. It sends
 * recordings only (`$snapshot`); the site's events keep their own transport.
 */
import type { PostHog, PostHogConfig } from "posthog-js/dist/module.slim.no-external";

import { marketingCurrentUrl, withoutInviteCode } from "./marketingAnalytics";
import { marketingReplayConfig } from "./marketingAnalyticsBrowser";

/** Set on <html> while a page that shows link-carried data is open. */
const MASK_ALL_TEXT_ATTRIBUTE = "data-ade-replay-mask";
const MASK_ALL_TEXT_ROUTES = new Set(["/open", "/pair"]);
/** Attributes that can carry a link's repo, branch or path on the link pages. */
const LINK_DATA_ATTRIBUTE = /^(?:href|src|srcset|title|alt|value|placeholder|content|action|aria-.*|data-.*)$/i;

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
  // The router matches routes case-insensitively, so `/Open` is `/open`.
  const normalized = pathname.replace(/\/+$/, "").toLowerCase() || "/";
  // An invite page shows the inviter's first name and the code: all text masked.
  if (MASK_ALL_TEXT_ROUTES.has(normalized) || withoutInviteCode(normalized) === "/invite") {
    document.documentElement.setAttribute(MASK_ALL_TEXT_ATTRIBUTE, "");
  } else {
    document.documentElement.removeAttribute(MASK_ALL_TEXT_ATTRIBUTE);
  }
}

function buildConfig(apiHost: string, distinctId: string, allowed: { value: boolean }): Partial<PostHogConfig> {
  const currentUrl = () => maskedPageUrl(window.location.href);
  return {
    api_host: apiHost,
    // Through the site's `/_t/` proxy, links in PostHog still point at the app.
    ui_host: "https://us.posthog.com",
    bootstrap: { distinctID: distinctId, isIdentifiedID: false },
    persistence: "memory",
    person_profiles: "never",
    autocapture: false,
    rageclick: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    // Website only: click and scroll positions for PostHog heatmaps
    // (`$$heatmap`), on the same public pages the replay records.
    capture_heatmaps: true,
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
      // On the link pages an "Open in ADE" `href` and similar attributes carry
      // repository, branch and path from the link: masked there. Layout and
      // the recorder's own attributes (`_cssText`, `rr_*`) pass, so the page
      // still plays back styled.
      maskAttributeFn: (name, value) =>
        document.documentElement.hasAttribute(MASK_ALL_TEXT_ATTRIBUTE) && LINK_DATA_ATTRIBUTE.test(name)
          ? "*".repeat(Math.min(value.length, 16))
          : value,
      blockSelector: "iframe, video, canvas, [data-ph-block]",
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
      captureCanvas: { recordCanvas: false },
      slimDOMOptions: "all",
      maskCapturedNetworkRequestFn: (request) => ({ ...request, name: maskedPageUrl(request.name) }),
    },
    before_send: (event) => {
      if (!allowed.value || !event || (event.event !== "$snapshot" && event.event !== "$$heatmap")) return null;
      const properties = event.properties ?? {};
      for (const key of Object.keys(properties)) {
        if (key.startsWith("$initial_") || key.startsWith("$referr") || key.startsWith("utm_")) {
          delete properties[key];
        }
      }
      if (event.event === "$$heatmap") {
        // Heatmap points are grouped by the page address they were recorded
        // on and sent in batches, possibly after the visitor moved on. Each
        // group is judged by its own address: the link pages, whose query
        // carries repo, branch and path, are dropped; the rest are keyed by
        // the masked address, merging groups that mask to the same key.
        const data = properties.$heatmap_data;
        const kept: Record<string, unknown[]> = {};
        if (data && typeof data === "object") {
          for (const [href, points] of Object.entries(data as Record<string, unknown>)) {
            let pathname: string;
            try {
              pathname = new URL(href).pathname.replace(/\/+$/, "").toLowerCase() || "/";
            } catch {
              continue;
            }
            if (MASK_ALL_TEXT_ROUTES.has(pathname)) continue;
            const key = maskedPageUrl(href);
            kept[key] = [...(kept[key] ?? []), ...(Array.isArray(points) ? points : [])];
          }
        }
        if (Object.keys(kept).length === 0) return null;
        properties.$heatmap_data = kept;
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
  const [{ posthog }, { SessionReplayExtensions, AnalyticsExtensions }] = await Promise.all([
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
      // The slim build takes its replay extension here. `__extensionClasses`
      // is not in posthog-js's public config type, hence the cast below.
      // Heatmaps only from the analytics bundle: autocapture stays off.
      __extensionClasses: { ...SessionReplayExtensions, heatmaps: AnalyticsExtensions.heatmaps },
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
    // Removes the heatmap listeners and drops their buffered points, so
    // clicks made while analytics is off are never sent after an opt-in.
    client.instance.set_config({ capture_heatmaps: false });
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
    client.instance.set_config({ capture_heatmaps: true });
    client.instance.startSessionRecording();
  }
}
