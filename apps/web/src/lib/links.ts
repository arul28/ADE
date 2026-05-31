const DEFAULT_REPO = "arul28/ADE";

const repo =
  (import.meta.env.VITE_ADE_GITHUB_REPO as string | undefined) ?? DEFAULT_REPO;

export const LINKS = {
  repo,
  github: `https://github.com/${repo}`,
  releases: `https://github.com/${repo}/releases/latest`,
  docs: "https://ade-app.dev/docs",
  changelogLatest: "https://ade-app.dev/docs/changelog/v1.1.12",
  prd: `https://github.com/${repo}/blob/main/docs/PRD.md`,
} as const;
