/**
 * Vercel serverless function behind /install.sh and /install.ps1 — the two
 * URLs printed in the install dialog's one-liners:
 *
 *   curl -fsSL https://ade-app.dev/install.sh | sh
 *   irm https://ade-app.dev/install.ps1 | iex
 *
 * Both scripts are stable-named release assets, so this never needs the GitHub
 * API — it hands back a 302 to the latest/download URL. `curl -L` follows it
 * and `irm` follows redirects by default, and because the browser/CLI resolves
 * the final hop itself, GitHub supplies the Content-Type. Nothing here proxies
 * script bytes, so a compromised function cannot rewrite what people pipe into
 * a shell.
 */

import {
  RELEASES_LATEST_PAGE,
  SCRIPT_CACHE_CONTROL,
  FALLBACK_CACHE_CONTROL,
  installScript,
  stableAssetUrl,
} from "./releaseAssets.ts";
import {
  MARKETING_DOWNLOAD_REDIRECT_EVENT,
  captureMarketingEvent,
  referrerHost,
} from "./marketingCapture.ts";

type VercelReq = {
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
};

type VercelRes = {
  status: (code: number) => VercelRes;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

function pickQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const entry = installScript(pickQuery(req.query.script));

  const location = entry ? stableAssetUrl(entry.asset) : RELEASES_LATEST_PAGE;
  const cacheControl = entry ? SCRIPT_CACHE_CONTROL : FALLBACK_CACHE_CONTROL;

  await captureMarketingEvent(process.env, MARKETING_DOWNLOAD_REDIRECT_EVENT, {
    action: "redirected",
    artifact_kind: "install_script",
    platform: entry?.platform ?? "unknown",
    arch: "any",
    outcome: entry ? "resolved" : "fallback",
    referrer_host: referrerHost(pickQuery(req.headers.referer)),
  });

  res.setHeader("Location", location);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(302).end(`Redirecting to ${location}`);
}
