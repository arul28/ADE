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
import {
  LIVE_QUOTA_PROVIDERS,
  type AiProviderConnections,
  type UsageAccount,
  type UsageAccountMachine,
  type UsageProvider,
  type UsageProviderStatus,
  type UsageWindow,
} from "../../../shared/types";
import { hasLocalProviderConnectionSignal } from "../../lib/aiProviderStatus";
import { displayPercent, windowLabel } from "./usageWindowFormat";

export type UsageAccountView = {
  id: string;
  provider: UsageProvider;
  email?: string;
  plan?: string;
  /** The account's user-facing name, e.g. "Personal" or "Work". */
  label?: string;
  machines: UsageAccountMachine[];
  url?: string;
  /** Banked reset credits, when the host tracks them. */
  resetCredits?: { availableCount: number; nextExpiresAt?: string };
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
 * screen came from. A local provider account (`instanceId`) is its own login
 * even when it shares an email with another, so it stays keyed by id. Accounts
 * without an email and without an instance cannot be pooled across machines,
 * so they stay distinct by id too.
 */
export function poolAccounts(accounts: UsageAccount[] | undefined): UsageAccountView[] {
  const byKey = new Map<string, UsageAccountView>();
  for (const account of accounts ?? []) {
    const instanceId = account.instanceId?.trim();
    const key = instanceId
      ? account.id
      : account.email
        ? `${account.provider}:${account.email.toLowerCase()}`
        : account.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        id: account.id,
        provider: account.provider,
        ...(account.email ? { email: account.email } : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.label ? { label: account.label } : {}),
        machines: [...account.machines],
        ...(account.url ? { url: account.url } : {}),
        ...(account.resetCredits ? { resetCredits: account.resetCredits } : {}),
        initials: emailInitials(account.email, account.machines[0]?.label),
      });
      continue;
    }
    for (const machine of account.machines) {
      if (existing.machines.some((known) => known.label === machine.label)) continue;
      existing.machines.push(machine);
    }
    if (!existing.plan && account.plan) existing.plan = account.plan;
    if (!existing.label && account.label) existing.label = account.label;
    // Credits belong to the login, not the machine that noticed them, so the
    // first machine to report any is enough.
    if (!existing.resetCredits && account.resetCredits) {
      existing.resetCredits = account.resetCredits;
    }
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

// ── account rows ─────────────────────────────────────────────────

/** 5-hour before Weekly before Monthly; anything else keeps provider order. */
export function orderLimitCards<T extends { label: string }>(cards: T[]): T[] {
  const rank = (label: string) => {
    if (/-min$|-hour$/.test(label)) return 0;
    if (label === "Weekly") return 1;
    if (label === "Monthly") return 2;
    return 3;
  };
  return [...cards].sort((a, b) => rank(a.label) - rank(b.label));
}

/** One window of one account: the card it belongs to, and this account's slice. */
export type AccountWindowCell = { card: LimitCard; segment: LimitSegment };

export type AccountLimitRow = {
  /** Stable per account, so React keys and open/close state agree. */
  key: string;
  provider: UsageProvider;
  /** `null` for a host that reports windows with no account directory. */
  account: UsageAccountView | null;
  /** This account's windows, short one first. */
  cells: AccountWindowCell[];
};

/**
 * Transpose the window cards into one row per ACCOUNT.
 *
 * The popover used to stack one card per window, each with a row of account
 * segments inside it — five rows of chrome for two providers, and the email
 * nowhere. A reader asks "how much has THIS login got left", so the account is
 * the row and its windows sit side by side within it.
 *
 * Built on `buildLimitCards` rather than beside it: the pooled percentages, the
 * per-segment `restoresPercentOfPool`, and the account fallback for hosts that
 * send no `accountId` are all decided there, and a second implementation of
 * that arithmetic is how two surfaces start disagreeing about one number.
 */
