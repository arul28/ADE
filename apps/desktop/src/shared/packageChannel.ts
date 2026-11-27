import { BRAND } from "./brand";
import { updateTrackOfVersion } from "./updateTrack";

/**
 * The package channel a build was made for.
 *
 * `stable` is the absence of a channel: main.ts only ever sets
 * `ADE_PACKAGE_CHANNEL` for Alpha packages (see `applyPackagedChannelDefaults`),
 * so anything that does not normalize to alpha is stable. The renderer wants a
 * total value rather than `channel | null`, so the shared type spells stable
 * out.
 *
 * Beta is not a channel. It is an update track of the normal install, read
 * from the version (`updateTrack.ts`).
 */
export type AppPackageChannel = "stable" | "alpha";

/**
 * Which build this is, as analytics and error reports name it: `development`
 * for an unpackaged build, `alpha` for an Alpha package, else the update track
 * the version belongs to (`beta` or `stable`). PostHog's `release_channel` and
 * Sentry's `release_channel` tag and environment all read it from here.
 */
export type ReleaseChannel = "stable" | "beta" | "alpha" | "development";

export function resolveReleaseChannel(args: {
  env: Record<string, string | undefined>;
  packaged: boolean;
  version?: string | null;
}): ReleaseChannel {
  if (!args.packaged) return "development";
  if (normalizeAppPackageChannel(args.env.ADE_PACKAGE_CHANNEL) === "alpha") return "alpha";
  return updateTrackOfVersion(args.version);
}

/** Prefix used to hand the channel to the preload over `additionalArguments`. */
export const PACKAGE_CHANNEL_ARGV_PREFIX = "--ade-package-channel=";

export function normalizeAppPackageChannel(value: unknown): AppPackageChannel {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "alpha" ? normalized : "stable";
}

/**
 * Resolve the channel inside the renderer/preload process.
 *
 * Two sources, in order:
 *  1. `--ade-package-channel=<channel>` in argv, which main.ts injects through
 *     `webPreferences.additionalArguments`. Deterministic — it is set at window
 *     creation, after `applyPackagedChannelDefaults()` has run.
 *  2. `ADE_PACKAGE_CHANNEL` in the inherited environment, as a fallback for
 *     renderer processes that were not created by ADE's own window factory.
 *
 * Both missing means stable, which is the common case and costs nothing.
 */
export function resolvePackageChannelFromProcess(source: {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
}): AppPackageChannel {
  const argv = source.argv ?? [];
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    if (!arg.startsWith(PACKAGE_CHANNEL_ARGV_PREFIX)) continue;
    return normalizeAppPackageChannel(arg.slice(PACKAGE_CHANNEL_ARGV_PREFIX.length));
  }
  return normalizeAppPackageChannel(source.env?.ADE_PACKAGE_CHANNEL);
}

/** Display only: install folders, app bundles and IDs keep their ADE names. */
const PACKAGE_CHANNEL_DISPLAY_NAMES: Record<AppPackageChannel, string> = {
  stable: BRAND.NAME,
  alpha: `${BRAND.NAME} Alpha`,
};

/** "Daex" or "Daex Alpha". */
export function appPackageChannelDisplayName(channel: AppPackageChannel): string {
  return PACKAGE_CHANNEL_DISPLAY_NAMES[channel];
}

/**
 * The name a person sees for an installed app name (`ADE_DESKTOP_APP_NAME`):
 * `ADE.app` keeps its file name but macOS, dialogs and copy list it as Daex.
 * "ADE", "ADE Beta" and "ADE Alpha" map to the Daex names; any other
 * (custom) name is shown as it is.
 */
export function installedDesktopAppDisplayName(installedName: string): string {
  return installedName.replace(/^ADE(?=$| (?:Alpha|Beta)$)/, BRAND.NAME);
}

/**
 * The suffix a host adds to the machine name it publishes: " · Alpha", or ""
 * for stable. Row labels remove the same suffix when they show the install,
 * so both sides read it from here.
 */
export function packageChannelNameSuffix(channel: AppPackageChannel): string {
  return channel === "alpha" ? " · Alpha" : "";
}
