import { useEffect, useState } from "react";

export type PlatformHint = "mac" | "windows" | "linux" | "ios" | "unknown";

/**
 * Windows download gate. The Windows installer is not published until the
 * Windows release proof passes, so every surface that offers a Windows
 * artifact has to read this first.
 *
 * DownloadPage.tsx repeats this read on purpose: the Windows release contract
 * test (apps/desktop/scripts/windows-release-contract.test.mjs) pins the gate
 * and its disclosure to that file so a download card can never quietly imply
 * an artifact exists. Keep the two in step.
 */
export const WINDOWS_DOWNLOAD_ENABLED =
  import.meta.env.VITE_ADE_WINDOWS_DOWNLOAD_ENABLED === "1";

export function detectPlatform(): PlatformHint {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  // navigator.platform is deprecated; used only as an iPad-spoof fallback.
  const navigatorPlatform =
    typeof navigator !== "undefined" ? (navigator.platform ?? "").toLowerCase() : "";
  const maxTouchPoints = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0;
  if (/(iphone|ipad|ipod)/.test(ua) || (navigatorPlatform === "macintel" && maxTouchPoints > 1))
    return "ios";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "mac";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

/**
 * Detection runs after mount so the first paint is identical for everyone and
 * never depends on a user agent read during render.
 */
export function usePlatform(): PlatformHint {
  const [platform, setPlatform] = useState<PlatformHint>("unknown");
  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);
  return platform;
}
