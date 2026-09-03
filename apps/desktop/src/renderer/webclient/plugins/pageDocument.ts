/**
 * The document a plugin page's frame actually loads.
 *
 * It is NOT the plugin's `index.html`. It is a host-authored bootstrap the
 * service worker answers with, and the plugin's own document is drawn inside it
 * from bytes that arrive over `postMessage`. That indirection buys the one
 * property the whole tier rests on, and it is worth stating why no simpler
 * arrangement reaches it.
 *
 * **The frame must have an opaque origin.** Same-origin with the app means the
 * page can read `parent.document`, the account session in `localStorage` and
 * every replicated row in IndexedDB. So it is sandboxed.
 *
 * **A sandboxed frame cannot be given a document any other way.**
 *
 * - `srcdoc` and a parent-made `blob:` URL both INHERIT the app's own CSP
 *   (they are local schemes, so they take the creator's policy container). The
 *   app's policy is `script-src 'self'`, under which an opaque frame can run
 *   nothing at all: `'self'` matches no origin the frame has, and inline is not
 *   allowed. Loosening the app's policy to admit a plugin's scripts would be
 *   widening the whole client's policy to suit its guests.
 * - Pointing the frame at a real path and letting the network serve it does not
 *   work either: the bytes are in this browser, not on the origin server, and a
 *   frame with `sandbox` on the ELEMENT is never controlled by a service worker
 *   (a worker is matched by the client's storage key, and an opaque origin has
 *   none — w3c/ServiceWorker#648).
 *
 * What is left, and what this file builds: a real HTTP response, synthesized by
 * the service worker, whose own `Content-Security-Policy` carries `sandbox
 * allow-scripts`. The frame element itself is not sandboxed, so the NAVIGATION
 * is controlled and the worker answers it; the response's policy then makes the
 * resulting document opaque and gives it a policy of our choosing rather than
 * the app's. The bootstrap is inline under a nonce this response mints, because
 * an opaque document cannot fetch a script from anywhere — including from the
 * worker that just served its document.
 */

import { pluginPageGuestSource } from "./pageBridgeGuest";
import type { PluginPageGuestConfig } from "./pageProtocol";

/**
 * The guest document's policy. `PLUGIN_WEBVIEW_CSP` with `'self'` read as
 * `blob:`, which is what "the plugin's own files" means in this transport.
 *
 * The clauses that differ from desktop, and why:
 *
 * - `sandbox allow-scripts` — the whole reason this is a header. Scripts and
 *   nothing else: no same-origin, no forms, no popups, no top-level navigation.
 * - `script-src 'nonce-…' blob:` — the nonce admits exactly the bootstrap this
 *   file writes; `blob:` admits the plugin's own modules, which are blobs the
 *   guest minted from bytes checked against the manifest's `sha256`. It is a
 *   real widening over the desktop's `'self'`: a page can also mint a blob from
 *   a string it built and import it, which `'self'` would refuse. The trade is
 *   the transport's, not a choice — and a plugin page is code the reader
 *   installed, running with no origin, no storage and no DOM but its own.
 * - `frame-src 'none'` — a guest may not nest another frame, so the opaque
 *   origin cannot be laundered into a fresh one.
 */
export function pluginPageGuestCsp(scriptNonce: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}' blob:`,
    "style-src 'unsafe-inline' blob:",
    "img-src blob: data: https:",
    "media-src blob: https:",
    "font-src blob: data:",
    "connect-src https: blob:",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src blob:",
  ].join("; ");
}

/** `<`-escaped, so a config value cannot close the script block it rides in. */
function escapeForScript(value: string): string {
  return value.replace(/</g, "\\u003c");
}

/**
 * The bootstrap document as text.
 *
 * Deliberately spare: a title the reader never sees, a meta viewport so a page
 * on a phone-width column measures itself correctly, a transparent background so
 * the plugin paints the whole frame, and the loader.
 */
export function buildPluginPageDocument(input: {
  config: PluginPageGuestConfig;
  scriptNonce: string;
}): string {
  const source = escapeForScript(pluginPageGuestSource(input.config));
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Plugin page</title>",
    "<style>html,body{margin:0;padding:0;background:transparent;color-scheme:dark light}</style>",
    `<script nonce="${input.scriptNonce}">${source}</script>`,
    "</head><body></body></html>",
  ].join("");
}

/**
 * The response the service worker hands the frame.
 *
 * Built HERE rather than in the worker, and then parked in the same Cache
 * Storage the page's files live in, so the worker stays a pass-through. Every
 * policy decision in this tier — the CSP, the MIME table, the nonce — is then
 * in one typed, tested place, and the worker cannot hold a second opinion about
 * any of them.
 */
export function buildPluginPageDocumentResponse(input: {
  config: PluginPageGuestConfig;
  scriptNonce: string;
}): Response {
  return new Response(buildPluginPageDocument(input), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": pluginPageGuestCsp(input.scriptNonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
