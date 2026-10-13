/**
 * `DO_NOT_TRACK=1` in the environment is the install-wide opt-out for ADE's
 * background telemetry: PostHog product analytics and automatic diagnostic
 * reports. The desktop main process and the brain read it through this one
 * function, so they cannot disagree about it.
 *
 * `1`, `true` and `yes` count (any case). Sentry reads the same function, so
 * no value can turn one kind of telemetry off and leave another on. It is read
 * on each call rather than cached, so a process started with it set is honored
 * from its first capture.
 *
 * A person pressing "Send a report" is not covered: that is an explicit request
 * for help, not a background send.
 */
export function doNotTrackRequested(env: Record<string, string | undefined> = process.env): boolean {
  return isTruthyEnvFlag(env.DO_NOT_TRACK);
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
