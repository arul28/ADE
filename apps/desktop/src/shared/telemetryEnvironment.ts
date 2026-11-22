/**
 * Who a telemetry event belongs to: a person, a developer, or a machine that
 * is running ADE because a workflow told it to.
 *
 * CI, release smoke, and the cloud template check send nothing. A development
 * build that is explicitly opted in still sends, and marks itself internal.
 * The property names here are the ones PostHog and Sentry filter on.
 */
import { isTruthyEnvFlag } from "./doNotTrack";
import type { ReleaseChannel } from "./packageChannel";

export type TelemetryEnvironment = "production" | "beta" | "alpha" | "development" | "ci";

type Env = Record<string, string | undefined>;

/**
 * A process a workflow started, not a person. `CI` covers the systems that
 * only set that, including GitHub Actions. The cloud template check sets
 * `ADE_TEMPLATE_CHECK` because the computer it boots does not see the
 * workflow's environment.
 */
export function isAutomatedTelemetryEnvironment(env: Env = process.env): boolean {
  if (isTruthyEnvFlag(env.GITHUB_ACTIONS)) return true;
  if (isTruthyEnvFlag(env.GITLAB_CI)) return true;
  if (isTruthyEnvFlag(env.CIRCLECI)) return true;
  if (isTruthyEnvFlag(env.TRAVIS)) return true;
  if (isTruthyEnvFlag(env.BUILDKITE)) return true;
  if (isTruthyEnvFlag(env.TF_BUILD)) return true;
  if (env.JENKINS_URL?.trim()) return true;
  if (isTruthyEnvFlag(env.ADE_TEMPLATE_CHECK)) return true;
  if (isTruthyEnvFlag(env.CI)) return true;
  return false;
}

/** Unpackaged desktop, the dev-launcher brain, or a build that reports as development. */
export function isDevelopmentTelemetryRuntime(args: {
  env?: Env;
  runtimeMode?: string;
  releaseChannel?: ReleaseChannel | "unknown";
}): boolean {
  const env = args.env ?? process.env;
  return env.NODE_ENV === "development"
    || args.runtimeMode === "desktop_development"
    || isTruthyEnvFlag(env.ADE_DEV_BRAIN)
    || args.releaseChannel === "development";
}

/**
 * Sentry's environment and PostHog's `environment` property. Stable is
 * `production`, matching Sentry. An automated process is `ci` even when the
 * build itself is a beta.
 */
export function telemetryEnvironment(args: {
  env?: Env;
  releaseChannel: ReleaseChannel | "unknown";
  runtimeMode?: string;
}): TelemetryEnvironment {
  const env = args.env ?? process.env;
  if (isAutomatedTelemetryEnvironment(env)) return "ci";
  switch (args.releaseChannel) {
    case "beta":
    case "alpha":
    case "development":
      return args.releaseChannel;
    case "stable":
      return "production";
    case "unknown":
      return isDevelopmentTelemetryRuntime({ env, runtimeMode: args.runtimeMode, releaseChannel: args.releaseChannel })
        ? "development"
        : "production";
    default: {
      const unreachable: never = args.releaseChannel;
      return unreachable;
    }
  }
}
