/**
 * Host platform as reported by the preload bridge, and ONLY by the bridge.
 *
 * `rendererRuntimeTarget()` falls back to `navigator.platform`, which is right
 * for cosmetic platform styling but wrong here: the hosted web client runs in a
 * browser on someone's Windows machine and is not the Windows desktop build, so
 * it must not claim to be in beta. No bridge means no notice.
 */
function bridgedPlatform(): string {
  if (typeof window === "undefined") return "";
  const bridged = (
    window as { ade?: { app?: { runtimeTarget?: { platform?: unknown } } } }
  ).ade?.app?.runtimeTarget?.platform;
  return typeof bridged === "string" ? bridged : "";
}

/**
 * ADE is generally available on macOS and Linux; the Windows port is the part
 * that is still in beta. The notice is therefore gated on the HOST PLATFORM,
 * never on the release channel — a Windows Stable install shows it, and a macOS
 * alpha/beta dev build does not.
 *
 * Deliberately a function, not a module-scope const: the preload bridge has to
 * exist before it is read (same rule as `rendererRuntimeTarget()`).
 */
export function isWindowsPlatform(platform = bridgedPlatform()): boolean {
  return /^win/i.test(platform);
}

/**
 * Renderer-local event that re-opens the Windows beta notice. The surfaces that
 * can ask for it (the header build chip, Settings → About) live far from the
 * notice, which is mounted at the app root, so they talk through the window like
 * the other cross-surface renderer signals (`ADE_OPEN_DEEPLINK_EVENT` and
 * friends in lib/openExternal.ts).
 */
export const ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT = "ade:open-windows-beta-notice";

export function requestWindowsBetaNotice(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT));
  } catch {
    /* no-op */
  }
}
