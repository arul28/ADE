export const DEFAULT_RELEASE_NOTES_BASE_URL = "https://www.ade-app.dev";
export const DEFAULT_RELEASE_REPOSITORY = "arul28/ADE";

// The comparator itself lives in shared/ so the renderer's "is that machine
// behind?" check and the main-process update state machine order versions the
// same way. Re-exported here because every main-process caller imports it from
// this module.
export { compareUpdateVersions } from "../../../shared/updateVersions";

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
