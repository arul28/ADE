/**
 * Session replay for the desktop window, privacy first.
 *
 * Runs only while main says analytics is on (`analytics.getReplayConfig()`
 * answers null otherwise) and only in the Electron window: the hosted web
 * client and the Vite browser mock have no `getReplayConfig`, so they record
 * nothing. posthog-js and its recorder are loaded on demand, so a window with
 * analytics off never loads them and the startup chunk does not grow.
 *
 * What a recording holds: the page's layout and styling, with every text node
 * replaced by `*`s of the same length, every form value masked, every element
 * attribute outside a short layout allowlist masked, and images, video,
 * canvases (terminals), frames and the code editor not recorded at all. No
 * console logs, no network requests, no page URL beyond the tab's name. It
 * sends recordings only (`$snapshot`); every other event posthog-js could
 * make is dropped before it leaves.
 */
import type { PostHog, PostHogConfig } from "posthog-js/dist/module.slim.no-external";
import type { ProductAnalyticsReplayConfig } from "../../shared/types/productAnalytics";
import { productAnalyticsScreenForPathname } from "../components/app/AppShell";
import { isWebClientMode } from "./webClientMode";

/**
 * Subtrees rrweb does not record (a grey box of the same size in the replay).
 * Images and video can show anything; canvases are the terminals' and charts'
 * pixels; frames are scenes, the built-in browser and previews; Monaco and
 * xterm are the code editor and terminals, which also change on every
 * keystroke and would be the costliest parts to record.
 */
export const SESSION_REPLAY_BLOCK_SELECTOR = [
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "iframe",
  "webview",
  "object",
  "embed",
  "image",
  "foreignObject",
  ".xterm",
  ".monaco-editor",
  ".monaco-diff-editor",
  "[data-ph-block]",
].join(", ");

/**
 * Attributes recorded as they are. They carry layout, styling and widget
 * state, never content. Every other attribute (`title`, `aria-label`,
 * `placeholder`, `alt`, `href`, `src`, `id`, `name`, `value`, `data-*`
 * outside this list) is replaced by `*`s.
 */
const LAYOUT_ATTRIBUTES = new Set([
  "class",
  "style",
  "role",
  "type",
  "dir",
  "hidden",
  "disabled",
  "checked",
  "selected",
  "open",
  "readonly",
  "tabindex",
  "aria-hidden",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "aria-pressed",
  "aria-disabled",
  "aria-current",
  "aria-modal",
  "aria-orientation",
  "data-state",
  "data-side",
  "data-align",
  "data-orientation",
  "data-disabled",
  "data-highlighted",
  "data-active",
  "data-selected",
  "data-ade-platform",
  // Stylesheets and rrweb's own bookkeeping (`_cssText` is the inlined CSS).
  "rel",
  "media",
  "_csstext",
  // SVG geometry: icons and spinners.
  "xmlns",
  "viewbox",
  "d",
  "fill",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "transform",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
]);

export function maskSessionReplayAttribute(name: string, value: string): string {
  const key = name.toLowerCase();
  if (key.startsWith("rr_")) return value;
  if (!LAYOUT_ATTRIBUTES.has(key)) return "*".repeat(value.length);
  // A style can carry `url(...)`: a file path or an image address.
  if (key === "style" && /url\s*\(/i.test(value)) return value.replace(/url\s*\([^)]*\)/gi, "none");
  return value;
}

