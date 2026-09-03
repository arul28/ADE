/**
 * Registering the plugin page worker, and deciding whether this client may
 * offer plugin pages at all.
 *
 * The registration is deliberately lazy: nothing is installed until the reader
 * opens a surface that draws a plugin page. A worker registered at boot would
 * be a worker on every reader's origin — visible in devtools, listed in site
 * settings, one more thing to explain — bought for a tier most sessions never
 * touch.
 *
 * Its scope is the directory the script itself was served from, which is why
 * the guest URL space is derived from the script URL rather than written as a
 * literal. See `pluginPageServiceWorker.js`.
 */

import { isWebClientMode } from "../../lib/webClientMode";
import { pluginPageBaseUrl } from "./pageAssets";
import type { WebPluginPageFile, WebPluginPageManifest } from "../adapter/plugins";

// `?worker&url`, and the suffix is load-bearing. A service worker script must
// be a real, separate file at a same-origin path, because the path is what
// bounds the scope it may control — and this is the only suffix that produces
// one. Measured against this repo's Vite: `?url` and `new URL(…,
// import.meta.url)` both BUNDLE a `.js` file into the importing chunk, so the
// URL they hand back is the app's own entry script, and registering that as a
// worker would run the ADE client in a worker scope. `?worker&url` emits
// `/assets/pluginPageServiceWorker-<hash>.js` and answers with its URL.
import pluginPageServiceWorkerUrl from "./pluginPageServiceWorker.js?worker&url";

/** The two page-asset members a host must serve for this tier to work. */
type PageAssetBridge = {
  pageAssetsManifest?: (input: { pluginId: string }) => Promise<WebPluginPageManifest | null>;
  pageAssetsRead?: (input: { pluginId: string; path: string }) => Promise<WebPluginPageFile | null>;
};

function pageAssetBridge(): PageAssetBridge | null {
  if (typeof window === "undefined") return null;
  const ade = (window as unknown as { ade?: Record<string, unknown> }).ade;
  return ((ade?.plugin ?? ade?.plugins) as PageAssetBridge | null | undefined) ?? null;
}

/**
 * Whether this renderer can host a plugin page.
 *
 * The web-client counterpart of `supportsPluginWebviews()`, and it answers the
 * same product question rather than probing for an element. Four ways it is no,
 * and each is a real state a reader reaches:
 *
 * - Not the web client at all (the desktop's own host answers there).
 * - No service worker or no Cache Storage — a private window in some browsers,
 *   and any insecure origin.
 * - The connected host does not serve the page assets, which is every ADE
 *   before this tier shipped.
 *
 * Synchronous, because the caller is a render path deciding between a page and
 * the surface's fallback panel, and an answer that arrived a tick later would
 * show the fallback and then replace it.
 */
export function supportsWebPluginPages(): boolean {
  if (!isWebClientMode()) return false;
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (!("serviceWorker" in navigator)) return false;
  if (typeof caches === "undefined") return false;
  const bridge = pageAssetBridge();
  return typeof bridge?.pageAssetsManifest === "function" && typeof bridge?.pageAssetsRead === "function";
}

let registration: Promise<{ base: string }> | null = null;

/**
 * The active worker and the URL space it controls.
 *
 * Awaited before a frame is created, never in parallel with it: a frame opened
 * while the worker is still installing navigates to a path nothing answers, and
 * the origin's single-page fallback would hand it the whole ADE client inside an
 * iframe. `registration.active` is the gate, and it is why this resolves rather
 * than returning a base immediately.
 */
export function ensurePluginPageServiceWorker(): Promise<{ base: string }> {
  if (registration) return registration;
  registration = (async () => {
    const scriptUrl = new URL(pluginPageServiceWorkerUrl, window.location.href).toString();
    const base = pluginPageBaseUrl(scriptUrl);
    const active = await navigator.serviceWorker.register(scriptUrl, { scope: base });
    await navigator.serviceWorker.ready.catch(() => undefined);
    if (!active.active) {
      await new Promise<void>((resolve, reject) => {
        const worker = active.installing ?? active.waiting;
        if (!worker) {
          reject(new Error("The plugin page worker didn’t start."));
          return;
        }
        const onState = (): void => {
          if (worker.state === "activated") {
            worker.removeEventListener("statechange", onState);
            resolve();
          } else if (worker.state === "redundant") {
            worker.removeEventListener("statechange", onState);
            reject(new Error("The plugin page worker didn’t start."));
          }
        };
        worker.addEventListener("statechange", onState);
      });
    }
    return { base };
  })().catch((error: unknown) => {
    // A failed registration must not poison every later attempt: a reader who
    // was offline, or in a window that had storage blocked, gets a fresh try
    // the next time they open a plugin surface.
    registration = null;
    throw error;
  });
  return registration;
}

/** Test seam: forget the memoized registration. */
export function resetPluginPageServiceWorkerForTests(): void {
  registration = null;
}
