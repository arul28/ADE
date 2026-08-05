/**
 * Vercel serverless function behind /download/*.
 *
 *   /download/mac-arm64      → latest ADE-<version>-arm64.dmg
 *   /download/mac-x64        → latest ADE-<version>-x64.dmg
 *   /download/windows        → latest ADE-<version>-win-x64.exe
 *   /download/brain/<target> → latest ade-<target> standalone brain binary
 *
 * The desktop installers carry the version in their filename, so there is no
 * stable GitHub URL for them and the latest release has to be resolved through
 * the API. The brain binaries are stable-named, so they skip the API entirely.
 *
 * Everything degrades to the releases page rather than to an error: someone
 * hitting this route is trying to download ADE, and a page full of assets is a
 * far better answer than a 500.
 */

import {
  REDIRECT_CACHE_CONTROL,
  fallbackRedirect,
  fetchLatestRelease,
  parseDownloadRequest,
  pickQuery,
  rejectDisallowedMethod,
  resolveStableRedirect,
  resolveVersionedRedirect,
  sendRedirect,
  type ResolvedRedirect,
  type VercelQuery,
  type VercelReq,
  type VercelRes,
} from "./releaseAssets";

function flatQuery(query: VercelQuery): Record<string, string | undefined> {
  return {
    kind: pickQuery(query.kind),
    slug: pickQuery(query.slug),
    target: pickQuery(query.target),
    script: pickQuery(query.script),
  };
}

// Deliberately analytics-free: docs/logging.md pins the public site to direct
// browser-to-PostHog capture with zero Vercel-side analytics compute, and the
// install dialog already records the click that produced this request.
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (rejectDisallowedMethod(req, res)) return;

  const request = parseDownloadRequest(flatQuery(req.query));

  let redirect: ResolvedRedirect;
  if (!request) {
    redirect = fallbackRedirect();
  } else if (request.kind === "brain") {
    redirect = resolveStableRedirect(request.asset, REDIRECT_CACHE_CONTROL);
  } else if (request.kind === "app") {
    redirect = await resolveVersionedRedirect(request.target, fetchLatestRelease);
  } else {
    // /install.sh and /install.ps1 have their own entry point; a script request
    // arriving here means a stale or hand-written URL.
    redirect = fallbackRedirect();
  }

  sendRedirect(res, redirect.location, redirect.cacheControl);
}
