import { fetchAdeLatestRelease } from "../../desktop/src/main/services/github/adeReleaseFeed";
import { createLatestByTrackReader } from "../../desktop/src/shared/latestByTrack";
import { authenticate, type CallerTokenEnv } from "./callerToken";
import { fail, json } from "./cloud/http";
import { LATEST_RELEASES_PATH, type LatestReleasesResponse } from "./latestReleasesContract";
import { trustedHttpsOrigin } from "./trustedOrigin";

/**
 * `GET /releases/latest` (`latestReleasesContract.ts`).
 *
 * "Update & restart" for another machine needs the newest build on that
 * machine's own track. A desktop reads both tracks' release manifests itself;
 * the phone and ADE Web ask here, so every client gets the desktop's answer
 * (the same reader, `createLatestByTrackReader`) and a browser never reads
 * GitHub's release downloads, which send no CORS headers.
 *
 * Takes the account bearer like every directory route (phone, web, brain).
 * CORS is the directory's rule: only the hosted web client's exact origin.
 * One read serves this isolate for ten minutes; a failed manifest read keeps
 * the last value that track had.
 */

export type LatestReleasesEnv = CallerTokenEnv & { WEB_CLIENT_ORIGIN?: string };

const READ_INTERVAL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

/** The parsed JSON, `null` for a 404 (a release older than its manifest); throws on other failures. */
async function fetchManifestJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

const reader = createLatestByTrackReader({
  fetchJson: fetchManifestJson,
  // Bounded like the manifests: a hung fallback must not hold every later
  // request on this isolate's one in-flight read.
  fetchStableFallback: async () => (await fetchAdeLatestRelease({
    fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  }))?.version ?? null,
  logger: { warn: (event, data) => console.warn(event, JSON.stringify(data)) },
  minIntervalMs: READ_INTERVAL_MS,
});

export function isLatestReleasesRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === LATEST_RELEASES_PATH;
}

export async function handleLatestReleasesRequest(request: Request, env: LatestReleasesEnv): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin ? allowedOrigin : null;

  if (request.method === "OPTIONS") {
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't read ADE releases.", 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't read ADE releases.", 403);
  if (request.method !== "GET") return fail("bad_request", "That method isn't allowed here.", 405);

  const caller = await authenticate(request, env);
  if (!caller.ok) return fail("unauthorized", "Sign in to ADE to read releases.", 401);

  const latest: LatestReleasesResponse = await reader.refresh();
  const response = json(latest);
  if (!corsOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", corsOrigin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
