import { useEffect, useSyncExternalStore } from "react";
import {
  CLOUD_PLAN_LABELS,
  CLOUD_PLAN_RANK,
  cloudCatalogOf,
  cloudPlanFactsOf,
  cloudPlanIdOf,
  formatCloudDate,
  formatCloudGb,
  formatCloudHours,
  type CloudAccountState,
  type CloudPlanId,
} from "../../../../shared/adeCloud";

/**
 * "You're on Plus": the moment a purchase or a move up lands. The account
 * flips to a higher paid plan while ADE is open, or ADE opens for the first
 * time since the checkout. It is said once per account, plan and period:
 * a toast app-wide (`CloudPlanMomentToast`), and on the ADE Cloud page a
 * banner and a one-time highlight of the new plan's card.
 *
 * What this computer last saw of the account is kept in localStorage, per
 * account (its invite code, the one id the account state carries): the plan,
 * the period it was in and the plan's hours left then. A computer that never
 * saw the account seeds it quietly, so an update to this version never
 * celebrates a plan bought long ago. Moves down, cancels and a failed payment
 * update the record and say nothing here (their own notices do).
 */

export const CLOUD_PLAN_SEEN_STORAGE_KEY = "ade.cloud.planSeen.v1";

/** The toast's id: the in-app "Move to Pro" answer and the moment replace each other in place. */
export const CLOUD_PLAN_MOMENT_TOAST_ID = "cloud-plan-moment";

export type CloudPlanSeen = {
  planId: CloudPlanId;
  periodStart: number;
  /** The plan's own hours left when last seen (earned hours aside). */
  leftMilli: number;
  /** `<plan>:<periodStart>` of the last moment shown, so it never shows twice. */
  celebrated?: string;
};

export type CloudPlanMoment = {
  key: string;
  planId: Exclude<CloudPlanId, "free">;
  label: string;
  includedMilli: number;
  diskGb: number;
  renewsAt: number;
  /** Free hours left before the upgrade that the new plan's fresh period replaced; null when none were. */
  replacedFreeMilli: number | null;
};

/** "Your 79.1 unused free hours were replaced by Plus's 300." when the upgrade replaced free hours; null otherwise. */
export function cloudPlanReplacedSentence(moment: CloudPlanMoment): string | null {
  return moment.replacedFreeMilli != null
    ? `Your ${formatCloudHours(moment.replacedFreeMilli)} unused free hours were replaced by ${moment.label}'s ${formatCloudHours(moment.includedMilli)}.`
    : null;
}

/** "You're on Plus" and the one line under it, for the page's banner (the toast puts the facts in its body). */
export function cloudPlanMomentWords(moment: CloudPlanMoment): { title: string; detail: string } {
  const replaced = cloudPlanReplacedSentence(moment);
  return {
    title: `You're on ${moment.label}`,
    detail: `${formatCloudHours(moment.includedMilli)} hours and ${formatCloudGb(moment.diskGb)} of disk a month. Renews ${formatCloudDate(moment.renewsAt)}.${replaced ? ` ${replaced}` : ""}`,
  };
}

/**
 * What this computer should record now, and the moment to show if the plan
 * just went up. Pure: the caller reads and writes the record.
 */
export function nextCloudPlanSeen(previous: CloudPlanSeen | null, account: CloudAccountState): { seen: CloudPlanSeen; moment: CloudPlanMoment | null } {
  const planId = cloudPlanIdOf(account);
  const periodStart = account.billing.periodStart;
  const key = `${planId}:${periodStart}`;
  const seen: CloudPlanSeen = { planId, periodStart, leftMilli: Math.max(0, account.hours.leftMilli), ...(previous?.celebrated ? { celebrated: previous.celebrated } : {}) };
  // Paid and in good standing: a failed payment (free rules) is never a moment.
  const landed = planId !== "free" && account.plan === "paid" && account.rules === "paid";
  if (!previous || !landed || previous.celebrated === key || CLOUD_PLAN_RANK[planId] <= CLOUD_PLAN_RANK[previous.planId]) {
    return { seen, moment: null };
  }
  const facts = cloudPlanFactsOf(account, cloudCatalogOf(account));
  // From Free, the checkout starts a fresh period: the free hours left then are gone.
  const replaced = previous.planId === "free" && previous.periodStart !== periodStart && previous.leftMilli > 0 ? previous.leftMilli : null;
  return {
    seen: { ...seen, celebrated: key },
    moment: {
      key,
      planId,
      label: CLOUD_PLAN_LABELS[planId],
      // The period's own numbers when the server sent them (an older period keeps its terms), else the plan's.
      includedMilli: account.hours.includedMilli > 0 ? account.hours.includedMilli : facts.includedMilli,
      diskGb: account.disk.limitGb ?? facts.diskGb,
      renewsAt: account.billing.periodEnd,
      replacedFreeMilli: replaced,
    },
  };
}

