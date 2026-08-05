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
 *
 * Deliberately analytics-free: docs/logging.md pins the public site to direct
 * browser-to-PostHog capture with zero Vercel-side analytics compute, and the
 * install dialog already records the click that produced this request.
 */

import {
  RELEASES_LATEST_PAGE,
  SCRIPT_CACHE_CONTROL,
  FALLBACK_CACHE_CONTROL,
  installScript,
  pickQuery,
  rejectDisallowedMethod,
  sendRedirect,
  stableAssetUrl,
  type VercelReq,
  type VercelRes,
} from "./releaseAssets";

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (rejectDisallowedMethod(req, res)) return;

  const entry = installScript(pickQuery(req.query.script));

  const location = entry ? stableAssetUrl(entry.asset) : RELEASES_LATEST_PAGE;
  const cacheControl = entry ? SCRIPT_CACHE_CONTROL : FALLBACK_CACHE_CONTROL;

  sendRedirect(res, location, cacheControl);
}
