/**
 * The DAEX GitHub App on GitHub ("DAEX for GitHub"). Main, renderer, shared
 * code and the account server read the slug and install page from here; iOS
 * mirrors them in `Brand.githubAppSlug`.
 *
 * GitHub derives the slug from the app's name, so renaming "ADE for GitHub" to
 * "DAEX for GitHub" changed it. The app id and client id did not change.
 */
export const GITHUB_APP_SLUG = "daex-for-github";

/**
 * Slugs the app had before. GitHub keeps them on installations, bot comments
 * and check runs made before the rename, so anything that recognizes the
 * app's own work accepts these too.
 */
export const GITHUB_APP_LEGACY_SLUGS: readonly string[] = ["ade-for-github"];

/** Every slug the app has had, current first. */
export const GITHUB_APP_SLUGS: readonly string[] = [GITHUB_APP_SLUG, ...GITHUB_APP_LEGACY_SLUGS];

export const GITHUB_APP_INSTALL_URL = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;
