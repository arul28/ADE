/**
 * The service worker that serves plugin page frames in the hosted web client.
 *
 * It is a pass-through over Cache Storage and nothing more, on purpose. Every
 * policy this tier has — which media types exist, what the guest's
 * Content-Security-Policy says, which bytes a plugin is allowed to ship — is
 * decided in `pageAssets.ts` and `pageDocument.ts` and STORED with the response,
 * so this file cannot hold a second opinion about any of it. A worker that
 * built its own headers would be a second MIME table to keep in step with the
 * first, and the two would disagree the first time either changed.
 *
 * Plain JavaScript, and referenced with `?url` rather than bundled, because a
 * worker script must be a real same-origin file at a stable path: it may only
 * control the directory it was served from and below. Deriving the scope from
 * `self.location` means the guest URL space is inside it on every deployment
 * the client has — the hashed `/assets/` path a production build emits and the
 * source path the dev server serves alike — with no `Service-Worker-Allowed`
 * header to keep in step and nothing to configure.
 *
 * It intercepts NOTHING outside that space. The app's own navigations, assets
 * and API calls fall straight through to the network, so installing this does
 * not make the client offline-capable and does not change what a reload does.
 */

/* eslint-env serviceworker */

const BASE = new URL("./plugin-pages/", self.location.href).href;

self.addEventListener("install", () => {
  // Take over immediately. A frame cannot open until this worker is active, so
  // waiting for the old one to be released would mean a plugin tab that draws
  // nothing until the reader reloads the whole client.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (url.lastIndexOf(BASE, 0) !== 0) return;
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;
      // A miss is a request for a build this client no longer holds — the page
      // was rebuilt and the old cache deleted while a frame was still open.
      // Answered as a 404 rather than passed to the network, where the origin's
      // single-page fallback would hand the frame the whole ADE client.
      return new Response("Not found", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    }),
  );
});
