/**
 * What an account row says, computed away from React.
 *
 * The Accounts panel joins two payloads that were built by different services
 * and can disagree: the machine-local instance registry (who is signed in
 * where) and the usage snapshot (how much quota each account has left). The
 * join key is `UsageAccount.instanceId`, never the email — two logins can share
 * an email, and a login whose email cannot be read still has quota. Keeping the
 * join here means the panel renders a row for an instance the snapshot has
 * never heard of instead of dropping it.
 */
import type { ProviderInstance, ProviderInstanceProvider } from "../../../../../shared/types/providerInstances";
import type { UsageSnapshot } from "../../../../../shared/types";

/**
 * Eight accents that stay legible on both themes and do not collide with the
 * status vocabulary (no red, no green — those already mean something here).
 * Deliberately a fixed list rather than a generated ramp: the point is telling
 * two accounts apart at a glance, which needs hue separation, not coverage.
 */
export const ACCOUNT_ACCENT_SWATCHES: readonly string[] = [
  "#d97757",
  "#2dd4bf",
  "#5b93f5",
  "#a78bfa",
  "#e0a82e",
  "#a3e635",
  "#f472b6",
  "#93a6c4",
];

/** The mini usage line's two numbers. Either half can be missing. */
export type AccountUsagePercents = {
  fiveHourPercent: number | null;
  weeklyPercent: number | null;
};

/**
 * The usage account this instance's readings came from.
 *
 * `instanceId` is the additive field; a host that predates provider accounts
 * omits it entirely, and on such a host the provider has exactly one identity,
 * so the single account for that provider IS the default instance's account.
 * That fallback is what keeps the numbers on screen during a version skew
 * instead of blanking the row.
 */
function usageAccountFor(
  snapshot: UsageSnapshot | null,
  provider: ProviderInstanceProvider,
  instance: ProviderInstance,
): { id: string } | null {
  const accounts = snapshot?.accounts ?? [];
  const matched = accounts.find(
    (account) => account.provider === provider && account.instanceId === instance.id,
  );
  if (matched) return matched;
  if (!instance.isDefault) return null;
  const forProvider = accounts.filter((account) => account.provider === provider);
  const unattributed = forProvider.filter((account) => !account.instanceId);
  return unattributed.length === 1 ? unattributed[0]! : null;
}

/**
 * `5h NN% · wk NN%` for one instance.
 *
 * A window with no `accountId` belongs to the provider's only account, which is
 * how every host before account attribution reported — so it is claimed by the
 * default instance and by nobody else.
 */
export function accountUsagePercents(
  snapshot: UsageSnapshot | null,
  provider: ProviderInstanceProvider,
  instance: ProviderInstance,
): AccountUsagePercents {
  const account = usageAccountFor(snapshot, provider, instance);
  const windows = (snapshot?.windows ?? []).filter((window) => {
    if (window.provider !== provider) return false;
    if (window.accountId) return window.accountId === account?.id;
    return instance.isDefault;
  });
  const pick = (type: "five_hour" | "weekly"): number | null => {
    const found = windows.find((window) => window.windowType === type);
    return found ? Math.round(found.percentUsed) : null;
  };
  return { fiveHourPercent: pick("five_hour"), weeklyPercent: pick("weekly") };
}

export function formatAccountUsage(percents: AccountUsagePercents): string | null {
  // Headroom, like the top-bar chip and the usage popup ("19% left"). The
  // snapshot carries consumption, so the row converts once here and every
  // usage surface reads the same way.
  const left = (used: number) => Math.max(0, Math.round(100 - used));
  const parts: string[] = [];
  if (percents.fiveHourPercent != null) parts.push(`5h ${left(percents.fiveHourPercent)}%`);
  if (percents.weeklyPercent != null) parts.push(`wk ${left(percents.weeklyPercent)}%`);
  return parts.length ? `${parts.join(" · ")} left` : null;
}

/**
 * True when this provider reports a five-hour window at all.
 *
 * The auto-start toggle is about that window specifically, so a provider (or a
 * plan) with no five-hour window must not be offered a control that could never
 * do anything — an inert switch is a promise the product does not keep.
 */
export function providerHasFiveHourWindow(
  snapshot: UsageSnapshot | null,
  provider: ProviderInstanceProvider,
): boolean {
  return (snapshot?.windows ?? []).some(
    (window) => window.provider === provider && window.windowType === "five_hour",
  );
}

/** `email · plan`, whichever halves exist, or the not-signed-in sentence. */
export function accountIdentityLine(instance: ProviderInstance): string {
  if (!instance.signedIn) return "Not signed in";
  const parts = [instance.account?.email, instance.account?.plan].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length ? parts.join(" · ") : "Signed in";
}

/** The dot's colour: the account's own accent, else the provider's brand. */
export function accountAccent(instance: ProviderInstance, providerBrand: string): string {
  return instance.accentColor ?? providerBrand;
}

/** A soft tint of an accent, the same `color-mix` treatment `AlertBanner` uses. */
export function accentTint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}
