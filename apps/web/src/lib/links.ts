const DEFAULT_REPO = "arul28/ADE";

const repo =
  (import.meta.env.VITE_ADE_GITHUB_REPO as string | undefined) ?? DEFAULT_REPO;

export const LINKS = {
  repo,
  github: `https://github.com/${repo}`,
  releases: `https://github.com/${repo}/releases`,
  releasesLatest: `https://github.com/${repo}/releases/latest`,
  testflight: "https://testflight.apple.com/join/ZSdJGKPy",
  webClient: "https://app.ade-app.dev",
  docs: "https://ade-app.dev/docs",

  // Same-origin endpoints backed by apps/web/api/download.ts. Desktop
  // installers carry the version in their filename, so the function resolves
  // the latest release server-side and 302s to the real asset; on any failure
  // it falls back to the releases page. Never hardcode a versioned asset URL
  // here — it goes stale the moment a release ships.
  downloadMacArm64: "/download/mac-arm64",
  downloadMacX64: "/download/mac-x64",
  downloadWindows: "/download/windows",
} as const;