function readSeen(accountKey: string): CloudPlanSeen | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(CLOUD_PLAN_SEEN_STORAGE_KEY) ?? "{}") as Record<string, CloudPlanSeen>;
    const entry = all?.[accountKey];
    return entry && typeof entry.planId === "string" && typeof entry.periodStart === "number" ? entry : null;
  } catch (error) {
    // Storage off or unreadable: this computer has seen nothing, so it seeds (never celebrates).
    console.warn("[ade-cloud] plan record unreadable", error);
    return null;
  }
}

function writeSeen(accountKey: string, seen: CloudPlanSeen): boolean {
  try {
    const all = JSON.parse(window.localStorage.getItem(CLOUD_PLAN_SEEN_STORAGE_KEY) ?? "{}") as Record<string, CloudPlanSeen>;
    window.localStorage.setItem(CLOUD_PLAN_SEEN_STORAGE_KEY, JSON.stringify({ ...(all && typeof all === "object" ? all : {}), [accountKey]: seen }));
    return true;
  } catch (error) {
    console.warn("[ade-cloud] plan record not saved", error);
    return false;
  }
}

/**
 * The account's key for the record: its invite code, the one id the state
 * carries. Without one the record falls back to a shared "account" key,
 * which another account on this computer could have written: such a record is
 * kept up to date but never celebrates (`canCelebrate` false).
 */
export function cloudPlanSeenKey(account: CloudAccountState): { key: string; canCelebrate: boolean } {
  const code = account.referral?.code;
  return code ? { key: code, canCelebrate: true } : { key: "account", canCelebrate: false };
}

/* The moment shown this session: the toast fires once; the page reads it for its banner and highlight. */
let current: CloudPlanMoment | null = null;
const listeners = new Set<() => void>();
const publish = (next: CloudPlanMoment | null) => {
  current = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => current;

/** The moment this session is showing, for the ADE Cloud page; null when none. */
export function useCloudPlanMomentState(): CloudPlanMoment | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** The page's banner was dismissed (or the plan changed again): the highlight goes too. */
export function dismissCloudPlanMoment(): void {
  publish(null);
}

/**
 * Watches the account (`useCloudAccount`, app-wide) and calls `onMoment` once
 * when a plan lands. Writes the record only after the moment is published,
 * and only when storage works: with storage off nothing is ever celebrated,
 * so a reload can't repeat it.
 */
export function useCloudPlanMoment(account: CloudAccountState | null, onMoment: (moment: CloudPlanMoment) => void): void {
  const seenKey = account ? cloudPlanSeenKey(account) : null;
  const accountKey = seenKey?.key ?? null;
  const canCelebrate = seenKey?.canCelebrate ?? false;
  const planId = account ? cloudPlanIdOf(account) : null;
  const periodStart = account?.billing.periodStart ?? null;
  const rules = account?.rules ?? null;
  const leftMilli = account?.hours.leftMilli ?? null;
  useEffect(() => {
    if (!account || !accountKey) return;
    const previous = readSeen(accountKey);
    const { seen, moment } = nextCloudPlanSeen(previous, account);
    if (!writeSeen(accountKey, seen)) return;
    if (moment && canCelebrate) {
      publish(moment);
      onMoment(moment);
    } else if (current && current.planId !== planId) {
      publish(null);
    }
    // Keyed on what the record holds, not the account object (re-read every few minutes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, canCelebrate, planId, periodStart, rules, leftMilli]);
}