export function buildAccountRows(
  provider: UsageProvider,
  windows: UsageWindow[],
  accounts: UsageAccountView[],
  nowMs: number,
): AccountLimitRow[] {
  const cards = orderLimitCards(buildLimitCards(provider, windows, accounts, nowMs));
  const rows = new Map<string, AccountLimitRow>();
  for (const card of cards) {
    for (const segment of card.segments) {
      const key = segment.account?.id ?? `${provider}:this-machine`;
      const row = rows.get(key) ?? { key, provider, account: segment.account, cells: [] };
      row.cells.push({ card, segment });
      rows.set(key, row);
    }
  }
  // A signed-in account with no windows yet is still a row. Omitting it is
  // what made a second login look missing from the usage box until its first
  // reading landed.
  for (const account of accounts) {
    if (account.provider !== provider || rows.has(account.id)) continue;
    rows.set(account.id, { key: account.id, provider, account, cells: [] });
  }
  // Rows follow the account directory, not whichever window the provider
  // happened to list first — otherwise two logins swap places between polls.
  const rank = new Map<string, number>();
  accounts
    .filter((account) => account.provider === provider)
    .forEach((account, index) => rank.set(account.id, index));
  return [...rows.values()].sort(
    (a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER),
  );
}

const CLAUDE_AND_CODEX = ["claude", "codex"] as const;
const EXTRA_QUOTA_PROVIDERS = ["cursor", "copilot", "grok", "opencode"] as const;

export type LiveQuotaVisibility = {
  connections: AiProviderConnections | null | undefined;
  windows?: readonly UsageWindow[];
  statuses?: Partial<Record<UsageProvider, UsageProviderStatus>> | null;
};

function extraQuotaVisible(provider: UsageProvider, input: LiveQuotaVisibility): boolean {
  if (input.windows?.some((window) => window.provider === provider)) return true;
  if (input.statuses?.[provider]) return true;
  // Copilot and Grok sign-in is the settings connection. Cursor's connection
  // flag is an API key, not the IDE plan session, and OpenCode is not on that
  // map — those two appear once a quota reading exists.
  if (provider === "copilot" || provider === "grok") {
    return Boolean(input.connections?.[provider]?.authAvailable);
  }
  return false;
}

/**
 * Limits popover order. Claude and Codex keep the connection-signal rule they
 * already had. The other four join once they are signed in or have a reading.
 * Before connections load, only Claude and Codex are reserved so the popover
 * does not flash empty cards for providers this machine has never authed.
 */
export function quotaPopoverProviders(input: LiveQuotaVisibility): UsageProvider[] {
  if (!input.connections) return [...CLAUDE_AND_CODEX];
  return LIVE_QUOTA_PROVIDERS.filter((provider) => {
    if (provider === "claude" || provider === "codex") {
      return hasLocalProviderConnectionSignal(input.connections?.[provider]);
    }
    return extraQuotaVisible(provider, input);
  });
}

/**
 * Top-bar chips. Claude and Codex stay on the existing connection signal,
 * falling back to windows only when neither connection is present. Each extra
 * provider is its own chip, in the same order as the popover, once authed.
 */
export function headerUsageProviders(input: LiveQuotaVisibility): UsageProvider[] {
  const withWindows = (provider: UsageProvider) =>
    input.windows?.some((window) => window.provider === provider) ?? false;
  let primary: UsageProvider[];
  if (!input.connections) {
    primary = CLAUDE_AND_CODEX.filter(withWindows);
  } else {
    const configured = CLAUDE_AND_CODEX.filter((provider) =>
      hasLocalProviderConnectionSignal(input.connections?.[provider]),
    );
    primary = configured.length > 0 ? configured : CLAUDE_AND_CODEX.filter(withWindows);
  }
  const extras = EXTRA_QUOTA_PROVIDERS.filter((provider) => extraQuotaVisible(provider, input));
  return [...primary, ...extras];
}
