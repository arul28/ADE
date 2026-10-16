import { isAddressedToClient } from "../../shared/sessionInputOrigin";

/** This desktop's id, or null on a surface that has none (the web client). */
export function getDesktopClientId(): string | null {
  return (typeof window !== "undefined" ? window.ade?.app?.desktopClientId : null) ?? null;
}

/**
 * Should this desktop act on a request to show something? A request names the
 * desktop that sent the chat's last message; no name means every desktop.
 */
export function isAddressedToThisDesktop(targetClientId: string | null | undefined): boolean {
  return isAddressedToClient(targetClientId, getDesktopClientId());
}
