/**
 * Where a vendor-hosted (`file` / `archive`) tool pin may download from, per
 * tool: the pinned URL's host first, then the hosts a redirect may land on.
 * The pin scripts and the manifest generator import this;
 * `src/services/tools/manifest.ts` repeats the same table as
 * `VENDOR_DOWNLOAD_HOSTS` (the TypeScript side cannot import a script), and the
 * downloader refuses anything else. Keep the two identical.
 */
const GITHUB_RELEASE_HOSTS = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];

export const VENDOR_DOWNLOAD_HOSTS = {
  muse: ["lookaside.facebook.com"],
  devin: ["static.devin.ai"],
  antigravity: ["dl.google.com"],
  kimi: GITHUB_RELEASE_HOSTS,
  qwen: GITHUB_RELEASE_HOSTS,
  ffmpeg: GITHUB_RELEASE_HOSTS,
  "cursor-cli": ["downloads.cursor.com"],
  node: ["nodejs.org"],
};

/** Meta's lookaside host, which serves the muse builds. */
export const FILE_PIN_HOST = VENDOR_DOWNLOAD_HOSTS.muse[0];

/** The only host npm-format pins (single tarballs and trees) download from. */
export const NPM_REGISTRY_HOST = "registry.npmjs.org";
