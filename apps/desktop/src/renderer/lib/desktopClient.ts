import { isAddressedToClient } from "../../shared/sessionInputOrigin";

/** This desktop's id, or null on a surface that has none (the web client). */
export function getDesktopClientId(): string | null {
  if (typeof window === "undefined") return null;
  // A stand-in (web client) is a function, not an id.
  const id = window.ade?.app?.desktopClientId;
  return typeof id === "string" ? id : null;
}

/**
 * Should this desktop act on a request to show something? A request names the
 * desktop that sent the chat's last message; no name means every desktop.
 */
export function isAddressedToThisDesktop(targetClientId: string | null | undefined): boolean {
  return isAddressedToClient(targetClientId, getDesktopClientId());
}
