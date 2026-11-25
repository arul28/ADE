import { useEffect, useSyncExternalStore } from "react";
import type { CloudSponsoredConsent } from "../../../../shared/adeCloud";
import { refreshCloudAccount, useCloudAccount } from "../../../state/cloudAccountStore";
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
/** The answer the last report was throttled under: a change reports at once, a new pane doesn't. */
let lastConsent: CloudSponsoredConsent | null | undefined;
/** The account was read again after a look that may have ended a lapse (`smallNeedsLook`): once per lapse. */
let lookRefreshed = false;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => false);
}

export function useSponsoredViewer(instanceId: string | null, enabled: boolean): void {
  const visible = useDocumentVisible();
  // A new answer reports at once: a no deleted the account's viewer rows on the server, and a
  // yes makes the look count for the Index (the one sent while unanswered was dropped).
  const sponsored = useCloudAccount(Boolean(instanceId))?.sponsored;
  const consent = sponsored?.consent ?? null;
  // A yes whose US looks lapsed: this look may make Small free again, so the account is read once after it.
  const needsLook = sponsored?.smallNeedsLook === true;
  useEffect(() => {
    if (lastConsent !== undefined && lastConsent !== consent) lastSeenAt.clear();
    lastConsent = consent;
  }, [consent]);
  useEffect(() => {
    if (!needsLook) lookRefreshed = false;
  }, [needsLook]);
  useEffect(() => {
    if (!instanceId || !enabled || !visible) return;
    const tell = () => {
      if (Date.now() - (lastSeenAt.get(instanceId) ?? 0) < SEEN_EVERY_MS) return;
      lastSeenAt.set(instanceId, Date.now());
      const seen = window.ade?.cloud?.sponsoredSeen?.({ instanceId, device: sponsoredDevice() });
      if (needsLook && !lookRefreshed) {
        lookRefreshed = true;
        void Promise.resolve(seen).then(refreshCloudAccount, () => { lookRefreshed = false; });
      }
    };
    tell();
    const timer = window.setInterval(tell, SEEN_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [instanceId, enabled, visible, consent, needsLook]);
}
