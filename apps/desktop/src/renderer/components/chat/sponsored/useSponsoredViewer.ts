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

/**
 * ADE Free Models run only while someone has the chat open in ADE: the
 * account server serves a chat's requests while its viewer record (this
 * report, `/cloud/free-models/seen`) is at most 10 minutes old. Sent at once
 * when the chat opens, then every 4 minutes, only while the window and the
 * pane are visible and the account said yes to the sheet. Account level, by
 * chat id: no pin, so it is the same for a chat on any machine.
 */
const FREE_MODEL_SEEN_EVERY_MS = 4 * 60_000;
/** A send first reports a look this old, so its first request is not refused as unwatched. */
const FREE_MODEL_SEEN_BEFORE_SEND_MS = 8 * 60_000;
/** How long a send waits for that report before it goes anyway (the server then decides). */
const FREE_MODEL_SEEN_SEND_WAIT_MS = 3_000;
const FREE_MODEL_SEEN_LIMIT = 200;
/** When the server last took a look at each chat, as the time the report left. */
const freeModelSeenAt = new Map<string, number>();
const freeModelSeenSending = new Map<string, Promise<boolean>>();

function reportFreeModelChatSeen(chatId: string): Promise<boolean> {
  const sending = freeModelSeenSending.get(chatId);
  if (sending) return sending;
  const send = window.ade?.cloud?.freeModelsSeen;
  if (!send) return Promise.resolve(false);
  const sentAt = Date.now();
  const report = send({ chatId, device: sponsoredDevice() })
    .then((delivered) => {
      if (delivered !== true) return false;
      freeModelSeenAt.delete(chatId);
      freeModelSeenAt.set(chatId, sentAt);
      if (freeModelSeenAt.size > FREE_MODEL_SEEN_LIMIT) freeModelSeenAt.delete(freeModelSeenAt.keys().next().value as string);
      return true;
    }, () => false)
    .finally(() => freeModelSeenSending.delete(chatId));
  freeModelSeenSending.set(chatId, report);
  return report;
}

/** Reports that this ADE Free Models chat is on screen, while `enabled` (the pane is visible). */
export function useFreeModelViewer(chatId: string | null, enabled: boolean): void {
  const visible = useDocumentVisible();
  const consent = useCloudAccount(Boolean(chatId) && enabled)?.freeModels?.consent ?? null;
  useEffect(() => {
    if (!chatId || !enabled || !visible || consent !== "granted") return;
    const tell = () => {
      if (Date.now() - (freeModelSeenAt.get(chatId) ?? 0) < FREE_MODEL_SEEN_EVERY_MS) return;
      void reportFreeModelChatSeen(chatId);
    };
    tell();
    const timer = window.setInterval(tell, FREE_MODEL_SEEN_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [chatId, enabled, visible, consent]);
}

/**
 * Right before a send in an ADE Free Models chat (a new chat's first message
 * too, under the id it is created with): reports the look first when the last
 * one is old or missing, waiting at most a few seconds. Never throws.
 */
export async function noteFreeModelChatSend(chatId: string): Promise<void> {
  if (Date.now() - (freeModelSeenAt.get(chatId) ?? 0) < FREE_MODEL_SEEN_BEFORE_SEND_MS) return;
  let timer: number | null = null;
  await Promise.race([
    reportFreeModelChatSeen(chatId),
    new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, FREE_MODEL_SEEN_SEND_WAIT_MS);
    }),
  ]).catch(() => undefined);
  if (timer != null) window.clearTimeout(timer);
}
