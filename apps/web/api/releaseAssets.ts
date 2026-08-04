/**
 * Pure resolution logic shared by the download endpoints. Kept free of any
 * request/response types so it can be unit tested directly (see
 * releaseAssets.test.ts).
 *
 * Two shapes of release asset exist, and they need different handling:
 *
 *   Stable-named  — install.sh, install.ps1, SHA256SUMS, ade-<target>. Their
 *                   filenames never change, so GitHub's own
 *                   /releases/latest/download/<name> URL always works and we
 *                   never touch the API.
 *   Versioned     — ADE-<version>-arm64.dmg, ADE-<version>-x64.dmg,
 *                   ADE-<version>-win-x64.exe. The version is in the filename,
 *                   so the latest release must be resolved through the API.
 */

export const RELEASE_REPO = "arul28/ADE";
export const RELEASES_LATEST_PAGE = `https://github.com/${RELEASE_REPO}/releases/latest`;
export const RELEASES_LATEST_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

export function stableAssetUrl(assetName: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/latest/download/${assetName}`;
}

/** How long the CDN may serve a resolved redirect. Also what keeps the
 *  unauthenticated GitHub API (60 req/hour/IP) from being the bottleneck. */
export const REDIRECT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";
/** Fallbacks must not be cached — the next request should get a real try. */
export const FALLBACK_CACHE_CONTROL = "public, max-age=0, s-maxage=0, must-revalidate";
/** Install scripts are stable-named, so the redirect target never changes. */
export const SCRIPT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";

export const GITHUB_API_TIMEOUT_MS = 2500;

export type AppTarget = {
  /** Asset filename suffix. Exactly one asset per release matches each. */
  suffix: string;
  platform: string;
  arch: string;
};

/**
 * Desktop app installers, keyed by the URL slug under /download/.
 * Architecture is always the visitor's explicit choice — nothing here sniffs
 * the User-Agent.
 */
export const APP_TARGETS: Readonly<Record<string, AppTarget>> = Object.freeze({
  "mac-arm64": { suffix: "-arm64.dmg", platform: "mac", arch: "arm64" },
  "mac-x64": { suffix: "-x64.dmg", platform: "mac", arch: "x64" },
  windows: { suffix: "-win-x64.exe", platform: "windows", arch: "x64" },
});

/** Standalone brain binaries, keyed by the `<target>` in /download/brain/<target>. */
export const BRAIN_TARGETS: Readonly<Record<string, { asset: string; platform: string; arch: string }>> =
  Object.freeze({
    "darwin-arm64": { asset: "ade-darwin-arm64", platform: "darwin", arch: "arm64" },
    "darwin-x64": { asset: "ade-darwin-x64", platform: "darwin", arch: "x64" },
    "linux-arm64": { asset: "ade-linux-arm64", platform: "linux", arch: "arm64" },
    "linux-x64": { asset: "ade-linux-x64", platform: "linux", arch: "x64" },
    "win32-x64": { asset: "ade-win32-x64.exe", platform: "win32", arch: "x64" },
  });

/** Install scripts, keyed by the `script` param the rewrite supplies. */
export const INSTALL_SCRIPTS: Readonly<Record<string, { asset: string; platform: string }>> =
  Object.freeze({
    sh: { asset: "install.sh", platform: "unix" },
    ps1: { asset: "install.ps1", platform: "windows" },
  });

export type ReleaseAsset = { name?: unknown; browser_download_url?: unknown };

/**
 * Picks the single asset whose name ends with `suffix`.
 *
 * Suffix matching (rather than rebuilding the filename from a version) is what
 * keeps this correct across version-numbering changes, and `.blockmap`
 * sidecars fall out naturally because they end with `.exe.blockmap`.
 */
export function selectAssetUrl(assets: unknown, suffix: string): string | null {
  if (!Array.isArray(assets)) return null;
  for (const asset of assets as ReleaseAsset[]) {
    if (!asset || typeof asset !== "object") continue;
    const { name, browser_download_url: url } = asset;
    if (typeof name !== "string" || !name.endsWith(suffix)) continue;
    if (typeof url !== "string") continue;
    // Only ever hand back a real GitHub release URL, whatever the API said.
    if (!url.startsWith(`https://github.com/${RELEASE_REPO}/releases/download/`)) continue;
    return url;
  }
  return null;
}

export type DownloadRequest =
  | { kind: "app"; slug: string; target: AppTarget }
  | { kind: "brain"; target: string; asset: string; platform: string; arch: string }
  | { kind: "script"; script: string; asset: string; platform: string };

/**
 * Own-property lookup. A bare `table[key]` would resolve visitor-controlled
 * slugs like "constructor" or "__proto__" to Object.prototype members, which
 * are truthy and would sail straight past a `if (entry)` check.
 */
function lookup<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | null {
  if (!key || !Object.prototype.hasOwnProperty.call(table, key)) return null;
  return table[key] ?? null;
}

/**
 * Maps the query the vercel.json rewrites produce onto a descriptor, or null
 * for anything unrecognized (which the handler answers with the releases page
 * rather than an error — an unknown slug is still someone trying to download).
 */
export function parseDownloadRequest(query: Record<string, string | undefined>): DownloadRequest | null {
  const kind = query.kind;
  if (kind === "app") {
    const slug = query.slug;
    const target = lookup(APP_TARGETS, slug);
    return target && slug ? { kind: "app", slug, target } : null;
  }
  if (kind === "brain") {
    const target = query.target;
    const entry = lookup(BRAIN_TARGETS, target);
    return entry && target
      ? { kind: "brain", target, asset: entry.asset, platform: entry.platform, arch: entry.arch }
      : null;
  }
  if (kind === "script") {
    const script = query.script;
    const entry = lookup(INSTALL_SCRIPTS, script);
    return entry && script
      ? { kind: "script", script, asset: entry.asset, platform: entry.platform }
      : null;
  }
  return null;
}

/** Same own-property guard, for the install-script entry point. */
export function installScript(script: string | undefined): { asset: string; platform: string } | null {
  return lookup(INSTALL_SCRIPTS, script);
}

export type ResolvedRedirect = {
  location: string;
  /** False when we fell back to the releases page. */
  resolved: boolean;
  cacheControl: string;
};

/** Stable-named assets resolve without any network call. */
export function resolveStableRedirect(assetName: string, cacheControl: string): ResolvedRedirect {
  return { location: stableAssetUrl(assetName), resolved: true, cacheControl };
}

export function fallbackRedirect(): ResolvedRedirect {
  return {
    location: RELEASES_LATEST_PAGE,
    resolved: false,
    cacheControl: FALLBACK_CACHE_CONTROL,
  };
}

/**
 * Resolves a versioned installer against a release payload. Any failure —
 * fetch error, non-OK status, malformed body, missing asset — degrades to the
 * releases page so a visitor always lands somewhere they can download from.
 */
export async function resolveVersionedRedirect(
  target: AppTarget,
  fetchRelease: () => Promise<unknown>,
): Promise<ResolvedRedirect> {
  let payload: unknown;
  try {
    payload = await fetchRelease();
  } catch {
    return fallbackRedirect();
  }
  const assets = (payload as { assets?: unknown } | null | undefined)?.assets;
  const url = selectAssetUrl(assets, target.suffix);
  if (!url) return fallbackRedirect();
  return { location: url, resolved: true, cacheControl: REDIRECT_CACHE_CONTROL };
}

/** Fetches the latest release JSON, bounded and unauthenticated. */
export async function fetchLatestRelease(): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const response = await fetch(RELEASES_LATEST_API, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "ade-app.dev-download-redirect",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
