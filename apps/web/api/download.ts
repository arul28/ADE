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
  resolveStableRedirect,
  resolveVersionedRedirect,
  type ResolvedRedirect,
} from "./releaseAssets.ts";
import {
  MARKETING_DOWNLOAD_REDIRECT_EVENT,
  captureMarketingEvent,
  referrerHost,
} from "./marketingCapture.ts";

type VercelQuery = Record<string, string | string[] | undefined>;

type VercelReq = {
  query: VercelQuery;
  headers: Record<string, string | string[] | undefined>;
};

type VercelRes = {
  status: (code: number) => VercelRes;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

function pickQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function flatQuery(query: VercelQuery): Record<string, string | undefined> {
  return {
    kind: pickQuery(query.kind),
    slug: pickQuery(query.slug),
    target: pickQuery(query.target),
    script: pickQuery(query.script),
  };
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const request = parseDownloadRequest(flatQuery(req.query));

  let redirect: ResolvedRedirect;
  let properties: Record<string, string> = {
    action: "redirected",
    artifact_kind: "unknown",
    platform: "unknown",
    arch: "unknown",
  };

  if (!request) {
    redirect = fallbackRedirect();
  } else if (request.kind === "brain") {
    redirect = resolveStableRedirect(request.asset, REDIRECT_CACHE_CONTROL);
    properties = {
      action: "redirected",
      artifact_kind: "brain_binary",
      platform: request.platform,
      arch: request.arch,
    };
  } else if (request.kind === "app") {
    redirect = await resolveVersionedRedirect(request.target, fetchLatestRelease);
    properties = {
      action: "redirected",
      artifact_kind: "app_installer",
      platform: request.target.platform,
      arch: request.target.arch,
    };
  } else {
    // /install.sh and /install.ps1 have their own entry point; a script request
    // arriving here means a stale or hand-written URL.
    redirect = fallbackRedirect();
  }

  await captureMarketingEvent(process.env, MARKETING_DOWNLOAD_REDIRECT_EVENT, {
    ...properties,
    outcome: redirect.resolved ? "resolved" : "fallback",
    referrer_host: referrerHost(pickQuery(req.headers.referer)),
  });

  res.setHeader("Location", redirect.location);
  res.setHeader("Cache-Control", redirect.cacheControl);
  // Don't pass the visitor's page URL on to github.com when the browser
  // follows this hop.
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(302).end(`Redirecting to ${redirect.location}`);
}
