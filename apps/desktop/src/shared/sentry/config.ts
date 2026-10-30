/**
 * When Sentry runs, where it sends, and how a build names itself.
 *
 * Sentry is part of ADE: it is on in every packaged build, with no setting and
 * no notice (see `docs/logging.md`, "Error tracking"). It stays off in dev
 * builds and tests so local work never spends the error quota, and it honours
 * `DO_NOT_TRACK=1` and `ADE_SENTRY_DISABLED=1`. `ADE_SENTRY_DEV=1` turns it on
 * in a dev build for testing the wiring, reporting as `development`.
 */
import { doNotTrackRequested, isTruthyEnvFlag } from "../doNotTrack";
import { normalizeAppPackageChannel } from "../packageChannel";
import { updateTrackOfVersion } from "../updateTrack";

/**
 * Public DSNs for the `ade-app` organization. A DSN only lets a client submit
 * events to its project; Sentry documents it as safe to ship in client code.
 * `ADE_SENTRY_DSN` overrides it for local testing.
 */
export const SENTRY_DSNS = {
  desktop: "https://cb232b7868b3bcce488d062996e8f279@o4512249455640576.ingest.us.sentry.io/4512249614827520",
  brain: "https://97686a60023866e706161260a7bfc9f6@o4512249455640576.ingest.us.sentry.io/4512249614893056",
  web: "https://1b022593765a8526315e03d3dea6dc8a@o4512249455640576.ingest.us.sentry.io/4512249614958592",
} as const;

export type SentrySurface = keyof typeof SENTRY_DSNS;

export type SentryEnvironment = "production" | "beta" | "alpha" | "development";

type Env = Record<string, string | undefined>;

function isSentryOptedOut(env: Env): boolean {
  return doNotTrackRequested(env) || isTruthyEnvFlag(env.ADE_SENTRY_DISABLED);
}

function isSentryDevOptIn(env: Env): boolean {
  return isTruthyEnvFlag(env.ADE_SENTRY_DEV);
}

/**
 * Whether this process reports. `packaged` is the build's own answer
 * (`app.isPackaged`, `ADE_RUNTIME_PACKAGED=1` for the brain, a production
 * Vite build for the web client).
 */
export function shouldEnableSentry(args: { env: Env; packaged: boolean; priorOptOut?: boolean }): boolean {
  const { env } = args;
  if (isSentryOptedOut(env) || args.priorOptOut) return false;
  if (env.NODE_ENV === "test" || env.VITEST) return false;
  if (isSentryDevOptIn(env)) return true;
  return args.packaged;
}

export function resolveSentryDsn(surface: SentrySurface, env: Env): string {
  return env.ADE_SENTRY_DSN?.trim() || SENTRY_DSNS[surface];
}

/**
 * `production` for Stable, `beta` for a Beta-track build (read from its
 * version), `alpha` for an Alpha package, `development` otherwise. Beta gets
 * its own environment from its first build, so its errors never read as
 * Stable's (T3 #24340), and promoting a beta can ask "any new issues?".
 */
export function resolveSentryEnvironment(args: {
  env: Env;
  packaged: boolean;
  version?: string | null;
}): SentryEnvironment {
  if (!args.packaged) return "development";
  const channel = normalizeAppPackageChannel(args.env.ADE_PACKAGE_CHANNEL);
  if (channel === "alpha") return "alpha";
  return updateTrackOfVersion(args.version) === "beta" ? "beta" : "production";
}

/** One release name across desktop, brain, web client and Workers. */
export function sentryReleaseName(version: string | null | undefined): string | undefined {
  const trimmed = version?.trim();
  return trimmed ? `ade@${trimmed}` : undefined;
}

/** `win-x64`, `mac-arm64`, `linux-x64`: one release, one dist per build artifact. */
export function sentryDist(platform: string, arch: string): string {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "mac" : platform;
  return `${os}-${arch}`;
}

export const SENTRY_TRACES_SAMPLE_RATE = 0.05;

/**
 * What the SDKs may collect on their own, for every Node and browser process:
 * no user or IP, no cookies, headers, bodies or query strings, and no model
 * inputs or outputs.
 */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
};

/** The `package.channel` tag: `stable`, `beta` or `alpha`. */
export function sentryChannelTag(env: Env): string {
  return normalizeAppPackageChannel(env.ADE_PACKAGE_CHANNEL);
}

/** Handed to renderers through `additionalArguments` when main's Sentry client is running. */
export const SENTRY_ENABLED_ARGV = "--ade-sentry=1";
