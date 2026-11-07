/**
 * Whether this build reports to Sentry and PostHog as the release it says it is.
 *
 * `app.isPackaged` is true for any packaged app, including one built on a
 * laptop with `npm run dist`, and such a build carries the source version
 * (`1.0.0-beta.1`), so it read as a Beta in every dashboard. Only the release
 * workflows set `ADE_RELEASE_BUILD=1` (`.github/workflows/release-core.yml`),
 * which `tsup.config.ts` bakes in here; an Alpha package is a release of its
 * own channel. Everything else is `development`: Sentry stays off (unless
 * `ADE_SENTRY_DEV=1`), PostHog's `release_channel` is `development`, and no
 * automatic diagnostic report is sent.
 */
declare const __ADE_RELEASE_BUILD__: boolean | undefined;

export function isReleaseBuild(): boolean {
  return typeof __ADE_RELEASE_BUILD__ === "boolean" && __ADE_RELEASE_BUILD__;
}

/** What the telemetry gates take as `packaged`: a packaged app from a release build. */
export function reportsAsPackagedRelease(isPackaged: boolean): boolean {
  return isPackaged && isReleaseBuild();
}
