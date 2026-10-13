/**
 * `DO_NOT_TRACK=1` in the environment is the install-wide opt-out for ADE's
 * background telemetry: PostHog product analytics and automatic diagnostic
 * reports. The desktop main process and the brain read it through this one
 * function, so they cannot disagree about it.
 *
 * Only the value `1` counts, matching `ADE_DISABLE_PRODUCT_ANALYTICS=1` and the
 * other kill switches. It is read on each call rather than cached, so a process
 * started with it set is honored from its first capture.
 *
 * A person pressing "Send a report" is not covered: that is an explicit request
 * for help, not a background send.
 */
export function doNotTrackRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DO_NOT_TRACK === "1";
}
