/**
 * usageLimitModel.ts
 *
 * The arithmetic behind the Limits cards, kept out of the components.
 *
 * A limit card is one window of one provider — "5-hour", "Weekly", or a
 * model-specific window the provider reports separately — read as headroom
 * rather than consumption: the number is how much is *left*, and the line under
 * it says how much comes back and when. Each account that reports the window is
 * one segment of the card, so a pooled subscription reads as a row of accounts
 * instead of a stack of identical bars.
 *
 * Everything here is pure and clock-injected (`nowMs`), which is what lets the
 * same numbers be asserted in tests and rendered on three clients.
 */
import type {
  UsageAccount,
  UsageAccountMachine,
  UsageProvider,
  UsageWindow,
} from "../../../shared/types";
import { displayPercent, windowLabel } from "./usageWindowFormat";

export type UsageAccountView = {
  id: string;
  provider: UsageProvider;
  email?: string;
  plan?: string;
  machines: UsageAccountMachine[];
  url?: string;
  /** Two letters for the chip, derived from the email (or the machine). */
  initials: string;
};

/**
 * Two letters for an account chip, from an EMAIL.
 *
 * Not to be confused with `renderer/lib/account.ts`'s `accountInitials`, which
 * monograms the signed-in ADE account's display NAME. Different input,
 * different rule; they were one grep away from looking like one helper.
 *
 * `first.last@host` → FL, `dev@host` → DE, and a bare label falls back to its
 * own first two letters so a machine-only account still gets a stable chip
 * rather than a placeholder glyph.
 */
export function emailInitials(email: string | undefined, fallback = ""): string {
  const local = (email ?? "").split("@")[0] ?? "";
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0]!}${parts[1]![0]!}`.toUpperCase();
  }
  const source = parts[0] ?? fallback.trim();
  if (!source) return "··";
  return source.slice(0, 2).toUpperCase();
}

/**
 * Merge the snapshot's accounts by identity.
 *
 * Two machines polling the same login are one account with two `machines`
 * entries — the freshest reading first, because that is the one the numbers on
 * screen came from. Accounts without an email cannot be pooled across machines
 * (there is nothing to match on), so they stay distinct by id.
 */
export function poolAccounts(accounts: UsageAccount[] | undefined): UsageAccountView[] {
  const byKey = new Map<string, UsageAccountView>();
  for (const account of accounts ?? []) {
    const key = account.email
      ? `${account.provider}:${account.email.toLowerCase()}`
      : account.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        id: account.id,
        provider: account.provider,
        ...(account.email ? { email: account.email } : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        machines: [...account.machines],
        ...(account.url ? { url: account.url } : {}),
        initials: emailInitials(account.email, account.machines[0]?.label),
      });
      continue;
    }
    for (const machine of account.machines) {
      if (existing.machines.some((known) => known.label === machine.label)) continue;
      existing.machines.push(machine);
    }
    if (!existing.plan && account.plan) existing.plan = account.plan;
  }
  for (const account of byKey.values()) {
    account.machines.sort((a, b) => machineFreshness(b) - machineFreshness(a));
  }
  return [...byKey.values()];
}

function machineFreshness(machine: UsageAccountMachine): number {
  const at = machine.checkedAt ? Date.parse(machine.checkedAt) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

/** Headroom, the way the card reads it: 100 − used, clamped. */
export function percentLeft(window: UsageWindow, nowMs: number): number {
  return Math.max(0, Math.min(100, 100 - displayPercent(window, nowMs)));
}

export type LimitSegment = {
  account: UsageAccountView | null;
  window: UsageWindow;
  /** Headroom for this account, 0–100. */
  percentLeft: number;
  /** What resetting this window returns to the card's pooled number. */
  restoresPercentOfPool: number;
  resetsInMs: number;
};

export type LimitCard = {
  provider: UsageProvider;
  /** "5-hour", "Weekly", "Weekly · Opus" — the window, named once. */
  label: string;
  key: string;
  segments: LimitSegment[];
  /** Pooled headroom: the mean across accounts, which is what the card shows. */
  percentLeft: number;
  /** Pooled consumption, for the pressure colour (100 − percentLeft). */
  percentUsed: number;
  /** "+50% in 6d 0h" — the next restore that actually returns something. */
  forecast: { percent: number; resetsInMs: number } | null;
};

/**
 * Group a provider's windows into cards — one per window label — with one
 * segment per account.
 *
 * A host that predates account attribution sends windows with no `accountId`;
 * those fall back to the provider's single account, which is exactly what the
 * machine had when it polled them.
 */
export function buildLimitCards(
  provider: UsageProvider,
  windows: UsageWindow[],
  accounts: UsageAccountView[],
  nowMs: number,
): LimitCard[] {
  const providerAccounts = accounts.filter((account) => account.provider === provider);
  const cards = new Map<string, LimitCard>();
  for (const window of windows) {
    if (window.provider !== provider) continue;
    const label = windowLabel(window);
    const account = providerAccounts.find((candidate) => candidate.id === window.accountId)
      ?? (providerAccounts.length === 1 ? providerAccounts[0]! : null);
    const card = cards.get(label) ?? {
      provider,
      label,
      key: `${provider}:${label}`,
      segments: [],
      percentLeft: 0,
      percentUsed: 0,
      forecast: null,
    };
    card.segments.push({
      account,
      window,
      percentLeft: percentLeft(window, nowMs),
      restoresPercentOfPool: 0,
      resetsInMs: Math.max(0, resetsInMs(window, nowMs)),
    });
    cards.set(label, card);
  }

  for (const card of cards.values()) {
    const count = card.segments.length || 1;
    for (const segment of card.segments) {
      segment.restoresPercentOfPool = (100 - segment.percentLeft) / count;
    }
    card.percentLeft = card.segments.reduce((sum, segment) => sum + segment.percentLeft, 0) / count;
    card.percentUsed = 100 - card.percentLeft;
    card.forecast = nextRestore(card.segments);
  }
  return [...cards.values()];
}

function resetsInMs(window: UsageWindow, nowMs: number): number {
  const at = Date.parse(window.resetsAt);
  if (Number.isFinite(at)) return at - nowMs;
  return window.resetsInMs;
}

/**
 * The next reset that gives something back.
 *
 * A window already at full headroom restores nothing, so "+0% in 5m" is noise;
 * the forecast skips to the first reset that moves the pooled number, and sums
 * the accounts that reset with it.
 */
function nextRestore(segments: LimitSegment[]): LimitCard["forecast"] {
  const restoring = segments.filter((segment) => segment.restoresPercentOfPool >= 0.5);
  if (restoring.length === 0) return null;
  const soonest = restoring.reduce((min, segment) => Math.min(min, segment.resetsInMs), Number.POSITIVE_INFINITY);
  // Same minute counts as the same reset: providers report per-account
  // timestamps that differ by seconds for one shared window.
  const together = restoring.filter((segment) => Math.abs(segment.resetsInMs - soonest) < 60_000);
  const percent = together.reduce((sum, segment) => sum + segment.restoresPercentOfPool, 0);
  return { percent, resetsInMs: soonest };
}
