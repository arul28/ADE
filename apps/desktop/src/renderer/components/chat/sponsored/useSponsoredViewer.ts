import { useEffect, useSyncExternalStore } from "react";
import { useCloudAccount } from "../../../state/cloudAccountStore";
import { sponsoredDevice } from "./sponsoredTurn";

/**
 * Tells the account server a person has a chat or terminal of this ADE Cloud
 * computer on screen (`/cloud/sponsored/seen`): the Index answers an agent
 * there only while someone watches, with that person's address and device.
 * At most once per computer every few minutes, only while the window is
 * visible, and at once when the account's answer changes; the server keeps
 * it only for a Free account whose yes holds where the person is now. Sent
 * until the person says no, also while the account reads as unanswered: a
 * yes that doesn't hold here (California, Global Privacy Control) reads as
 * unanswered, and this look is what clears the earlier one on the server.
 */
const SEEN_EVERY_MS = 4 * 60_000;
const lastSeenAt = new Map<string, number>();

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => false);
}

export function useSponsoredViewer(instanceId: string | null, enabled: boolean): void {
  const visible = useDocumentVisible();
  // A no deletes the account's viewer rows on the server: the next yes reports at once.
  const consent = useCloudAccount(Boolean(instanceId))?.sponsored?.consent ?? null;
  useEffect(() => {
    if (consent !== "granted") lastSeenAt.clear();
  }, [consent]);
  useEffect(() => {
    if (!instanceId || !enabled || !visible) return;
    const tell = () => {
      if (Date.now() - (lastSeenAt.get(instanceId) ?? 0) < SEEN_EVERY_MS) return;
      lastSeenAt.set(instanceId, Date.now());
      void window.ade?.cloud?.sponsoredSeen?.({ instanceId, device: sponsoredDevice() });
    };
    tell();
    const timer = window.setInterval(tell, SEEN_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [instanceId, enabled, visible, consent]);
}
