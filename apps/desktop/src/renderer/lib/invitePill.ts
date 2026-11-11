import { useSyncExternalStore } from "react";
import { cloudReferralOf, type CloudAccountState } from "../../shared/adeCloud";
import { isWebClientMode } from "./webClientMode";

/**
 * The desktop "Invite friends, get free cloud hours" pill and the invite
 * analytics. Its own schedule, apart from the star pill's:
 * - it shows only after the person has used ADE Cloud (a computer exists, or
 *   hours were used), while referrer rewards are left;
 * - a dismissal hides it for the next 40 sent messages;
 * - the third dismissal is final.
 *
 * The prefs are this computer's (localStorage). Each counter only moves one
 * way, so a stale copy can never bring a dismissed pill back early.
 */

export const INVITE_PILL_SNOOZE_MESSAGES = 40;
export const INVITE_PILL_MAX_DISMISSALS = 3;
const STORAGE_KEY = "ade.invitePill.v1";
const DAY_MS = 24 * 60 * 60_000;

export type InvitePillPrefs = {
  messagesSent: number;
  dismissCount: number;
  /** Showings already reported as `invite_pill_shown` (once per showing). */
  shownReported: number;
  snoozedUntilMessageCount: number | null;
};

const DEFAULT_PREFS: InvitePillPrefs = { messagesSent: 0, dismissCount: 0, shownReported: 0, snoozedUntilMessageCount: null };

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

function normalize(value: unknown): InvitePillPrefs {
  if (!value || typeof value !== "object") return { ...DEFAULT_PREFS };
  const raw = value as Record<string, unknown>;
  return {
    messagesSent: count(raw.messagesSent),
    dismissCount: Math.min(INVITE_PILL_MAX_DISMISSALS, count(raw.dismissCount)),
    shownReported: Math.min(INVITE_PILL_MAX_DISMISSALS, count(raw.shownReported)),
    snoozedUntilMessageCount: typeof raw.snoozedUntilMessageCount === "number" ? count(raw.snoozedUntilMessageCount) : null,
  };
}

function load(): InvitePillPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let prefs: InvitePillPrefs | null = null;
const listeners = new Set<() => void>();

function current(): InvitePillPrefs {
  prefs ??= typeof window === "undefined" ? { ...DEFAULT_PREFS } : load();
  return prefs;
}

export function updateInvitePill(next: (prev: InvitePillPrefs) => InvitePillPrefs): void {
  prefs = normalize(next(current()));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage off: the pill keeps its state for this session only.
  }
  for (const listener of listeners) listener();
}

export function useInvitePillPrefs(): InvitePillPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    current,
  );
}

/** The person has used ADE Cloud: a computer exists now, or hours were used this month. */
export function usedAdeCloud(account: CloudAccountState): boolean {
  return account.computers.total > 0 || account.hours.usedMilli > 0;
}

export function isInvitePillVisible(prefs: InvitePillPrefs, account: CloudAccountState | null): boolean {
  if (!account || !usedAdeCloud(account)) return false;
  const referral = cloudReferralOf(account);
  if (!referral || referral.rewardsLeft <= 0) return false;
  if (prefs.dismissCount >= INVITE_PILL_MAX_DISMISSALS) return false;
  return prefs.snoozedUntilMessageCount == null || prefs.messagesSent >= prefs.snoozedUntilMessageCount;
}

export function invitePillShowing(prefs: InvitePillPrefs): "prompt_first" | "prompt_second" | "prompt_third" {
  return prefs.dismissCount === 0 ? "prompt_first" : prefs.dismissCount === 1 ? "prompt_second" : "prompt_third";
}

/** A chat message was sent from this desktop: counts only while it can still bring the pill back. */
export function recordInvitePillMessageSent(): void {
  if (typeof window === "undefined" || isWebClientMode()) return;
  const now = current();
  if (now.dismissCount >= INVITE_PILL_MAX_DISMISSALS || now.snoozedUntilMessageCount == null) return;
  if (now.messagesSent >= now.snoozedUntilMessageCount) return;
  updateInvitePill((prev) => ({ ...prev, messagesSent: prev.messagesSent + 1 }));
}

export type InviteAnalyticsFact = {
  action: "invite_pill_shown" | "invite_pill_clicked" | "invite_pill_dismissed" | "invite_link_copied" | "invite_code_entered";
  outcome: string;
};

/**
 * The invite funnel (`ade_feature_used`, feature `cloud_invite`). Never a
 * code, a link, an email or the friend. A day's dedupe per action and
 * outcome keeps it to a handful of events.
 */
export function captureInviteAnalytics(fact: InviteAnalyticsFact): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "cloud_invite", ...fact, source: "renderer_route" },
      dedupeKey: `${fact.action}:${fact.outcome}`,
      minimumIntervalMs: fact.action === "invite_code_entered" ? 0 : DAY_MS,
    }).catch(() => undefined);
  } catch {
    // Analytics never changes what the page does.
  }
}