/** The page address a recording sees: the tab's name only, never a path or id. */
export function sessionReplayUrl(location: Pick<Location, "hash" | "pathname">): string {
  const route = location.hash.startsWith("#/")
    ? location.hash.slice(1)
    : location.pathname;
  const pathname = route.split(/[?#]/, 1)[0] || "/";
  return `ade://desktop/${productAnalyticsScreenForPathname(pathname)}`;
}

/** Recheck consent and identity this often while recording. One IPC, no disk scan. */
const RECHECK_WHILE_RECORDING_MS = 60_000;

/**
 * The one posthog-js client this window ever makes. A second client in the
 * same page never starts its recorder, so turning analytics back on, or a new
 * identity, reuses this one.
 */
type ReplayClient = {
  endpointKey: string;
  instance: PostHog;
  /** Read by `before_send`; false drops anything still on its way out. */
  allowed: { value: boolean };
  distinctId: string;
};

let client: ReplayClient | null = null;
let syncing: Promise<void> | null = null;
let syncAgain = false;
let recheckTimer: number | null = null;
let started = false;

function replayBridge(): (() => Promise<ProductAnalyticsReplayConfig | null>) | null {
  if (typeof window === "undefined" || isWebClientMode() || window.__adeBrowserMock) return null;
  return window.ade?.analytics?.getReplayConfig ?? null;
}

function setRechecking(on: boolean): void {
  if (on && recheckTimer === null) {
    recheckTimer = window.setInterval(() => void syncSessionReplay(), RECHECK_WHILE_RECORDING_MS);
  } else if (!on && recheckTimer !== null) {
    window.clearInterval(recheckTimer);
    recheckTimer = null;
  }
}

function stopRecording(): void {
  setRechecking(false);
  if (!client || !client.allowed.value) return;
  // Close the gate first so a buffer the recorder flushes while stopping is
  // dropped instead of sent.
  client.allowed.value = false;
  try {
    client.instance.stopSessionRecording();
  } catch {
    // A failed stop still leaves the gate closed.
  }
}

function resumeRecording(current: ReplayClient, distinctId: string): void {
  if (current.distinctId !== distinctId) {
    // Signed in or out: a new recording under the new id, never a
    // continuation of the old one.
    stopRecording();
    current.instance.reset();
    current.instance.register({ distinct_id: distinctId, $device_id: distinctId });
    current.distinctId = distinctId;
  }
  if (!current.allowed.value) {
    current.allowed.value = true;
    current.instance.startSessionRecording();
  }
  setRechecking(true);
}

function buildConfig(config: ProductAnalyticsReplayConfig, allowed: { value: boolean }): Partial<PostHogConfig> {
  const currentUrl = () => sessionReplayUrl(window.location);
  return {
    api_host: config.apiHost,
    bootstrap: { distinctID: config.distinctId, isIdentifiedID: false },
    persistence: "memory",
    disable_persistence: false,
    person_profiles: "never",
    // Recordings only. Nothing else posthog-js can do is on.
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
    // Flags stay on for one reason: the project links recording to the
    // `session-replay-real-users` flag, which is false for ADE's own team and
    // test accounts (`is_internal`), so they are never recorded. The recorder
    // waits for that answer. Flag-call events are dropped by `before_send`.
    // Remote config (`/array/<token>/config`) carries the replay settings.
    advanced_disable_feature_flags: false,
    advanced_disable_feature_flags_on_first_load: false,
    enable_recording_console_log: false,
    save_referrer: false,
    save_campaign_params: false,
    disable_capture_url_hashes: true,
    // Each recording chunk goes out as soon as it is captured, so turning
    // analytics off leaves nothing waiting in a queue.
    request_batching: false,
    get_current_url: currentUrl,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      maskInputOptions: { password: true },
      blockSelector: SESSION_REPLAY_BLOCK_SELECTOR,
      maskAttributeFn: (name, value) => maskSessionReplayAttribute(name, value),
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
      captureCanvas: { recordCanvas: false },
      collectFonts: false,
      slimDOMOptions: "all",
      // Every page address the recorder writes (its meta events and
      // `$snapshot_host`) goes through this, so it never holds a path.
      maskCapturedNetworkRequestFn: (request) => ({ ...request, name: currentUrl() }),
    },
    before_send: (event) => {
      if (!allowed.value || !event || event.event !== "$snapshot") return null;
      const properties = event.properties ?? {};
      for (const key of Object.keys(properties)) {
        if (key.startsWith("$initial_") || key.startsWith("$referr") || key.startsWith("utm_")) {
          delete properties[key];
        }
      }
      const url = currentUrl();
      properties.$current_url = url;
      properties.$host = "desktop";
      properties.$pathname = new URL(url).pathname;
      properties.$process_person_profile = false;
      properties.$geoip_disable = true;
      return { ...event, properties };
    },
  };
}

async function createClient(config: ProductAnalyticsReplayConfig, endpointKey: string): Promise<void> {
  // Recorder first: it installs rrweb where posthog-js looks for it, so the
  // SDK never tries to load a script (and external loading is off anyway).
  await import("posthog-js/dist/posthog-recorder");
  const [{ posthog }, { SessionReplayExtensions }] = await Promise.all([
    import("posthog-js/dist/module.slim.no-external"),
    import("posthog-js/dist/extension-bundles"),
  ]);
  const allowed = { value: true };
  const instance = posthog.init(
    config.projectToken,
    {
      ...buildConfig(config, allowed),
      __extensionClasses: { ...SessionReplayExtensions },
    } as Partial<PostHogConfig>,
    "ade_replay",
  );
  if (!instance) return;
  client = { endpointKey, instance, allowed, distinctId: config.distinctId };
  setRechecking(true);
}

async function syncOnce(): Promise<void> {
  const bridge = replayBridge();
  if (!bridge) return;
  let config: ProductAnalyticsReplayConfig | null = null;
  try {
    config = await bridge();
  } catch {
    config = null;
  }
  if (!config) {
    stopRecording();
    return;
  }
  const endpointKey = `${config.projectToken}\n${config.apiHost}`;
  if (!client) {
    try {
      await createClient(config, endpointKey);
    } catch {
      // posthog-js failed to load or start: no replay this launch.
      client = null;
    }
    return;
  }
  if (client.endpointKey !== endpointKey) {
    // A different project or host mid-session (a changed build setting):
    // stay stopped until the next launch rather than mix the two.
    stopRecording();
    return;
  }
  resumeRecording(client, config.distinctId);
}

/** Re-read consent and identity, starting or stopping the recording to match. */
export function syncSessionReplay(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      do {
        syncAgain = false;
        await syncOnce();
      } while (syncAgain);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/**
 * Starts replay when analytics is on and keeps it in step: rechecked when the
 * window regains focus, and every minute while recording, so turning analytics
 * off (from the CLI, or `DO_NOT_TRACK`) or signing in or out takes effect.
 */
export function startSessionReplay(): void {
  if (started || !replayBridge()) return;
  started = true;
  window.addEventListener("focus", () => void syncSessionReplay());
  window.addEventListener("pagehide", stopRecording);
  void syncSessionReplay();
}
