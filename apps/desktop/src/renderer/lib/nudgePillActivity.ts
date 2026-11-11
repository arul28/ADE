import { rootAppStoreApi } from "../state/appStore";
import { recordInvitePillMessageSent } from "./invitePill";
import { starPillCountsMessages } from "./starPill";
import { isWebClientMode } from "./webClientMode";

/**
 * The user sent a chat message from this desktop app: every sidebar nudge
 * counts it while the count can still change it. The star pill's prefs are in
 * the root store (account-synced), the invite pill's in this computer's
 * storage. Nothing in the browser web client, which shows neither pill.
 */
export function recordNudgeMessageSent(): void {
  if (typeof window === "undefined" || isWebClientMode()) return;
  const state = rootAppStoreApi.getState();
  if (starPillCountsMessages(state.starPill)) {
    state.updateStarPill((prev) => ({ ...prev, messagesSent: prev.messagesSent + 1 }));
  }
  recordInvitePillMessageSent();
}
