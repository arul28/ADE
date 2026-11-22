import { useEffect, useSyncExternalStore } from "react";
import { sponsoredDevice } from "./sponsoredTurn";

/**
 * Tells the account server a person has a chat or terminal of this ADE Cloud
 * computer on screen (`/cloud/sponsored/seen`): the Index answers an agent
 * there only while someone watches, with that person's address and device.
 * At most once per computer every few minutes, only while the window is
 * visible; the server keeps it only for a Free account that said yes.
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
  }, [instanceId, enabled, visible]);
}
