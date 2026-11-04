/**
 * Session replay for the desktop window, privacy first.
 *
 * Runs only while main says analytics is on (`analytics.getReplayConfig()`
 * answers null otherwise) and only in the Electron window: the hosted web
 * client and the Vite browser mock have no `getReplayConfig`, so they record
 * nothing. posthog-js and its recorder are loaded on demand, so a window with
 * analytics off never loads them and the startup chunk does not grow.
 *
 * What a recording holds: the page's layout and styling; ADE's own interface
 * text (navigation, settings labels, dialogs, banners, toasts, error screens)
 * inside regions marked `data-ph-unmask`, with secrets, emails, paths, URLs,
 * quoted strings, slashed names and the open project's lane, branch, project
 * and machine names starred out; every other text node replaced by `*`s of the
 * same length; every form value masked; every element attribute outside a
 * short layout allowlist masked; and images, video, canvases (terminals),
 * frames and the code editor not recorded at all. No console logs, no network
 * requests, no page URL beyond the tab's name. It sends recordings only
 * (`$snapshot`); every other event posthog-js could make is dropped before it
 * leaves.
 *
 * Marking regions: put `data-ph-unmask` on the root of a component that
 * renders only ADE-authored copy, and `data-ph-mask` on anything inside it that
 * can hold the person's content (a lane name in a header, custom children).
 * The nearest marked ancestor decides; unmarked text is always masked.
 */
import type { PostHog, PostHogConfig } from "posthog-js/dist/module.slim.no-external";
import { scrubFreeText } from "../../shared/sentry/scrub";
import type { ProductAnalyticsReplayConfig } from "../../shared/types/productAnalytics";
import { productAnalyticsScreenForPathname } from "../components/app/AppShell";
import { rootAppStoreApi, workViewStoreForProject, type AppState } from "../state/appStore";
import { captureError } from "../../shared/sentry/capture";
import { subscribeAccountStatus } from "./account";
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

/**
 * Text attributes shown, scrubbed like text, on elements inside a
 * `data-ph-unmask` region: tooltips, accessible names and placeholders are
 * ADE's own words there. Never `value`.
 */
const UNMASKED_TEXT_ATTRIBUTES = new Set(["title", "aria-label", "placeholder"]);

const REPLAY_REGION_SELECTOR = "[data-ph-mask], [data-ph-unmask]";

/** True when the nearest marked element (itself or an ancestor) is `data-ph-unmask`. */
function inUnmaskedRegion(element: Element | null | undefined): boolean {
  const region = element?.closest?.(REPLAY_REGION_SELECTOR);
  return Boolean(region && !region.hasAttribute("data-ph-mask"));
}

const maskAll = (text: string): string => text.replace(/\S/g, "*");
const stars = (match: string): string => "*".repeat(match.length);

/**
 * Shapes in ADE's copy that are the person's content: URLs, quoted strings
 * (git and the brain quote refs, names and paths), anything with a slash in it
 * (branches, relative paths, `owner/repo`), file names, `@handles`, commit and
 * object ids. `scrubFreeText` has already taken secrets, emails and absolute
 * paths.
 */
