import {
  normalizeAppPackageChannel,
  type AppPackageChannel,
} from "../../shared/packageChannel";
import { normalizeUpdateTrack, type UpdateTrack } from "../../shared/updateTrack";

/**
 * Release channel of this build, read from the synchronous preload bridge.
 *
 * Deliberately a function rather than a module-scope const: the preload bridge
 * has to exist before it is read (same rule as `rendererRuntimeTarget()`).
 * Missing bridge means stable, so a stable build never pays for the channel
 * badge or an IPC round trip to learn it is stable. This is dev-facing only.
 */
export function rendererPackageChannel(): AppPackageChannel {
  if (typeof window === "undefined") return "stable";
  const bridged = (
    window as { ade?: { app?: { packageChannel?: unknown } } }
  ).ade?.app?.packageChannel;
  return normalizeAppPackageChannel(bridged);
}

export function isPrereleaseChannel(
  channel: AppPackageChannel = rendererPackageChannel(),
): boolean {
  return channel !== "stable";
}

export function packageChannelLabel(channel: AppPackageChannel): string {
  return channel === "alpha" ? "ALPHA" : "STABLE";
}

/**
 * The running build's update track, from the synchronous preload bridge.
 * Missing bridge (the web app, tests) means Stable.
 */
export function rendererUpdateTrack(): UpdateTrack {
  if (typeof window === "undefined") return "stable";
  const bridged = (window as { ade?: { app?: { updateTrack?: unknown } } }).ade?.app?.updateTrack;
  return normalizeUpdateTrack(bridged) ?? "stable";
}
