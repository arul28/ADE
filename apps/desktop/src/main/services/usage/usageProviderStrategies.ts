import type {
  ExtraUsage,
  UsageProvider,
  UsageProviderErrorKind,
  UsageProviderMessage,
  UsageProviderSource,
  UsageSnapshot,
  UsageWindow,
} from "../../../shared/types";

export type UsageRefreshReason = "automatic" | "remote" | "user";

export type UsageProviderPollContext = {
  reason: UsageRefreshReason;
  /** Last published snapshot, used to retain facts for a preserved account. */
  previousSnapshot?: UsageSnapshot;
};

export type FreshUsageProviderPollResult = {
  disposition?: "fresh";
  windows: UsageWindow[];
  /** Provider-level Codex spend control state, not tied to an individual quota window. */
  spendControlReached?: boolean;
  source?: UsageProviderSource;
  errors: string[];
  errorKind?: UsageProviderErrorKind;
  retryAfterMs?: number;
  extraUsage?: ExtraUsage | null;
  dailyUsage7d?: number[];
  providerMessages?: UsageProviderMessage[];
  /** Identity learned while reading quota. The tracker stamps it onto the account row. */
  accountEmail?: string;
  accountPlan?: string;
};

type PreserveUsageProviderPollResult = {
  /** The non-interactive caller could not authoritatively check this provider. */
  disposition: "preserve_previous";
  windows: [];
  errors: [];
  source?: UsageProviderSource;
  spendControlReached?: never;
  errorKind?: never;
  retryAfterMs?: never;
  extraUsage?: never;
  dailyUsage7d?: never;
  providerMessages?: never;
  accountEmail?: never;
  accountPlan?: never;
};

type AbsentUsageProviderPollResult = {
  /**
   * No local credential. The provider is not an error and must not publish a
   * status row — the header chip appears only once a sign-in exists.
   */
  disposition: "not_signed_in";
  windows: [];
  errors: [];
  source?: never;
  spendControlReached?: never;
  errorKind?: never;
  retryAfterMs?: never;
  extraUsage?: never;
  dailyUsage7d?: never;
  providerMessages?: never;
  accountEmail?: never;
  accountPlan?: never;
};

export type UsageProviderPollResult =
  | FreshUsageProviderPollResult
  | PreserveUsageProviderPollResult
  | AbsentUsageProviderPollResult;

/**
 * Boundary between the quota scheduler and provider-specific auth/fallback
 * behavior. Historical ledger scanners intentionally do not implement this
 * interface: quota refresh must remain independent from corpus size.
 */
export type UsageProviderStrategy = {
  provider: UsageProvider;
  poll(context: UsageProviderPollContext): Promise<UsageProviderPollResult>;
};
