import {
  normalizeAppPackageChannel,
  type AppPackageChannel,
} from "../../shared/packageChannel";

/**
 * Release channel of this build, read from the synchronous preload bridge.
 *
 * Deliberately a function rather than a module-scope const: the preload bridge
 * has to exist before it is read (same rule as `rendererRuntimeTarget()`).
 * Missing bridge means stable, so a stable build never pays for the channel
 * badge, the early-build notice, or an IPC round trip to learn it is stable.
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
  return channel === "alpha" ? "ALPHA" : channel === "beta" ? "BETA" : "STABLE";
}

/**
 * Renderer-local event that re-opens the early-build notice. The badge lives in
 * the shell header and the notice is mounted at the app root, so they talk
 * through the window like the other cross-surface renderer signals
 * (`ADE_OPEN_DEEPLINK_EVENT` and friends in lib/openExternal.ts).
 */
export const ADE_OPEN_CHANNEL_NOTICE_EVENT = "ade:open-channel-notice";

export function requestChannelNotice(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(ADE_OPEN_CHANNEL_NOTICE_EVENT));
  } catch {
    /* no-op */
  }
}
