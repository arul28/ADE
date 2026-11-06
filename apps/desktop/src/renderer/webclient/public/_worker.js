/**
 * Cloudflare Pages worker for the web client's hashed files. `_routes.json`
 * sends it `/assets/*` only; every other path stays static, with `_headers`
 * and the SPA fallback in `_redirects`.
 *
 * A deploy removes the old build's chunks. Without this worker, the SPA
 * fallback answers a removed chunk with index.html, as 200 and with the
 * year-long immutable cache of `/assets/*`. Safari then fails on the MIME type
 * (ADE-WEB-6), and a browser can keep that HTML for the chunk's URL even after
 * a rollback brings the file back. This worker answers it with a 404 that is
 * never cached.
 *
 * Pages documents `_headers` for static responses, not for a worker's, so
 * the worker sets the headers that `/assets/*` needs itself.
 */

const ASSET_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
};

/** The answer for one `/assets/*` request, from the static file Pages found. */
function assetResponse(response) {
  const type = response.headers.get("Content-Type") ?? "";
  // A 304 for a cached file is not a miss: only a 404 or the fallback page is.
  if (response.status === 404 || (response.ok && type.startsWith("text/html"))) {
    return new Response("Not found\n", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  // A 304 or a redirect goes back as it came; only a file gets the cache.
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ASSET_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    try {
      return assetResponse(response);
    } catch {
      // Fail open: the static answer, as Pages gave it before this worker.
      // (`passThroughOnException` is a Pages Functions call, not advanced mode.)
      return response;
    }
  },
};
