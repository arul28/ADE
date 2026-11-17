import { authenticate, type CallerTokenEnv } from "./callerToken";
import { fail, json } from "./cloud/http";
import { trustedHttpsOrigin } from "./trustedOrigin";

/**
 * `GET /releases/latest`: the newest published ADE build on each track.
 *
 * "Update & restart" for another machine needs to know which build is newest
 * on that machine's own track. A desktop reads both tracks' release manifests
 * itself (`latestByTrack.ts`); the phone and ADE Web ask here, so every client
 * gets one answer and a browser never reads GitHub's release downloads, which
 * send no CORS headers.
 *
 * Takes the account bearer like every directory route (phone, web, brain).
 * CORS is the directory's rule: only the hosted web client's exact origin.
 * The answer is public release data, so it is cached for everyone at the edge
 * and a failed manifest read keeps the last value that track had.
 */

export const LATEST_RELEASES_PATH = "/releases/latest";

export type LatestReleasesEnv = CallerTokenEnv & { WEB_CLIENT_ORIGIN?: string };

/** `{ stable, beta }`: a version per track, or null when that track could not be read. */
export type LatestReleasesResponse = {
  stable: string | null;
  beta: string | null;
  checkedAt: string;
};

const STABLE_MANIFEST_URL = "https://github.com/arul28/ADE/releases/latest/download/release-manifest.json";
const BETA_MANIFEST_URL = "https://github.com/arul28/ADE/releases/download/beta-feed/beta.json";
/** How long one read serves every caller. */
const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

let cached: { value: LatestReleasesResponse; atMs: number } | null = null;
let reading: Promise<LatestReleasesResponse> | null = null;

export function isLatestReleasesRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === LATEST_RELEASES_PATH;
}

/** A manifest's version, the shape `parseReleaseManifest` accepts; null for anything else. */
export function manifestVersion(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).version;
  const version = typeof raw === "string" ? raw.trim().replace(/^v/i, "") : "";
  return VERSION_PATTERN.test(version) ? version : null;
}

async function readManifest(url: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return manifestVersion(await response.json());
  } catch {
    return null;
  }
}

/** Both tracks, from the cache when it is fresh. A track that fails keeps its last value. */
export async function readLatestReleases(
  nowMs: number = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<LatestReleasesResponse> {
  if (cached && nowMs - cached.atMs < CACHE_TTL_MS) return cached.value;
  reading ??= (async () => {
    const [stable, beta] = await Promise.all([
      readManifest(STABLE_MANIFEST_URL, fetcher),
      readManifest(BETA_MANIFEST_URL, fetcher),
    ]);
    const value: LatestReleasesResponse = {
      stable: stable ?? cached?.value.stable ?? null,
      beta: beta ?? cached?.value.beta ?? null,
      checkedAt: new Date(nowMs).toISOString(),
    };
    cached = { value, atMs: nowMs };
    return value;
  })().finally(() => {
    reading = null;
  });
  return await reading;
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

  const response = json(await readLatestReleases());
  if (!corsOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", corsOrigin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