const CONTENT_SHAPES: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`|(?<!\w)'[^'\n]+'(?!\w)/g,
  /\S*(?:\w[/\\]|[/\\]\w)\S*/g,
  /\b[\w-]+\.[A-Za-z]\w{0,9}\b/g,
  /(?<!\w)@[\w.-]+/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi,
];

let nameSources: readonly unknown[] = [];
let namePattern: RegExp | null = null;

function addName(names: Set<string>, value: string | null | undefined): void {
  const name = value?.trim();
  if (!name || name.length < 2) return;
  names.add(name);
  if (name.startsWith("refs/heads/")) names.add(name.slice("refs/heads/".length));
  const base = name.split(/[/\\]/).filter(Boolean).pop();
  if (base && base !== name && base.length >= 2) names.add(base);
}

function collectNames(states: readonly AppState[]): string[] {
  const names = new Set<string>();
  for (const state of states) {
    addName(names, state.project?.displayName);
    addName(names, state.project?.rootPath);
    for (const info of Object.values(state.projectInfoByRoot)) {
      addName(names, info.displayName);
      addName(names, info.rootPath);
    }
    for (const tab of state.openRemoteProjectTabs) {
      addName(names, tab.displayName);
      addName(names, tab.runtimeName);
      addName(names, tab.hostname);
    }
    for (const lane of state.lanes) {
      addName(names, lane.name);
      addName(names, lane.branchRef);
    }
    for (const machine of Object.values(state.crossMachineLanesByMachineId)) {
      addName(names, machine.machineName);
      for (const lane of machine.lanes) {
        addName(names, lane.name);
        addName(names, lane.branchRef);
      }
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

/**
 * One pattern for the names this window knows (projects, lanes, branches,
 * machines), rebuilt only when a list it reads changes.
 */
function knownNamePattern(): RegExp | null {
  const root = rootAppStoreApi.getState();
  const project = workViewStoreForProject(root.projectBinding?.key ?? root.project?.rootPath).getState();
  const sources = [root, project].flatMap((state) => [
    state.project,
    state.projectInfoByRoot,
    state.openRemoteProjectTabs,
    state.lanes,
    state.crossMachineLanesByMachineId,
  ]);
  if (sources.length === nameSources.length && sources.every((source, index) => source === nameSources[index])) {
    return namePattern;
  }
  nameSources = sources;
  const names = collectNames(root === project ? [root] : [root, project]);
  namePattern = names.length
    ? new RegExp(`(?<!\\w)(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?!\\w)`, "g")
    : null;
  return namePattern;
}

/** ADE's own copy as a recording shows it: anything that could be the person's content starred out. */
export function scrubSessionReplayText(text: string): string {
  let output = scrubFreeText(text);
  for (const pattern of CONTENT_SHAPES) output = output.replace(pattern, stars);
  let names: RegExp | null = null;
  try {
    names = knownNamePattern();
  } catch {
    // The stores are not readable: the shape rules above still ran.
  }
  return names ? output.replace(names, stars) : output;
}

/**
 * rrweb's text mask. `maskTextSelector: "*"` matches every element, so rrweb
 * hands every text node (snapshot and mutation) to this function with its
 * parent element; no text reaches a payload without passing through it.
 */
export function maskSessionReplayText(text: string, element?: Element | null): string {
  if (!text.trim() || !inUnmaskedRegion(element)) return maskAll(text);
  return scrubSessionReplayText(text);
}

export function maskSessionReplayAttribute(name: string, value: string, element?: Element | null): string {
  const key = name.toLowerCase();
  if (key.startsWith("rr_")) return value;
  if (UNMASKED_TEXT_ATTRIBUTES.has(key)) {
    return inUnmaskedRegion(element) ? scrubSessionReplayText(value) : "*".repeat(value.length);
  }
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
      // `*` sends every text node through `maskTextFn`, which shows only
      // text inside a `data-ph-unmask` region, scrubbed.
      maskTextSelector: "*",
      maskTextFn: (text, element) => maskSessionReplayText(text, element),
      maskInputOptions: { password: true },
      blockSelector: SESSION_REPLAY_BLOCK_SELECTOR,
      maskAttributeFn: (name, value, element) => maskSessionReplayAttribute(name, value, element),
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
      // The same build labels the product events carry, so recordings filter
      // by version and beta vs stable. Internal installs never record.
      properties.surface = "desktop";
      properties.client = "desktop";
      properties.app_version = config.appVersion;
      properties.release_channel = config.releaseChannel;
      properties.is_internal = false;
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
      // The slim build takes its replay extension here. `__extensionClasses`
      // is not in posthog-js's public config type, hence the cast below.
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
    } catch (error) {
      // posthog-js failed to load or start: no replay this launch.
      client = null;
      captureError(error, { fingerprint: ["session-replay", "start"] });
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
  // Sign-in, sign-out and an account switch change the distinct id; switch
  // the recording now rather than at the next focus or 60-second check.
  subscribeAccountStatus(() => void syncSessionReplay());
  void syncSessionReplay();
}
