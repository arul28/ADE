export const DEFAULT_RELEASE_NOTES_BASE_URL = "https://www.ade-app.dev";
export const DEFAULT_RELEASE_REPOSITORY = "nsxdavid/ADE";

function parseVersion(version: string): {
  core: number[];
  prerelease: string[];
} {
  const withoutBuild = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const [coreText = "", prereleaseText = ""] = withoutBuild.split("-", 2);
  return {
    core: coreText.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease: prereleaseText ? prereleaseText.split(".") : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
}

export function compareUpdateVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const coreLength = Math.max(leftVersion.core.length, rightVersion.core.length, 3);
  for (let index = 0; index < coreLength; index += 1) {
    const delta = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (delta !== 0) return delta;
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;
  const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart == null && rightPart == null) return 0;
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    const delta = comparePrereleaseIdentifier(leftPart, rightPart);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function buildReleaseNotesUrl(
  version: string,
  baseUrl = DEFAULT_RELEASE_NOTES_BASE_URL,
): string | null {
  const normalizedVersion = version.trim().replace(/^v/i, "");
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedVersion || !normalizedBaseUrl) return null;
  return `${normalizedBaseUrl}/docs/changelog/${encodeURIComponent(`v${normalizedVersion}`)}`;
}

// Deterministic GitHub release page for a version tag in the same repository
// that electron-builder targets for packaged updates.
export function buildGithubReleaseUrl(
  version: string,
  repository = DEFAULT_RELEASE_REPOSITORY,
): string | null {
  const normalizedVersion = version.trim().replace(/^v/i, "");
  const normalizedRepository = repository.trim().replace(/^\/+|\/+$/g, "");
  if (
    !normalizedVersion
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepository)
  ) return null;
  return `https://github.com/${normalizedRepository}/releases/tag/${encodeURIComponent(`v${normalizedVersion}`)}`;
}
